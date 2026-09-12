/**
 * BN 的一条 `send` → koishi 的消息元素。
 *
 * 这一层最容易出的错都是**静默**的:图拿 URL 发出去(平台在 NAS 外面拉不到)、能力不够
 * 时整条丢掉、小程序卡降级时用了点不开的那条路径。所以每一条都单独钉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMessage } from "../message";
import { MINIAPP_CARD, PNG } from "./cards";

const URL_A = "http://192.168.1.5:8787/ext/bridge/blob/aaaa";
const URL_B = "http://192.168.1.5:8787/ext/bridge/blob/bbbb";

function ctx(over: Partial<Parameters<typeof renderMessage>[1]> = {}) {
	return {
		forward: true,
		images: new Map([
			[URL_A, { data: PNG, mime: "image/png" }],
			[URL_B, { data: PNG, mime: "image/png" }],
		]),
		atAll: true,
		...over,
	};
}

const render = (message: Parameters<typeof renderMessage>[0], over = {}) =>
	renderMessage(message, ctx(over))
		.map((e) => e.toString())
		.join("");

describe("文字", () => {
	it("原样一段", () => {
		assert.equal(render({ kind: "text", text: "开播啦" }), "开播啦");
	});
});

describe("图", () => {
	/**
	 * 🔴 协议 §9:那条 URL **只保证桥自己可达**。把它交给平台去拉是**静默失败** ——
	 * 消息到了、图没了、日志一个字都没有。所以发出去的必须是下载下来的字节。
	 */
	it("发的是下载下来的字节,不是那条 URL", () => {
		const out = render({ kind: "image", url: URL_A, mime: "image/png" });
		assert.ok(out.includes("data:image/png;base64,"), out);
		assert.ok(!out.includes("192.168.1.5"), "那条只有桥自己够得着的 URL 漏出去了");
	});

	it("带说明就跟一段文字", () => {
		const out = render({ kind: "image", url: URL_A, mime: "image/png", caption: "看图" });
		assert.ok(out.includes("看图"));
	});

	/** 图没下下来还照发,就是发一条「没有图的推送」—— 最难查的那种坏。 */
	it("图不在手里 → 炸出来,不发一条缺图的消息", () => {
		assert.throws(
			() => render({ kind: "image", url: "http://x/never", mime: "image/png" }),
			/never/,
		);
	});
});

describe("复合消息", () => {
	it("段的顺序原样保持,链接变成看得见的地址", () => {
		const out = render({
			kind: "composite",
			segments: [
				{ type: "text", text: "前" },
				{ type: "link", href: "https://b23.tv/x", title: "标题" },
				{ type: "text", text: "后" },
			],
		});
		assert.ok(out.indexOf("前") < out.indexOf("https://b23.tv/x"));
		assert.ok(out.indexOf("https://b23.tv/x") < out.indexOf("后"));
		assert.ok(out.includes("标题"));
	});

	it("能 @全体就真 @", () => {
		const out = render({ kind: "composite", segments: [{ type: "at-all" }] });
		assert.equal(out, '<at type="all"/>');
	});

	/** 做不到就**降级成文字**,不是整条丢 —— 丢了主人根本不知道少了什么。 */
	it("@不动全体就退成文字", () => {
		const out = render({ kind: "composite", segments: [{ type: "at-all" }] }, { atAll: false });
		assert.ok(!out.includes("<at"));
		assert.ok(out.includes("@全体成员"));
	});
});

describe("降级", () => {
	/** 报了 `forward: supported` 就得真发一张卡 —— onebot 的 `<figure>` 走 send_group_forward_msg。 */
	it("能合并转发就包成一张 figure", () => {
		const out = render({
			kind: "forward-images",
			images: [{ url: URL_A }, { url: URL_B }],
			forward: true,
		});
		assert.ok(out.startsWith("<figure>"), out.slice(0, 40));
		assert.equal(out.split("<img").length - 1, 2);
	});

	/** 做不到就**一张张发**,一张都不能少(协议 §6.3 写死的),不是整条丢。 */
	it("合并转发做不到 → 多张图照发,一张不少", () => {
		const out = render(
			{ kind: "forward-images", images: [{ url: URL_A }, { url: URL_B }], forward: true },
			{ forward: false },
		);
		assert.ok(!out.includes("<figure"));
		assert.equal(out.split("<img").length - 1, 2);
	});

	/** BN 说这一条不要合并转发,那就别自作主张包成卡。 */
	it("BN 说不合并就不合并,哪怕做得到", () => {
		const out = render({
			kind: "forward-images",
			images: [{ url: URL_A }, { url: URL_B }],
			forward: false,
		});
		assert.ok(!out.includes("<figure"));
	});

	/**
	 * 小程序卡签不了 ark。降级成文字时用的必须是 **`jumpUrl`(网页链接)**,
	 * 不是 `path` —— 那是小程序**页面路径**,贴到群里谁都点不开。
	 */
	it("小程序卡 → 文字,用网页链接不用小程序路径", () => {
		const out = render(MINIAPP_CARD);
		assert.ok(out.includes("标题"));
		assert.ok(out.includes("https://www.bilibili.com/video/BV1"));
		assert.ok(!out.includes("pages/video/video"), "把小程序页面路径贴出去了,点不开");
	});
});
