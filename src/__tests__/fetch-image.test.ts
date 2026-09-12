/**
 * 把 BN 那条图 URL 取回来的那一步。
 *
 * 这里钉的三件事全都是**安全闸**,而且每一条都是静默的:
 *
 * 🔴 **只准 http / https**。`ctx.http.file()` 碰到 `file://` 走的是
 * `readFile(fileURLToPath(url))` —— BN(或者拿到了那条 token 的任何人)递一条
 * `file:///…/koishi.yml` 过来,桥就会把宿主机的配置文件当成一张图发进 QQ 群。
 * 这是一个**任意本地文件读取**的口子,而且现场看上去一切正常:发出去了、回执是 ok。
 *
 * 🔴 **要有超时**。BN 只等 30 秒(协议 §5.4),一条没有超时的下载会让主人看到「推送卡着
 * 不动」——比一条明确的失败难查得多。
 *
 * 🔴 **要有上限**。图要整个进内存、再 base64 一遍(涨三分之一),没有上限就是一条
 * 「递一条大文件的 URL 过来即可把 koishi 打爆」的路。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchImage, IMAGE_FETCH_TIMEOUT_MS, MAX_IMAGE_BYTES } from "../fetch-image";

function fakeHttp(over: { data?: ArrayBuffer; type?: string | null } = {}) {
	const calls: Array<{ url: string; options: { timeout: number } }> = [];
	return {
		calls,
		http: {
			async file(url: string, options: { timeout: number }) {
				calls.push({ url, options });
				return {
					data: over.data ?? new ArrayBuffer(8),
					type: "type" in over ? over.type : "image/png",
				};
			},
		},
	};
}

describe("只取 http / https", () => {
	/**
	 * 🔴 这一条漏了就是**任意本地文件读取**:`ctx.http.file("file:///…")` 直接 readFile。
	 * 所以判在**调 `file()` 之前** —— 拦在调用之后的话文件已经读进内存了。
	 */
	it("file:// → 在碰 http.file 之前就拒,并说清是什么协议、哪条地址", async () => {
		const h = fakeHttp();
		await assert.rejects(
			() => fetchImage(h.http, "file:///Users/akokko/koishi.yml"),
			(err: Error) => {
				assert.match(err.message, /file:/, "没说是什么协议");
				assert.match(err.message, /koishi\.yml/, "没说是哪条地址");
				return true;
			},
		);
		assert.equal(h.calls.length, 0, "已经去读磁盘了");
	});

	it("data: 也拒", async () => {
		const h = fakeHttp();
		await assert.rejects(() => fetchImage(h.http, "data:image/png;base64,AAAA"), /data:/);
		assert.equal(h.calls.length, 0);
	});

	/** 压根不是个 URL 的东西也别往 `http.file()` 里送。 */
	it("解析不出来的地址也拒", async () => {
		const h = fakeHttp();
		await assert.rejects(() => fetchImage(h.http, "这不是地址"), /这不是地址/);
		assert.equal(h.calls.length, 0);
	});

	it("https 放行", async () => {
		const h = fakeHttp();
		const out = await fetchImage(h.http, "https://bn.example/ext/bridge/blob/aaaa");
		assert.equal(out.mime, "image/png");
		assert.equal(out.data.byteLength, 8);
		assert.ok(out.data instanceof Uint8Array);
	});
});

describe("超时", () => {
	/** BN 只等 30 秒(协议 §5.4),取图这一步必须**明显短于**那个窗口。 */
	it("带着一个短于 BN 那 30 秒窗口的超时下去", async () => {
		const h = fakeHttp();
		await fetchImage(h.http, "http://bn/ext/bridge/blob/aaaa");
		assert.equal(h.calls[0]?.options.timeout, 20_000);
		assert.equal(IMAGE_FETCH_TIMEOUT_MS, 20_000);
		assert.ok(IMAGE_FETCH_TIMEOUT_MS < 30_000, "比 BN 的回执窗口还长,等于没有超时");
	});
});

describe("上限", () => {
	it("超了上限就抛,并说清多大、上限多少", async () => {
		const h = fakeHttp({ data: new ArrayBuffer(MAX_IMAGE_BYTES + 1) });
		await assert.rejects(
			() => fetchImage(h.http, "http://bn/ext/bridge/blob/big"),
			(err: Error) => {
				assert.match(err.message, new RegExp(String(MAX_IMAGE_BYTES + 1)), "没说这张有多大");
				assert.match(err.message, new RegExp(String(MAX_IMAGE_BYTES)), "没说上限是多少");
				return true;
			},
		);
	});

	it("正好卡在上限上放行", async () => {
		const h = fakeHttp({ data: new ArrayBuffer(MAX_IMAGE_BYTES) });
		const out = await fetchImage(h.http, "http://bn/ext/bridge/blob/edge");
		assert.equal(out.data.byteLength, MAX_IMAGE_BYTES);
	});
});

describe("mime", () => {
	/**
	 * 对头没给 Content-Type 时**回 undefined,别回 null**:渲染那一层拿 `??` 去接帧里声明的
	 * 那个 mime,`null` 会把兜底整条跳过 —— 然后 `h.image(data, null)` 发出去的是已废弃的
	 * `base64://`。
	 */
	it("对头什么都没说 → undefined,不是 null 也不是空串", async () => {
		assert.equal((await fetchImage(fakeHttp({ type: null }).http, "http://bn/x")).mime, undefined);
		assert.equal((await fetchImage(fakeHttp({ type: "" }).http, "http://bn/x")).mime, undefined);
	});
});
