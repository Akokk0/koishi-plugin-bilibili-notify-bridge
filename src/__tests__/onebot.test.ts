/**
 * onebot 专属的那几样。判据全部照 BN 自己那份 onebot 适配器抄 —— 它是**真机验过**的,
 * 而这几处每一个都栽过人:
 *
 * - 签卡那两个链接字段**名字是反的**(`jumpUrl` 是小程序页面路径、`webUrl` 才是网页链接);
 * - 签回来的 ark 藏在 `data.data` 里(NapCat);
 * - 小程序卡里的链接**不能**当普通链接交上去 —— 群里已经有一张能点开播放的卡了。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arkRequestOf, arkToSegmentData, readMiniAppProbe, shareCardLinksOf } from "../onebot.ts";

const CARD = {
	kind: "miniapp-card",
	title: "标题",
	desc: "简介",
	picUrl: "http://x/pic.png",
	path: "pages/video/video?bvid=BV1",
	jumpUrl: "https://www.bilibili.com/video/BV1",
} as const;

describe("签卡请求", () => {
	/**
	 * 🔴 **两个链接字段名字是反的**:`jumpUrl` 接的是 OpenSDK 的小程序页面路径,
	 * `webUrl` 才是网页链接(签回来落到卡的 `qqdocurl`)。照名字填的卡点开是「页面不存在」。
	 */
	it("jumpUrl 放小程序页面路径,webUrl 放网页链接", () => {
		const req = arkRequestOf(CARD);
		assert.equal(req.jumpUrl, "pages/video/video?bvid=BV1");
		assert.equal(req.webUrl, "https://www.bilibili.com/video/BV1");
		assert.equal(req.type, "bili");
	});
});

describe("探", () => {
	/** 1404(OneBot 11)/ 404(把 action 当路径的实现)= 这个实现没这个接口。 */
	it("1404 / 404 → 这个实现签不了", () => {
		assert.equal(readMiniAppProbe({ retcode: 1404 }), "unsupported");
		assert.equal(readMiniAppProbe({ retcode: 404 }), "unsupported");
	});

	/** 1400「参数错」正说明接口在;有的实现对空参不挑,直接成功也算在。 */
	it("1400 或直接成功 → 接口在", () => {
		assert.equal(readMiniAppProbe({ retcode: 1400 }), "supported");
		assert.equal(readMiniAppProbe({ retcode: 0 }), "supported");
	});

	/** 别的错(超时、限流)什么都证明不了 —— 别把「暂时不通」写成「不支持」。 */
	it("别的错 → 还不知道,下次再探", () => {
		assert.equal(readMiniAppProbe({ retcode: 1200 }), "unknown");
		assert.equal(readMiniAppProbe({}), "unknown");
	});
});

describe("签回来的 ark", () => {
	/**
	 * NapCat 比别家多包一层 `data`。`internal._get()` 已经把 onebot 的信封那层拆掉了,
	 * 所以这里**只需再剥一层** —— 与 BN 自己那份同一个限度,别更宽松:多剥一层就等于
	 * 接受一堆本来该判废的东西。
	 */
	it("剥掉 NapCat 多包的那层 data,认 app 那一格", () => {
		const ark = { app: "com.tencent.miniapp_01", meta: {} };
		assert.equal(arkToSegmentData(ark), JSON.stringify(ark));
		assert.equal(arkToSegmentData({ data: ark }), JSON.stringify(ark));
		// 再深一层就不认了(与 BN 同限度)。
		assert.equal(arkToSegmentData({ data: { data: ark } }), null);
	});

	it("整段是字符串也认", () => {
		const ark = { app: "com.tencent.miniapp_01" };
		assert.equal(arkToSegmentData(JSON.stringify(ark)), JSON.stringify(ark));
	});

	/** 认不出来就**别发** —— 发一段不是 ark 的 json,群里出现的是一张空白卡。 */
	it("认不出来回 null,不硬发", () => {
		assert.equal(arkToSegmentData({ nope: 1 }), null);
		assert.equal(arkToSegmentData("不是 json"), null);
	});
});

describe("分享卡里的链接", () => {
	const bili = (url: string) =>
		JSON.stringify({ app: "com.tencent.structmsg", meta: { news: { jumpUrl: url } } });

	it("抠得出来,顺序照原样", () => {
		const links = shareCardLinksOf([
			{ type: "json", attrs: { data: bili("https://b23.tv/aaa") } },
			{ type: "text", attrs: { content: "随便说点什么" } },
		]);
		assert.deepEqual(links, ["https://b23.tv/aaa"]);
	});

	/** 结构化消息里是 `https:\/\/…` 这种转义写法,对着原文找是找不到的。 */
	it("转义过的斜杠也找得到", () => {
		const links = shareCardLinksOf([
			{ type: "json", attrs: { data: '{"meta":{"a":"https:\\/\\/b23.tv\\/bbb"}}' } },
		]);
		assert.deepEqual(links, ["https://b23.tv/bbb"]);
	});

	/**
	 * 🔴 **小程序卡里的链接不交上去。** 群里已经有一张能点开播放的卡了,BN 那侧本来有
	 * 单独一格 `miniAppCardLinks` 专门不回卡 —— 但**桥协议只有正文一格**,拼进正文就等于
	 * 说「这是条普通链接」,BN 会再回一张。少一次回卡,好过多一次刷屏。
	 */
	it("小程序卡的不抠 —— 拼进正文 BN 会再回一张卡", () => {
		const miniApp = JSON.stringify({
			app: "com.tencent.miniapp_01",
			meta: { detail_1: { qqdocurl: "https://b23.tv/ccc" } },
		});
		assert.deepEqual(shareCardLinksOf([{ type: "json", attrs: { data: miniApp } }]), []);
	});

	it("跟 B 站没关系的卡不看", () => {
		const other = JSON.stringify({ app: "x", meta: { a: "https://example.com/x" } });
		assert.deepEqual(shareCardLinksOf([{ type: "json", attrs: { data: other } }]), []);
	});

	it("xml 卡也认,&amp; 要还原", () => {
		const links = shareCardLinksOf([
			{ type: "xml", attrs: { data: '<msg url="https://b23.tv/d?a=1&amp;b=2"/>' } },
		]);
		assert.deepEqual(links, ["https://b23.tv/d?a=1&b=2"]);
	});
});
