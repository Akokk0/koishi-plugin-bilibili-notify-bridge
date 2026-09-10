/**
 * koishi 的 bot → 报给 BN 的那份名单(协议 §5.2)。
 *
 * 名单是**全量快照**,BN 拿 `botId` 回指「用哪个 bot 发」,所以这一层只有两件要紧事:
 * id 在这条连接内唯一,以及**别把 koishi 的内部对象漏到 wire 上**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botsOf } from "../bots";

/** 只摆 `botsOf` 真正读的那几格 —— 多摆一格就是在假设它读了不该读的东西。 */
function bot(over: Record<string, unknown> = {}) {
	return {
		platform: "discord",
		selfId: "10086",
		user: { name: "小电视" },
		status: 1,
		...over,
	} as never;
}

describe("名单", () => {
	it("id 用 平台:账号 —— 一条连接内不会撞", () => {
		const list = botsOf([bot(), bot({ platform: "kook", selfId: "10086" })]);
		assert.deepEqual(
			list.map((b) => b.botId),
			["discord:10086", "kook:10086"],
		);
	});

	it("平台、显示名、账号都带上,能力表跟着平台走", () => {
		const [only] = botsOf([bot()]);
		assert.equal(only?.platform, "discord");
		assert.equal(only?.name, "小电视");
		assert.equal(only?.selfId, "10086");
		assert.equal(only?.capabilities?.atAll, "supported");
	});

	/**
	 * BN 那头不认得 koishi 后面挂着什么平台,bot 行左边那枚方块画什么只能由这里给
	 * (协议 §5.2 的 `icon`,只收 data URL)。没图标的平台不报这一格,BN 退回两个字母。
	 */
	it("认得的平台带上图标(data URL),不认得的不编一个", () => {
		const [qq, kook] = botsOf([bot({ platform: "onebot" }), bot({ platform: "kook" })]);
		assert.match(qq?.icon ?? "", /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
		assert.ok((qq?.icon ?? "").length < 4096, "一枚图标不该比一条消息还重");
		assert.equal(kook?.icon, undefined);
	});

	it("没有显示名就不报这一格,不编一个出来", () => {
		const [only] = botsOf([bot({ user: undefined })]);
		assert.equal(only?.name, undefined);
	});

	/**
	 * 🔴 **掉线的照报。** 协议里 bot 没有「在不在线」这一格,所以掉一次就从名单上消失的话,
	 * 主人在 BN 那边配好的推送目标会**看起来坏了**;而它其实只是重连中。发不出去那一刻
	 * 回一条失败的回执才是说实话的地方。
	 */
	it("掉线的 bot 也在名单里 —— 它只是发不出去,不是不存在", () => {
		const list = botsOf([bot({ status: 0 }), bot({ platform: "kook", status: 3 })]);
		assert.equal(list.length, 2);
	});

	/** 探出来的那格盖在表上,而且**按 bot 分** —— 同一台 koishi 上两个 QQ 号可能一个能签一个不能。 */
	it("探出来的能力盖到那个 bot 头上,别的 bot 不受影响", () => {
		const list = botsOf(
			[bot({ platform: "onebot", selfId: "1" }), bot({ platform: "onebot", selfId: "2" })],
			(botId) => (botId === "onebot:1" ? { miniAppCard: "supported" } : undefined),
		);
		assert.equal(list[0]?.capabilities?.miniAppCard, "supported");
		// 没探到的那个照旧是「还不知道」,不是「不支持」。
		assert.equal(list[1]?.capabilities?.miniAppCard, "unknown");
	});

	/**
	 * 🔴 koishi 里 `platform` / `selfId` **是可选的**(bot 刚建、还没登上时两格都空)。
	 * 报一个 `undefined:undefined` 上去,BN 那头会多出一个永远发不出去的 bot,而主人
	 * 还能把推送目标指到它身上。
	 */
	it("还没登上的 bot(没有平台 / 账号)不报 —— 不是报一个空的", () => {
		const list = botsOf([bot(), { user: { name: "刚建的" } } as never, bot({ selfId: undefined })]);
		assert.deepEqual(
			list.map((b) => b.botId),
			["discord:10086"],
		);
	});

	/** wire 上只该有协议列出来的那几格。koishi 的 ctx / adapter / internal 一个都不许漏。 */
	it("只输出协议里那几格", () => {
		const [only] = botsOf([bot({ ctx: {}, adapter: {}, internal: {} })]);
		assert.deepEqual(Object.keys(only ?? {}).sort(), [
			"botId",
			"capabilities",
			"icon",
			"name",
			"platform",
			"selfId",
		]);
	});
});
