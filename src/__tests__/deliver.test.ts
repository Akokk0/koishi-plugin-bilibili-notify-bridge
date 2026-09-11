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

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

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
	const card = {
		kind: "miniapp-card",
		title: "标题",
		desc: "简介",
		picUrl: "http://x/pic.png",
		path: "pages/video/video?bvid=BV1",
		jumpUrl: "https://www.bilibili.com/video/BV1",
	} as const;

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
});
