/**
 * 探签卡口的**时机** —— 冷启动那一次注定问不出答案,所以「问出结论之前一直问」是这一格
 * 唯一能变绿的路。
 *
 * 🔴 漏了它的症状极难查:面板上那个 bot 的「小程序卡」永远停在「还不知道」,而日志里
 * 一条错都没有(探失败是静默的,按设计如此)。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldProbe } from "../probe";

describe("该不该探这个 bot", () => {
	it("onebot、登上了、还没探过 → 探", () => {
		assert.equal(shouldProbe({ platform: "onebot", selfId: "10000" }, undefined, false), true);
	});

	/** 别家平台压根没有小程序卡这回事,探它等于白发一个必失败的 API 调用。 */
	it("非 onebot 不探", () => {
		assert.equal(shouldProbe({ platform: "discord", selfId: "10000" }, undefined, false), false);
		assert.equal(shouldProbe({ selfId: "10000" }, undefined, false), false);
	});

	/** 没登上的 bot 拼不出 botId,探到的结果记不到任何人头上。 */
	it("还没登上的(没有账号)不探", () => {
		assert.equal(shouldProbe({ platform: "onebot" }, undefined, false), false);
	});

	/** 问出结论的不再问 —— 这一格一旦有了答案就不会再变。 */
	it("已经有结论的不再探", () => {
		assert.equal(shouldProbe({ platform: "onebot", selfId: "1" }, "supported", false), false);
		assert.equal(shouldProbe({ platform: "onebot", selfId: "1" }, "unsupported", false), false);
	});

	/**
	 * 🔴 这一条是整个文件的理由。satori 派 `login-added` 在 `bot.start()` **之前**,而
	 * adapter-onebot 要等自己那条 WS 连上才给 `internal._request` —— 冷启动那一发必然被拒,
	 * 读出来就是「还不知道」。不接着探的话那一格永远停在「还不知道」。
	 */
	it("上一次探成了「还不知道」→ 还要再探", () => {
		assert.equal(shouldProbe({ platform: "onebot", selfId: "1" }, "unknown", false), true);
	});

	/** 冷启动那几秒里三个口(启动扫一遍、login-added、login-updated)会挨个叫到同一个 bot。 */
	it("正在探的那一发还没回来 → 不重复探", () => {
		assert.equal(shouldProbe({ platform: "onebot", selfId: "1" }, undefined, true), false);
		assert.equal(shouldProbe({ platform: "onebot", selfId: "1" }, "unknown", true), false);
	});
});
