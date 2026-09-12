/**
 * 测试共用的那几样形状。**不是随手编的** —— 分享卡那两张是从真机收到的卡里抠出来的:
 * `com.tencent.structmsg` 的链接在 `meta.news.jumpUrl`,小程序卡
 * (`com.tencent.miniapp_01`,B 站 App「分享到 QQ」发的就是它)在 `meta.detail_1.qqdocurl`。
 *
 * 抬到这儿是因为好几份测试都要用它:形状写几份的话,哪天腾讯换了字段就得几处一起改,
 * 漏一处就是一份测着老形状的假绿。
 *
 * ⚠️ 这个文件**不是测试**(runner 只找 `*.test.ts`),别往里加 `it`。
 */

/** 普通结构化分享卡的 payload(裸字符串,直接就是 `json` 段的 `data`)。 */
export function structMsgCardJson(url: string): string {
	return JSON.stringify({ app: "com.tencent.structmsg", meta: { news: { jumpUrl: url } } });
}

/** 小程序卡的 payload —— 它的链接归 `miniAppCardLinks`,BN 刻意不对它回卡。 */
export function miniAppCardJson(url: string): string {
	return JSON.stringify({ app: "com.tencent.miniapp_01", meta: { detail_1: { qqdocurl: url } } });
}

/** 把 payload 包成 koishi 归一化之后的那个 `json` 元素。 */
export function jsonElement(data: string): { type: "json"; attrs: { data: string } } {
	return { type: "json", attrs: { data } };
}

/**
 * BN 发下来的那张小程序卡(`send` 帧里的 `miniapp-card`)。
 *
 * 🔴 **那两个链接字段名字是反的**:`path` 是小程序**页面路径**、`jumpUrl` 才是网页链接。
 * `deliver` / `onebot` / `message` 三份测试要的是**同一张卡**:抄成三份的话,哪天签卡那侧
 * 改对了一处,另两处还在测着旧形状 —— 而这正是「卡点开是页面不存在」栽过的那一处。
 */
export const MINIAPP_CARD = {
	kind: "miniapp-card",
	title: "标题",
	desc: "简介",
	picUrl: "http://x/pic.png",
	path: "pages/video/video?bvid=BV1",
	jumpUrl: "https://www.bilibili.com/video/BV1",
} as const;

/**
 * 一小段真 PNG 头,当「下载下来的图字节」用。
 *
 * 🔴 **必须是 `Uint8Array`,不能是 `Buffer`**:`@satorijs/element` 的 `h.image()` 对这两种
 * 走的是**两条不同分支**(Buffer 走 `src.toString("base64")`,类型化视图走
 * `Binary.toBase64(src.buffer)`)。生产里喂进去的是 `Uint8Array`(`fetchImage` 的产物),
 * 拿 Buffer 来测就是在测另一条路 —— 那条路真坏了这里也照绿。
 */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
