/**
 * onebot 专属的那几样 —— 判据全部照 **BN 自己那份 onebot 适配器**抄
 * (`apps/server/src/platforms/onebot.ts` / `onebot-inbound.ts`),它是真机验过的。
 *
 * 这里的每一处都栽过人,所以每一处都写清了为什么。
 *
 * ⛔ **不能 import BN 的包**(这个插件独立发版、装在别人的 koishi 里),所以那边的判据在
 * 这里是抄的第二份 —— 改之前先去对一眼原件。
 */

import type { BridgeCapabilityState, BridgeMessage } from "./protocol.ts";

/** 只跟 B 站有关的卡才往里翻。 */
const CARD_HOST_HINT = /bilibili\.com|b23\.tv/i;
/** 分享卡的 payload 顶多几 KB;再大的不是卡。 */
const MAX_CARD_CHARS = 64 * 1024;
const MAX_CARD_DEPTH = 8;
/** QQ 小程序卡的 `app`。B 站 App「分享到 QQ」发出的就是它。 */
const MINIAPP_CARD_APP = "com.tencent.miniapp_01";
const URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;

/**
 * 签一张小程序卡要给腾讯的参数。
 *
 * 🔴 **那两个链接字段名字是反的**:`jumpUrl` 接的是 OpenSDK 的**小程序页面路径**
 * (B 站视频页是 `pages/video/video?bvid=…`),`webUrl` 才是**网页链接**(签回来落到卡的
 * `qqdocurl`)。照名字填的话,卡点开是「页面不存在」——BN 那侧栽过一次,别再栽。
 */
export function arkRequestOf(card: Extract<BridgeMessage, { kind: "miniapp-card" }>): {
	type: string;
	title: string;
	desc: string;
	picUrl: string;
	jumpUrl: string;
	webUrl: string;
} {
	return {
		type: "bili",
		title: card.title,
		desc: card.desc,
		picUrl: card.picUrl,
		jumpUrl: card.path,
		webUrl: card.jumpUrl,
	};
}

/**
 * 空参探一次 `get_mini_app_ark` 之后的判读。
 *
 * `1404`(OneBot 11)与 `404`(把 action 当路径的实现)= 这个实现没有这个接口;
 * `1400`「参数错」正说明**接口在**;有的实现对空参不挑、直接成功,也算在。
 * 别的错(超时、限流)**什么都证明不了** —— 写成「不支持」就等于把暂时的故障刻成结论。
 */
export function readMiniAppProbe(response: { retcode?: number }): BridgeCapabilityState {
	const code = response.retcode;
	if (code === 1404 || code === 404) return "unsupported";
	if (code === 1400 || code === 0) return "supported";
	return "unknown";
}

/**
 * 签回来的东西 → 能塞进 `json` 段的那一串。
 *
 * NapCat 把 ark 包在 `data.data` 里,别的实现直接给 —— 所以**剥到看见 `app` 那一格为止**
 * (顶多两层)。认不出来回 `null`:硬发一段不是 ark 的 json,群里出现的是一张空白卡。
 */
export function arkToSegmentData(raw: unknown): string | null {
	let value: unknown = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	for (let depth = 0; depth < 2; depth++) {
		if (typeof value !== "object" || value === null) return null;
		const obj = value as Record<string, unknown>;
		if (typeof obj.app === "string") return JSON.stringify(obj);
		if (!("data" in obj)) return null;
		value = obj.data;
	}
	return null;
}

/** koishi 把收到的 `json` / `xml` 段原样变成同名元素,卡的正文在 `attrs.data`。 */
export interface CardElementLike {
	type: string;
	attrs?: { data?: unknown };
}

/**
 * 群里那张分享卡里的链接,按出现顺序,**分两格**(协议 1.4 的 `cardLinks` /
 * `miniAppCardLinks`)。分类判据照 BN 自己那份抄
 * (`apps/server/src/platforms/onebot-inbound.ts` 的 `extractCardLinks`)—— 直连那路与
 * 经桥那路交给链接解析的东西必须是同一个形状,不然同一张卡两条路上的行为会分叉。
 *
 * 🔴 **小程序卡的单独一格。** BN 的链接解析**刻意不读** `miniAppCardLinks`:群里已经有
 * 一张能点开播放的卡了,再回一张都是重复。混进 `cardLinks`(或者像协议 1.3 那样拼进正文)
 * 就等于告诉 BN「这是条用户敲的普通链接」,它会对着同一张卡再回一张。
 *
 * json 先 `JSON.parse` 再逐字符串找:结构化消息里是 `https:\/\/…` 这种转义写法,对着原文
 * 找是找不到的;解析不动就退回原文找。xml 只需把 `&amp;` 还原。
 */
export function cardLinksOf(elements: readonly CardElementLike[]): {
	cardLinks: string[];
	miniAppCardLinks: string[];
} {
	const cardLinks: string[] = [];
	const miniAppCardLinks: string[] = [];
	for (const element of elements) {
		if (element.type !== "json" && element.type !== "xml") continue;
		const raw = element.attrs?.data;
		if (typeof raw !== "string" || raw.length > MAX_CARD_CHARS) continue;
		if (!CARD_HOST_HINT.test(raw)) continue;
		const card = cardStrings(element.type, raw);
		const into = card.miniApp ? miniAppCardLinks : cardLinks;
		for (const s of card.strings) {
			for (const m of s.matchAll(URL_RE)) into.push(m[0]);
		}
	}
	return { cardLinks, miniAppCardLinks };
}

function cardStrings(type: "json" | "xml", raw: string): { strings: string[]; miniApp: boolean } {
	if (type === "xml") return { strings: [raw.replace(/&amp;/g, "&")], miniApp: false };
	try {
		const parsed: unknown = JSON.parse(raw);
		const strings: string[] = [];
		collectStrings(parsed, strings, 0);
		const app =
			typeof parsed === "object" && parsed !== null ? (parsed as { app?: unknown }).app : undefined;
		return { strings, miniApp: app === MINIAPP_CARD_APP };
	} catch {
		return { strings: [raw.replace(/\\\//g, "/")], miniApp: false };
	}
}

function collectStrings(value: unknown, out: string[], depth: number): void {
	if (depth > MAX_CARD_DEPTH) return;
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out, depth + 1);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
	}
}
