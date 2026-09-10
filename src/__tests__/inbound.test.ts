/**
 * koishi 收到的一条消息 → 要不要驮给 BN、驮成什么样(协议 §8)。
 *
 * 过滤放在**桥这一侧**,省的是带宽与隐私。三条闸各自都有「漏了会怎样」:
 * bot 自己发的漏过去 → BN 解析自己刚发的链接、无限回卡;订阅不管 → 主人的每一条群聊
 * 都上传到 BN;不含链接的群消息漏过去 → 同上,而且量大得多。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inboundOf } from "../inbound";

const ALL = { private: true, group: "with-links" } as const;

function session(over: Record<string, unknown> = {}) {
	return {
		selfId: "10000",
		userId: "10086",
		channelId: "g-42",
		isDirect: false,
		content: "看看这个 https://b23.tv/x",
		...over,
	} as never;
}

describe("排掉 bot 自己", () => {
	/** 🔴 漏了它,BN 会解析自己刚发出去的那条链接,然后再发一张卡 —— 无限回卡。 */
	it("发信人就是这个 bot → 不驮", () => {
		assert.equal(inboundOf(session({ userId: "10000" }), ALL), null);
	});
});

describe("私聊", () => {
	it("订阅要私聊就驮上去", () => {
		assert.deepEqual(inboundOf(session({ isDirect: true, content: "/help" }), ALL), {
			scope: "private",
			userId: "10086",
			text: "/help",
		});
	});

	it("订阅不要私聊就不驮", () => {
		assert.equal(inboundOf(session({ isDirect: true }), { private: false, group: "none" }), null);
	});
});

describe("群消息", () => {
	it("含链接的驮上去,群号用消息所在的那个频道", () => {
		assert.deepEqual(inboundOf(session(), ALL), {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "看看这个 https://b23.tv/x",
		});
	});

	/** BN 今天群里**没有指令入口**,群消息唯一的用途就是链接解析。 */
	it("不含链接的不驮 —— 不然主人的每一条群聊都上传给 BN", () => {
		assert.equal(inboundOf(session({ content: "今天天气不错" }), ALL), null);
	});

	it("订阅说群消息一条都不要,含链接的也不驮", () => {
		assert.equal(inboundOf(session(), { private: true, group: "none" }), null);
	});
});

describe("正文", () => {
	/** koishi 的 content 里带着元素标记,原样驮上去 BN 会把 `<img …/>` 当正文解析。 */
	it("元素标记剥掉,只留人说的那些字", () => {
		const out = inboundOf(
			session({ content: '看看 <img src="http://x/y.png"/> https://b23.tv/x' }),
			ALL,
		);
		assert.ok(out && !out.text.includes("<img"));
		assert.ok(out?.text.includes("https://b23.tv/x"));
	});

	it("剥完只剩空白就不驮(一张图配一条链接才算数)", () => {
		assert.equal(inboundOf(session({ content: '<img src="http://x/y.png"/>' }), ALL), null);
	});
});
