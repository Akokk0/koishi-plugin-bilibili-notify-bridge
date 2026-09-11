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
import { jsonElement, miniAppCardJson, structMsgCardJson } from "./cards";

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

describe("分享卡", () => {
	const card = (url: string) => jsonElement(structMsgCardJson(url));
	const miniApp = (url: string) => jsonElement(miniAppCardJson(url));

	/**
	 * 🔴 **卡里的链接放 `cardLinks`,不拼进正文**(协议 1.4)。拼进正文就等于告诉 BN
	 * 「这是用户敲的一条普通链接」—— 正文那一格从此不再是用户敲的那句话,而小程序卡更糟:
	 * BN 会对着一张已经能点开播放的卡再回一张。
	 */
	it("卡里的链接单独一格,正文不被污染(正文本来是空的也驮)", () => {
		const out = inboundOf(session({ content: "", elements: [card("https://b23.tv/aaa")] }), ALL);
		assert.deepEqual(out, {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "",
			cardLinks: ["https://b23.tv/aaa"],
		});
	});

	it("正文里本来有话 → 正文照旧只有那句话", () => {
		assert.deepEqual(
			inboundOf(session({ content: "看这个", elements: [card("https://b23.tv/bbb")] }), ALL),
			{
				scope: "group",
				groupId: "g-42",
				userId: "10086",
				text: "看这个",
				cardLinks: ["https://b23.tv/bbb"],
			},
		);
	});

	/** 群里已经有一张能点开播放的卡了 —— BN 读得出这一格就不会再回一张。 */
	it("小程序卡的链接进 miniAppCardLinks,不进 cardLinks、也不进正文", () => {
		const out = inboundOf(session({ content: "", elements: [miniApp("https://b23.tv/ccc")] }), ALL);
		assert.deepEqual(out, {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "",
			miniAppCardLinks: ["https://b23.tv/ccc"],
		});
	});

	/**
	 * 群消息那道「含链接才驮」的闸要把两格算进去。漏了它,一张正文为空的分享卡就被挡在
	 * 桥这一侧 —— 症状是「群里转 B 站卡片 BN 一声不吭」,而 BN 那头什么日志都没有。
	 */
	it("正文没链接、只有小程序卡 → 照样驮(闸要看两格)", () => {
		assert.ok(
			inboundOf(session({ content: "看这个", elements: [miniApp("https://b23.tv/e")] }), ALL),
		);
	});

	/** 没卡的消息不多带两格空数组上去 —— 群消息是这条桥最大的一股流量。 */
	it("没有卡就一格都不带", () => {
		assert.deepEqual(inboundOf(session(), ALL), {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "看看这个 https://b23.tv/x",
		});
	});

	/** 私聊只有指令,指令不认链接 —— 协议私聊那一支没有这两格,别顺手拼进正文。 */
	it("私聊里的卡不拼进正文;剥完没话就不驮", () => {
		assert.equal(
			inboundOf(session({ isDirect: true, content: "", elements: [card("https://b23.tv/f")] }), ALL),
			null,
		);
		assert.deepEqual(
			inboundOf(
				session({ isDirect: true, content: "/help", elements: [card("https://b23.tv/f")] }),
				ALL,
			),
			{ scope: "private", userId: "10086", text: "/help" },
		);
	});
});
