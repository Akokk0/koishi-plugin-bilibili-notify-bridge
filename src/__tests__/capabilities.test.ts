/**
 * 能力表 —— 这个桥**必报**的六项(协议 §7)。
 *
 * 🔴 它是**硬编的**,不是探出来的:koishi 的 `bot.supports()` 粒度是 Satori 的 API 方法,
 * 而 @全体 / 发图 / 合并转发是**消息元素**;适配器碰到不认识的元素**静默丢弃、不抛错**,
 * 连 try/catch 都探不出来。所以只能由桥自己声明。
 *
 * ⚠️ 因为是硬编的,**每一格都要有依据**,而「不确定」有专门的一档叫 `unknown` ——
 * 拿不准时报 supported,症状是「@全体没生效而且一声不响」。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilitiesFor } from "../capabilities";
import { BRIDGE_CAPABILITIES } from "../protocol";

describe("六项恒在", () => {
	it("认识的平台与没见过的平台,都报满六项", () => {
		for (const platform of ["discord", "telegram", "从没见过的平台"]) {
			assert.deepEqual(Object.keys(capabilitiesFor(platform)).sort(), [...BRIDGE_CAPABILITIES].sort());
		}
	});
});

describe("@全体:一格一个依据", () => {
	/** `@satorijs/adapter-discord` 编码器:`attrs.type === "all"` → `@everyone`。 */
	it("discord 真的发得出去", () => {
		assert.equal(capabilitiesFor("discord").atAll, "supported");
	});

	/** `@satorijs/adapter-kook` 编码器:`attrs.type === "all"` → `(met)all(met)`。 */
	it("kook 真的发得出去", () => {
		assert.equal(capabilitiesFor("kook").atAll, "supported");
	});

	/** 那两家的编码器里**根本没有 at-all 这一支**,元素会被静默丢掉。 */
	it("telegram 与 qq 发不出去 —— 说不支持,不说不知道", () => {
		assert.equal(capabilitiesFor("telegram").atAll, "unsupported");
		assert.equal(capabilitiesFor("qq").atAll, "unsupported");
	});

	/** `koishi-plugin-adapter-onebot` 的编码器:`attrs.type === "all"` → `[CQ:at,qq=all]`。 */
	it("onebot 真的发得出去", () => {
		assert.equal(capabilitiesFor("onebot").atAll, "supported");
	});

	/**
	 * 没查过适配器的平台一律 `unknown`。**拿不准不许报 supported** —— 三态里这一档
	 * 就是为它准备的:面板上显示「还不知道」,BN 照样会试。
	 */
	it("没查过的平台是「还不知道」,不是「不支持」", () => {
		assert.equal(capabilitiesFor("lark").atAll, "unknown");
		assert.equal(capabilitiesFor("slack").atAll, "unknown");
	});
});

describe("其余五项:今天的答案与平台无关", () => {
	it("入站恒支持 —— 这个桥自己就在转发消息", () => {
		for (const platform of ["discord", "telegram", "从没见过的平台"]) {
			assert.equal(capabilitiesFor(platform).inbound, "supported");
		}
	});

	/**
	 * 🔴 markdown 恒**不支持**:这个桥不做 markdown → koishi 元素的转换,而
	 * `@satorijs/adapter-discord` 还会把 markdown 字符**转义掉**(`\*`)。报支持的话
	 * BN 会把排版原样发过来,群里收到的是一堆反斜杠。BN 看见 unsupported 会自己剥成纯文本。
	 */
	it("markdown 恒不支持 —— 让 BN 剥成纯文本", () => {
		for (const platform of ["discord", "telegram", "onebot"]) {
			assert.equal(capabilitiesFor(platform).markdown, "unsupported");
		}
	});

	/**
	 * 🔴 合并转发**按平台分**,而且判据是「那家的 `<figure>` 是不是真的合并转发卡」:
	 * onebot 的 `<figure>` 走 `send_group_forward_msg`(真·聊天记录卡),而 discord /
	 * telegram 的 `figure` 只是**换个头像分条发**,不是同一回事。
	 */
	it("合并转发只有 onebot 有 —— 别家的 figure 不是那个东西", () => {
		assert.equal(capabilitiesFor("onebot").forward, "supported");
		assert.equal(capabilitiesFor("discord").forward, "unsupported");
		assert.equal(capabilitiesFor("telegram").forward, "unsupported");
		assert.equal(capabilitiesFor("lark").forward, "unknown");
	});

	/** 分享卡链接只要**桥自己解得动**就成立,与实现无关 —— 只有 onebot 有 json/xml 卡。 */
	it("分享卡链接:onebot 解得动,别家没有这回事", () => {
		assert.equal(capabilitiesFor("onebot").shareCardLinks, "supported");
		assert.equal(capabilitiesFor("discord").shareCardLinks, "unsupported");
	});

	/**
	 * 🔴 小程序卡**探得出来**(`get_mini_app_ark` 是个 API,失败带 retcode),所以它不写死:
	 * 探之前一律「还不知道」,探完了由调用方盖上真答案。
	 */
	it("小程序卡:没探之前是「还不知道」,探完了可以盖上去", () => {
		assert.equal(capabilitiesFor("onebot").miniAppCard, "unknown");
		assert.equal(
			capabilitiesFor("onebot", { miniAppCard: "supported" }).miniAppCard,
			"supported",
		);
		// 盖的只是那一格,别的照旧。
		assert.equal(capabilitiesFor("onebot", { miniAppCard: "supported" }).atAll, "supported");
	});

	/** 别的平台压根没有小程序卡这回事 —— 探都不用探。 */
	it("非 QQ 家的平台:小程序卡恒不支持", () => {
		assert.equal(capabilitiesFor("discord").miniAppCard, "unsupported");
		assert.equal(capabilitiesFor("telegram").miniAppCard, "unsupported");
	});
});
