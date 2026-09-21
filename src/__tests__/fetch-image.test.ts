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

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 一段响应体:开头是 `head`,后面补零到 `size` 字节(默认 32 —— 够认魔数)。 */
function body(head: number[] | string, size = 32): ArrayBuffer {
	const bytes = typeof head === "string" ? new TextEncoder().encode(head) : Uint8Array.from(head);
	const out = new Uint8Array(Math.max(size, bytes.length));
	out.set(bytes);
	return out.buffer;
}

/** ISO-BMFF 的开头:盒长 4 字节 + `ftyp` + 品牌。 */
function ftyp(brand: string): string {
	return `\0\0\0\x18ftyp${brand}`;
}

/**
 * 响应体:一块一块给,**要一块才给一块**(`highWaterMark: 0`),并记下被要了几块、有没有
 * 被掐掉 —— 「边读边判、判了就停」要钉的正是这两样。`hang` 为真时给完之后不再说话(也不收尾),
 * 只有 `signal` 被掐时才出错 —— 照 undici 的样子。
 */
function streamOf(
	chunks: readonly Uint8Array[],
	stats: { pulled: number; cancelled: boolean },
	signal: AbortSignal | undefined,
	hang = false,
) {
	let at = 0;
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				signal?.addEventListener("abort", () => controller.error(signal.reason));
			},
			pull(controller) {
				if (at >= chunks.length) {
					if (hang) return new Promise<void>(() => {});
					controller.close();
					return;
				}
				stats.pulled += 1;
				controller.enqueue(chunks[at++] as Uint8Array);
			},
			cancel() {
				stats.cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
}

/**
 * `ctx.http` 的替身:它本身能直接调(`ctx.http(url, config)`),身上也挂着 `file()`。两条口
 * 都记账 —— 「走的是哪条口、带了什么配置」正是要钉的东西。
 *
 * 照 `@cordisjs/plugin-http` 的样子交响应体:`responseType: "stream"` 交那条流本身,
 * `"arraybuffer"`(以及 `file()`)先**整个读完**再交 —— 后者正是「读完再判等于已经被打爆了」。
 */
function fakeHttp(
	over: {
		data?: ArrayBuffer;
		chunks?: Uint8Array[];
		type?: string | null;
		status?: number;
		headers?: Record<string, string>;
		hang?: boolean;
	} = {},
) {
	const calls: Array<{ via: "request" | "file"; url: string; config: Record<string, unknown> }> = [];
	const stats = { pulled: 0, cancelled: false };
	const type = "type" in over ? over.type : "image/png";
	const chunks = over.chunks ?? [new Uint8Array(over.data ?? body(PNG_HEAD))];
	const headers = new Headers({ ...(type ? { "content-type": type } : {}), ...over.headers });
	async function drain(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
		const parts: Uint8Array[] = [];
		for await (const part of stream) parts.push(part);
		const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.byteLength;
		}
		return out.buffer;
	}
	const request = async (url: string, config: Record<string, unknown>) => {
		calls.push({ via: "request", url, config });
		const stream = streamOf(chunks, stats, config.signal as AbortSignal | undefined, over.hang);
		const data = config.responseType === "stream" ? stream : await drain(stream);
		return { url, status: over.status ?? 200, statusText: "", headers, data };
	};
	const file = async (url: string, config: Record<string, unknown>) => {
		calls.push({ via: "file", url, config });
		return { data: await drain(streamOf(chunks, stats, undefined)), type };
	};
	return { calls, stats, http: Object.assign(request, { file }) as never };
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
		assert.equal(out.data.byteLength, 32);
		assert.ok(out.data instanceof Uint8Array);
	});
});

describe("超时", () => {
	/** BN 只等 30 秒(协议 §5.4),取图这一步必须**明显短于**那个窗口。 */
	it("带着一个短于 BN 那 30 秒窗口的超时下去", async () => {
		const h = fakeHttp();
		await fetchImage(h.http, "http://bn/ext/bridge/blob/aaaa");
		assert.equal(h.calls[0]?.config.timeout, 20_000);
		assert.equal(IMAGE_FETCH_TIMEOUT_MS, 20_000);
		assert.ok(IMAGE_FETCH_TIMEOUT_MS < 30_000, "比 BN 的回执窗口还长,等于没有超时");
	});
});

/**
 * 🔴 **取图不走 koishi 的全局代理。** koishi 的 loader 会装 proxy-agent,每个 `ctx.http` 请求都
 * 套全局代理:内网 BN 的取图地址被送进代理 —— 要么取不到,要么这条一次性 URL 泄露给代理。
 * BN 的地址是用户直接填的,怎么连到它由这个地址说了算。
 *
 * 逐请求关掉代理的写法是请求配置里 `proxyAgent: ""`(proxy-agent 那头是
 * `config?.proxyAgent ?? 全局那个`,空串过得了 `??`、过不了之后那道 `if (!proxy)`)。
 * `http.file()` 那条口只收 `timeout`,传不下去 —— 所以得走 `ctx.http()` 本身。
 */
describe("不走代理", () => {
	it("走 ctx.http() 本身、带着 proxyAgent: \"\",不走 http.file()", async () => {
		const h = fakeHttp();
		await fetchImage(h.http, "http://192.168.1.5:8787/ext/bridge/blob/aaaa");
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0]?.via, "request", "走了 http.file() —— 那条口关不掉代理");
		assert.equal(h.calls[0]?.config.proxyAgent, "");
	});
});

/**
 * 🔴 **大小上限边读边判。** 读完再比等于已经被打爆了 —— 递一条大文件的地址过来,整个先进了
 * 内存。所以:Content-Length 说超了就不读;没说(或者说了假话)就边读边数,超了当场掐掉;
 * 够认魔数时当场认,不是图就别把它整个拉下来。
 */
describe("边读边判", () => {
	const png = (size: number) => new Uint8Array(body(PNG_HEAD, size));
	const zeros = (size: number) => new Uint8Array(size);

	it("Content-Length 说超了 → 一个字节都不读就拒,并说清多大、上限多少", async () => {
		const h = fakeHttp({ chunks: [png(64), zeros(64)], headers: { "content-length": "128" } });
		await assert.rejects(
			() => fetchImage(h.http, "http://bn/ext/bridge/blob/big", { maxBytes: 100 }),
			(err: Error) => {
				assert.match(err.message, /128/, "没说这张有多大");
				assert.match(err.message, /100/, "没说上限是多少");
				return true;
			},
		);
		assert.equal(h.stats.pulled, 0, "Content-Length 已经说超了,还是读了");
		assert.ok(h.stats.cancelled, "没把那条响应掐掉");
	});

	it("没给 Content-Length → 边读边数,超了当场掐掉,不把剩下的拉完", async () => {
		const chunks = [png(40), ...Array.from({ length: 50 }, () => zeros(40))];
		const h = fakeHttp({ chunks });
		await assert.rejects(
			() => fetchImage(h.http, "http://bn/ext/bridge/blob/big", { maxBytes: 100 }),
			/上限 100/,
		);
		assert.equal(h.stats.pulled, 3, "超了上限还在往下读");
		assert.ok(h.stats.cancelled, "没把那条响应掐掉");
	});

	/** Content-Length 可以撒谎(说得小):照样边读边数。 */
	it("Content-Length 说得比实际小 → 照样在读到上限时掐掉", async () => {
		const chunks = [png(40), ...Array.from({ length: 50 }, () => zeros(40))];
		const h = fakeHttp({ chunks, headers: { "content-length": "40" } });
		await assert.rejects(
			() => fetchImage(h.http, "http://bn/ext/bridge/blob/big", { maxBytes: 100 }),
			/上限 100/,
		);
		assert.equal(h.stats.pulled, 3);
	});

	it("头一块就认得出不是图 → 当场拒,不把剩下的拉下来", async () => {
		const page = new TextEncoder().encode("<html><body>login</body></html>");
		const h = fakeHttp({ chunks: [page, ...Array.from({ length: 50 }, () => zeros(1024))] });
		await assert.rejects(() => fetchImage(h.http, "http://bn/x"), /不像图片/);
		assert.equal(h.stats.pulled, 1, "认出不是图之后还在往下读");
		assert.ok(h.stats.cancelled, "没把那条响应掐掉");
	});

	it("魔数被切在几块里 → 凑齐了照认", async () => {
		const head = new Uint8Array(body(PNG_HEAD, 16));
		const h = fakeHttp({ chunks: [head.subarray(0, 3), head.subarray(3, 9), head.subarray(9)] });
		const out = await fetchImage(h.http, "http://bn/x");
		assert.equal(out.mime, "image/png");
		assert.deepEqual([...out.data], [...head], "拼回来的字节不对");
	});

	/**
	 * 🔴 流式读的时候,`ctx.http` 自己那只超时**在响应头回来那一刻就撤了**
	 * (plugin-http 在 `finally` 里清掉它)—— 一滴一滴给的对头能把读 body 那段拖到天荒地老。
	 * 所以整趟(连读 body)要自己看表。
	 */
	it("对头给了个头就不说话了 → 到点掐掉,说是超时", async () => {
		const h = fakeHttp({ chunks: [png(16)], hang: true });
		await assert.rejects(
			() => fetchImage(h.http, "http://bn/x", { timeoutMs: 20 }),
			/超时/,
		);
	});

	/**
	 * 状态码自己判:交给 plugin-http 判的话,它碰到 4xx / 5xx 会先把**整个**错误页读进内存
	 * (`defaultDecoder`)才抛 —— 这一截又没有上限。
	 */
	it("对头回 404 → 拒并说出状态码,响应体一个字节都不读", async () => {
		const h = fakeHttp({ status: 404, chunks: [png(64)] });
		await assert.rejects(() => fetchImage(h.http, "http://bn/x"), /404/);
		assert.equal(h.stats.pulled, 0);
		const validate = h.calls[0]?.config.validateStatus as ((status: number) => boolean) | undefined;
		assert.equal(validate?.(500), true, "状态码交给了 plugin-http 判 —— 它会把错误页整个读进来");
	});
});

describe("上限", () => {
	it("超了上限就抛,并说清多大、上限多少", async () => {
		const h = fakeHttp({ data: body(PNG_HEAD, MAX_IMAGE_BYTES + 1) });
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
		const h = fakeHttp({ data: body(PNG_HEAD, MAX_IMAGE_BYTES) });
		const out = await fetchImage(h.http, "http://bn/ext/bridge/blob/edge");
		assert.equal(out.data.byteLength, MAX_IMAGE_BYTES);
	});
});

/**
 * 🔴 **2xx 不等于拿到了图。** BN 挂在一层要登录的反代后面时,取图口回的是一张 200 的登录页;
 * 照单全收就是群里一张裂图、回执还是 ok。Content-Type 明说不是图的直接拒;字节再按魔数认一遍,
 * 认不出的也拒 —— Content-Type 挡得住老实的登录页,挡不住一张标着 `image/png` 的错误页。
 */
describe("取回来的得真是图", () => {
	it("Content-Type 明说不是图 → 拒,并说出它是什么", async () => {
		const h = fakeHttp({ type: "text/html; charset=utf-8" });
		await assert.rejects(() => fetchImage(h.http, "http://bn/x"), /text\/html/);
	});

	/** 🔴 拒的时候别把字节倒进报错:它会原样进 BN 的推送历史,登录页里可能正带着东西。 */
	it("标着 image/png、字节却不是图 → 拒,而且报错里没有那些字节", async () => {
		const page = "<html><body>请先登录 secret-token-abc</body></html>";
		const h = fakeHttp({ type: "image/png", data: body(page) });
		await assert.rejects(
			() => fetchImage(h.http, "http://bn/x"),
			(err: Error) => {
				assert.match(err.message, /不像图片/);
				assert.ok(!err.message.includes("secret"), `把字节倒进报错了:${err.message}`);
				assert.ok(!err.message.includes("<html"), `把字节倒进报错了:${err.message}`);
				return true;
			},
		);
	});

	it("短到连魔数都凑不齐 → 拒", async () => {
		const h = fakeHttp({ type: "image/gif", data: new TextEncoder().encode("GIF").buffer });
		await assert.rejects(() => fetchImage(h.http, "http://bn/x"), /不像图片/);
	});

	/** mp4 也是 `ftyp` 打头 —— 只看第 4..8 个字节等于把一段视频当成图放过去。 */
	it("ISO-BMFF 但品牌不是图(mp4)→ 拒", async () => {
		const h = fakeHttp({ type: null, data: body(ftyp("isom")) });
		await assert.rejects(() => fetchImage(h.http, "http://bn/x"), /不像图片/);
	});

	/** 有的 CDN / 对象存储就是这么回图的:没标、或者标成通用的二进制,交给字节认。 */
	for (const type of [null, "", "application/octet-stream"]) {
		it(`Content-Type 是 ${JSON.stringify(type)} → 交给字节认`, async () => {
			const out = await fetchImage(fakeHttp({ type, data: body(PNG_HEAD) }).http, "http://bn/x");
			assert.equal(out.mime, "image/png");
		});
	}

	/**
	 * 🔴 **交给渲染层的 mime 是认出来的那个,不是对头说的。** 带参数的 content-type
	 * (`image/png; charset=binary`)会让 onebot 的 `data:` 正则失配、整张图发不出去;对头
	 * 标错了的(说 jpeg、其实是 png)照它发就是一张打不开的图。
	 */
	it("mime 是认出来的:不带参数、以字节为准", async () => {
		const withParams = fakeHttp({ type: "image/png; charset=binary", data: body(PNG_HEAD) });
		assert.equal((await fetchImage(withParams.http, "http://bn/x")).mime, "image/png");
		const mislabelled = fakeHttp({ type: "image/jpeg", data: body(PNG_HEAD) });
		assert.equal((await fetchImage(mislabelled.http, "http://bn/x")).mime, "image/png");
		const shouting = fakeHttp({ type: "IMAGE/PNG", data: body(PNG_HEAD) });
		assert.equal((await fetchImage(shouting.http, "http://bn/x")).mime, "image/png");
	});

	const KINDS: Array<[string, number[] | string, string]> = [
		["PNG", PNG_HEAD, "image/png"],
		["JPEG", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
		["GIF87a", "GIF87a", "image/gif"],
		["GIF89a", "GIF89a", "image/gif"],
		["WEBP", "RIFF\0\0\0\0WEBPVP8 ", "image/webp"],
		["BMP", "BM", "image/bmp"],
		["AVIF", ftyp("avif"), "image/avif"],
		["HEIC", ftyp("heic"), "image/heic"],
		["HEIF", ftyp("mif1"), "image/heif"],
	];
	for (const [label, head, mime] of KINDS) {
		it(`认得 ${label}`, async () => {
			const out = await fetchImage(fakeHttp({ type: null, data: body(head) }).http, "http://bn/x");
			assert.equal(out.mime, mime);
		});
	}
});
