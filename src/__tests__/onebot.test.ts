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
import { arkRequestOf, arkToSegmentData, cardLinksOf, readMiniAppProbe } from "../onebot";
import { jsonElement, MINIAPP_CARD, miniAppCardJson, structMsgCardJson } from "./cards";

describe("签卡请求", () => {
	/**
	 * 🔴 **两个链接字段名字是反的**:`jumpUrl` 接的是 OpenSDK 的小程序页面路径,
	 * `webUrl` 才是网页链接(签回来落到卡的 `qqdocurl`)。照名字填的卡点开是「页面不存在」。
	 */
	it("jumpUrl 放小程序页面路径,webUrl 放网页链接", () => {
		const req = arkRequestOf(MINIAPP_CARD);
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
	it("抠得出来,顺序照原样", () => {
		const links = cardLinksOf([
			jsonElement(structMsgCardJson("https://b23.tv/aaa")),
			{ type: "text", attrs: { content: "随便说点什么" } },
		]);
		assert.deepEqual(links, { cardLinks: ["https://b23.tv/aaa"], miniAppCardLinks: [] });
	});

	/** 结构化消息里是 `https:\/\/…` 这种转义写法,对着原文找是找不到的。 */
	it("转义过的斜杠也找得到", () => {
		const links = cardLinksOf([
			{ type: "json", attrs: { data: '{"meta":{"a":"https:\\/\\/b23.tv\\/bbb"}}' } },
		]);
		assert.deepEqual(links.cardLinks, ["https://b23.tv/bbb"]);
	});

	/**
	 * 🔴 **小程序卡的链接单独一格**(协议 1.4)。BN 那侧的 `miniAppCardLinks` 专门不回卡 ——
	 * 群里已经有一张能点开播放的卡了。混进 `cardLinks`(或者像 1.3 那样拼进正文)就等于说
	 * 「这是条普通链接」,BN 会对着同一张卡再回一张。
	 */
	it("小程序卡的进 miniAppCardLinks,不进 cardLinks", () => {
		assert.deepEqual(cardLinksOf([jsonElement(miniAppCardJson("https://b23.tv/ccc"))]), {
			cardLinks: [],
			miniAppCardLinks: ["https://b23.tv/ccc"],
		});
	});

	it("一条消息里两种卡都有 → 各进各的格", () => {
		const links = cardLinksOf([
			jsonElement(structMsgCardJson("https://b23.tv/aaa")),
			jsonElement(miniAppCardJson("https://b23.tv/ccc")),
		]);
		assert.deepEqual(links, {
			cardLinks: ["https://b23.tv/aaa"],
			miniAppCardLinks: ["https://b23.tv/ccc"],
		});
	});

	it("跟 B 站没关系的卡不看", () => {
		const other = JSON.stringify({ app: "x", meta: { a: "https://example.com/x" } });
		assert.deepEqual(cardLinksOf([jsonElement(other)]), {
			cardLinks: [],
			miniAppCardLinks: [],
		});
	});

	it("xml 卡也认,&amp; 要还原", () => {
		const links = cardLinksOf([
			{ type: "xml", attrs: { data: '<msg url="https://b23.tv/d?a=1&amp;b=2"/>' } },
		]);
		assert.deepEqual(links.cardLinks, ["https://b23.tv/d?a=1&b=2"]);
	});

	/**
	 * 协议 §5.3 给这两格定了上限:每格最多 **32 条**、每条最长 **2048 字符**,超了**截断**
	 * (不是 `4003` —— 为多出来的几条 URL 把整条桥打死,代价不对称)。BN 那侧照样会截,但
	 * 截在**这一侧**才省得下带宽:一张 64 KB 的卡能抠出成百上千条 URL,把这一帧往 1 MB 的
	 * `maxPayload` 上推,而撞到那道门是整条连接断掉。
	 */
	it("超长的那条丢掉,别的照收", () => {
		const long = `https://b23.tv/${"a".repeat(2048)}`;
		assert.ok(long.length > 2048);
		const links = cardLinksOf([
			{ type: "json", attrs: { data: JSON.stringify({ a: long, b: "https://b23.tv/ok" }) } },
		]);
		assert.deepEqual(links.cardLinks, ["https://b23.tv/ok"]);
	});

	it("一格顶多 32 条,第 33 条起截掉", () => {
		const many = Array.from({ length: 40 }, (_v, i) => `https://b23.tv/n${i}`);
		const links = cardLinksOf([{ type: "json", attrs: { data: JSON.stringify(many) } }]);
		assert.equal(links.cardLinks.length, 32);
		assert.equal(links.cardLinks[31], "https://b23.tv/n31");
		assert.ok(!links.cardLinks.includes("https://b23.tv/n32"), "第 33 条没截掉");
	});

	/** 两格各数各的 —— 别让普通卡里的链接把小程序卡那一格的额度吃掉。 */
	it("两格的额度各算各的", () => {
		const many = Array.from({ length: 40 }, (_v, i) => `https://b23.tv/n${i}`);
		const links = cardLinksOf([
			{ type: "json", attrs: { data: JSON.stringify({ app: "x", meta: many }) } },
			{ type: "json", attrs: { data: miniAppCardJson("https://b23.tv/mini") } },
		]);
		assert.equal(links.cardLinks.length, 32);
		assert.deepEqual(links.miniAppCardLinks, ["https://b23.tv/mini"]);
	});
});
