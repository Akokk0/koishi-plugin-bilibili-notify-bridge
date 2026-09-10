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

	/**
	 * 没查过适配器的平台一律 `unknown`。**拿不准不许报 supported** —— 三态里这一档
	 * 就是为它准备的:面板上显示「还不知道」,BN 照样会试。
	 */
	it("没查过的平台是「还不知道」,不是「不支持」", () => {
		assert.equal(capabilitiesFor("onebot").atAll, "unknown");
		assert.equal(capabilitiesFor("lark").atAll, "unknown");
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

	/** 这三项这一版都没实现,所以答案是「这个桥做不到」而不是「不知道」。 */
	it("合并转发 / 小程序卡 / 分享卡链接:这一版没做,如实报不支持", () => {
		const caps = capabilitiesFor("discord");
		assert.equal(caps.forward, "unsupported");
		assert.equal(caps.miniAppCard, "unsupported");
		assert.equal(caps.shareCardLinks, "unsupported");
	});
});
