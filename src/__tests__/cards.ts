/**
 * 测试用的腾讯分享卡形状。**不是随手编的** —— 这两张是从真机收到的卡里抠出来的:
 * `com.tencent.structmsg` 的链接在 `meta.news.jumpUrl`,小程序卡
 * (`com.tencent.miniapp_01`,B 站 App「分享到 QQ」发的就是它)在 `meta.detail_1.qqdocurl`。
 *
 * 抬到这儿是因为 `inbound` 与 `onebot` 两份测试都要用它:形状写两份的话,哪天腾讯换了字段
 * 就得两处一起改,漏一处就是一份测着老形状的假绿。
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
