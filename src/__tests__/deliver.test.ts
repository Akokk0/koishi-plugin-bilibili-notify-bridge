/**
 * 一条 `send` 从帧到「真的发出去了」。
 *
 * 这一层的每一条失败都必须**变成一句回执**:BN 那头等着它决定这条推送算成还是算败,
 * 而干等超时的那 30 秒里,主人看到的是「推送卡着不动」。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilitiesFor } from "../capabilities";
import { deliverSend } from "../deliver";
import { MINIAPP_CARD, PNG } from "./cards";

function frame(over: Record<string, unknown> = {}) {
	return {
		type: "send",
		id: "s-1",
		botId: "discord:1",
		platform: "discord",
		target: { scope: "group", address: "g-1" },
		message: { kind: "text", text: "开播啦" },
		...over,
	} as never;
}

function deps(over: Record<string, unknown> = {}) {
	const sent: Array<{ how: string; to: string; content: string; referrer?: string }> = [];
	return {
		sent,
		deps: {
			botOf: () => ({
				sendMessage: async (to: string, content: unknown, referrer?: string) => {
					sent.push({ how: "group", to, content: String(content), referrer });
					return ["m-1"];
				},
				sendPrivateMessage: async (to: string, content: unknown) => {
					sent.push({ how: "private", to, content: String(content) });
					return ["m-1"];
				},
				// satori 的 `Bot` 基类上 `sendPrivateMessage` **永远在**,它内部调的是这一格 ——
				// 真正区分「这个平台有没有私聊」的是它。一个能发私聊的 bot 两格都得有。
				createDirectChannel: async (userId: string) => ({ id: `d-${userId}` }),
			}),
			fetchImage: async () => ({ data: PNG, mime: "image/png" }),
			// 投递这一层不再自己算能力表(那会变成第二个来源)—— 接线那头喂的就是报给 BN
			// 的那一份,这里照做。
			capabilitiesOf: (_botId: string, platform: string) => capabilitiesFor(platform),
			...over,
		} as never,
	};
}

describe("发出去了", () => {
	it("群消息发到那个频道", async () => {
		const d = deps();
		assert.deepEqual(await deliverSend(frame(), d.deps), { ok: true });
		assert.equal(d.sent[0]?.how, "group");
		assert.equal(d.sent[0]?.to, "g-1");
		assert.ok(d.sent[0]?.content.includes("开播啦"));
	});

	it("私聊走私聊那条口", async () => {
		const d = deps();
		await deliverSend(frame({ target: { scope: "private", address: "u-9" } }), d.deps);
		assert.equal(d.sent[0]?.how, "private");
		assert.equal(d.sent[0]?.to, "u-9");
	});

	/** 论坛话题 / 子频道:BN 给了上级地址就带上,koishi 拿它定位。 */
	it("给了上级地址就一起交给 koishi", async () => {
		const d = deps();
		await deliverSend(
			frame({ target: { scope: "group", address: "t-1", parentAddress: "g-1" } }),
			d.deps,
		);
		assert.equal(d.sent[0]?.referrer, "g-1");
	});

	it("图先下下来再发,发的是字节", async () => {
		const d = deps();
		const out = await deliverSend(
			frame({ message: { kind: "image", url: "http://bn/blob/a", mime: "image/png" } }),
			d.deps,
		);
		assert.deepEqual(out, { ok: true });
		assert.ok(d.sent[0]?.content.includes("data:image/png;base64,"));
	});
});

describe("小程序卡", () => {
	const card = MINIAPP_CARD;

	it("签得下来就发一张真卡(json 段)", async () => {
		const d = deps({ signMiniApp: async () => '{"app":"com.tencent.miniapp_01"}' });
		const out = await deliverSend(frame({ message: card }), d.deps);
		assert.deepEqual(out, { ok: true });
		assert.ok(d.sent[0]?.content.includes("onebot:json"), d.sent[0]?.content);
	});

	/** 签不下来(这个实现没这个接口 / 腾讯拒了)就**降级成文字**,不是整条丢。 */
	it("签不下来 → 退成标题 + 简介 + 网页链接,而且不是小程序路径", async () => {
		const d = deps({ signMiniApp: async () => null });
		const out = await deliverSend(frame({ message: card }), d.deps);
		assert.deepEqual(out, { ok: true });
		const content = d.sent[0]?.content ?? "";
		assert.ok(content.includes("https://www.bilibili.com/video/BV1"));
		assert.ok(!content.includes("pages/video/video"), "把小程序页面路径贴出去了,点不开");
	});

	/** 压根没接签卡口(别的平台)也一样降级,不该炸。 */
	it("没有签卡这回事的平台照样降级", async () => {
		const d = deps();
		const out = await deliverSend(frame({ message: card }), d.deps);
		assert.deepEqual(out, { ok: true });
		assert.ok(d.sent[0]?.content.includes("标题"));
	});
});

describe("取图", () => {
	const A = "http://bn/ext/bridge/blob/aaaa";
	const B = "http://bn/ext/bridge/blob/bbbb";

	/**
	 * 🔴 **一张张排队取,是把整条推送往 BN 那 30 秒的回执窗口上推**(协议 §5.4)。一条
	 * `forward-images` 十几张图、每张一秒,排着取就超时了 —— 而主人看到的是「推送失败」,
	 * 查不出是哪一步慢。
	 */
	it("几张图一起取,不排队等前一张回来", async () => {
		const started: string[] = [];
		const open: Array<() => void> = [];
		const d = deps({
			fetchImage: (url: string) =>
				new Promise((resolve) => {
					started.push(url);
					open.push(() => resolve({ data: PNG, mime: "image/png" }));
				}),
		});
		const sending = deliverSend(
			frame({
				message: { kind: "forward-images", images: [{ url: A }, { url: B }], forward: false },
			}),
			d.deps,
		);
		// 一轮微任务之后:并行取的话两张都已经起跑了,排队取的话只起跑了第一张。
		await Promise.resolve();
		assert.deepEqual(started, [A, B], "第二张在等第一张");
		for (const go of open) go();
		assert.deepEqual(await sending, { ok: true });
	});

	/**
	 * 🔴 **取图口是取过即焚的**(协议 §9)。同一条 URL 在一条消息里出现两次(BN 的复合消息
	 * 里同一张卡贴两处),取第二次必定 404 —— 然后整条推送算失败,而图其实是好好的。
	 */
	it("同一条 URL 出现两次 → 只取一次,两处都照画", async () => {
		const asked: string[] = [];
		const d = deps({
			fetchImage: async (url: string) => {
				asked.push(url);
				return { data: PNG, mime: "image/png" };
			},
		});
		const out = await deliverSend(
			frame({
				message: {
					kind: "composite",
					segments: [
						{ type: "image", url: A, mime: "image/png" },
						{ type: "text", text: "中间" },
						{ type: "image", url: A, mime: "image/png" },
					],
				},
			}),
			d.deps,
		);
		assert.deepEqual(out, { ok: true });
		assert.deepEqual(asked, [A], "取了两次 —— blob 取过即焚,第二次必败");
		assert.equal((d.sent[0]?.content.split("<img").length ?? 1) - 1, 2, "少画了一张");
	});

	/**
	 * 并行取的代价:一张炸了的时候,别的几张还在飞。**它们的失败也得有人接着** —— 没人接
	 * 就是一条 unhandledRejection,在 koishi 里能把整个进程带走。
	 */
	it("一张取不到 → 回失败带上那条地址;晚到的那几张失败不能变成 unhandledRejection", async () => {
		const d = deps({
			fetchImage: (url: string) =>
				url === A
					? Promise.reject(new Error("404"))
					: new Promise((_resolve, reject) => {
							setTimeout(() => reject(new Error("这张也 404,只是慢了一步")), 0);
						}),
		});
		const out = await deliverSend(
			frame({
				message: { kind: "forward-images", images: [{ url: A }, { url: B }], forward: false },
			}),
			d.deps,
		);
		assert.equal(out.ok, false);
		assert.match(String(out.err), /取图失败/);
		assert.match(String(out.err), /blob\/aaaa/);
		assert.equal(d.sent.length, 0);
		// 等那条晚到的 reject 落地:没被接住的话 node:test 把它算成这个文件的失败。
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	/**
	 * 🔴 对头没给 Content-Type 时不能就这么把 `undefined` 传下去:`h.image(data, undefined)`
	 * 发的是已废弃的 `base64://`。onebot 忍得下,Telegram / Discord 那几个适配器是拿
	 * `ctx.http.file()` 去解它的 —— 解不动就整条发不出去,而且是静默的。
	 */
	it("取回来的图没带 mime → 用帧里声明的那个,不落 base64://", async () => {
		const d = deps({ fetchImage: async () => ({ data: PNG, mime: undefined }) });
		const out = await deliverSend(
			frame({ message: { kind: "image", url: A, mime: "image/jpeg" } }),
			d.deps,
		);
		assert.deepEqual(out, { ok: true });
		assert.ok(d.sent[0]?.content.includes("data:image/jpeg;base64,"), d.sent[0]?.content);
		assert.ok(!d.sent[0]?.content.includes("base64://"), "落到已废弃的 base64:// 了");
	});
});

describe("发不出去", () => {
	it("名单里没有这个 bot → 说清楚是哪个", async () => {
		const out = await deliverSend(frame(), deps({ botOf: () => undefined }).deps);
		assert.equal(out.ok, false);
		assert.match(String(out.err), /discord:1/);
	});

	/** 图下不下来就**别发**:一条缺了图的推送是最难查的那种坏。 */
	it("图下不下来 → 回失败并带上那条地址,不发一条缺图的消息", async () => {
		const d = deps({
			fetchImage: async () => {
				throw new Error("404");
			},
		});
		const out = await deliverSend(
			frame({ message: { kind: "image", url: "http://bn/blob/gone", mime: "image/png" } }),
			d.deps,
		);
		assert.equal(out.ok, false);
		assert.match(String(out.err), /blob\/gone/);
		assert.equal(d.sent.length, 0);
	});

	it("平台把消息退回来 → 那句理由原样回给 BN", async () => {
		const d = deps({
			botOf: () => ({
				sendMessage: async () => {
					throw new Error("群被禁言了");
				},
			}),
		});
		const out = await deliverSend(frame(), d.deps);
		assert.equal(out.ok, false);
		assert.match(String(out.err), /禁言/);
	});

	/**
	 * 🔴 判「这个平台有没有私聊」不能看 `sendPrivateMessage` —— satori 的 `Bot` 基类
	 * **永远**定义它,那道闸是死代码,一次都不会拦下什么。真正缺的是它内部要调的
	 * `createDirectChannel`,所以没有私聊的平台抛的是 `this.createDirectChannel is not a
	 * function` —— 这句原样回给 BN,主人在推送历史里看到的是一句谁也看不懂的 TypeError。
	 */
	it("平台没有私聊这回事 → 回一句人话,不是 TypeError", async () => {
		const d = deps({
			botOf: () => ({
				sendMessage: async () => ["m-1"],
				// 基类给的这一格在(永远在),缺的是它内部要调的那一格。
				sendPrivateMessage: async () => {
					throw new TypeError("this.createDirectChannel is not a function");
				},
			}),
		});
		const out = await deliverSend(frame({ target: { scope: "private", address: "u-9" } }), d.deps);
		assert.equal(out.ok, false);
		assert.ok(
			!String(out.err).includes("is not a function"),
			`把 TypeError 原样回给 BN 了:${out.err}`,
		);
		assert.match(String(out.err), /私聊/);
		assert.match(String(out.err), /discord/, "没说是哪个平台");
		assert.equal(d.sent.length, 0);
	});
});
