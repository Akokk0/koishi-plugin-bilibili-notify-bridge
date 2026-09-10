/**
 * BN 的一条 `send` → koishi 的消息元素。
 *
 * 两条贯穿始终的规矩:
 *
 * 🔴 **图必须发下载下来的字节**(协议 §9):帧里那条 URL **只保证桥自己可达** —— BN 常跑在
 * NAS 上,把它交给平台去拉是**静默失败**(消息到了、图没了、日志一个字都没有)。
 *
 * 🔴 **能力不够就降级,不是整条丢**:@不动全体就写成文字、合并转发做不到就一张张发。
 * 丢掉的话主人根本不知道少了什么。
 */

import h from "@satorijs/element";
import type { BridgeMessage, BridgeSegment } from "./protocol";

export interface RenderedImage {
	data: Uint8Array;
	mime: string;
}

export interface RenderContext {
	/** 已经下载好的图,按帧里那条 URL 索引。 */
	images: Map<string, RenderedImage>;
	/** 这个 bot 能不能真 @全体。做不到就降级成文字。 */
	atAll: boolean;
}

/** 拿不到就**抛**。发一条缺了图的推送比发不出去更难查。 */
function imageOf(url: string, ctx: RenderContext): h {
	const image = ctx.images.get(url);
	if (!image) throw new Error(`这张图没在手里,发不了:${url}`);
	return h.image(image.data, image.mime);
}

function segment(seg: BridgeSegment, ctx: RenderContext): h {
	switch (seg.type) {
		case "text":
			return h.text(seg.text);
		case "image":
			return imageOf(seg.url, ctx);
		case "link":
			// 链接怎么渲染归桥自己判(协议明说它**不是**能力项)。koishi 各平台都认纯文本
			// 里的 URL,所以把地址原样写出来 —— 有标题就带上,让人知道那是什么。
			return h.text(seg.title ? `${seg.title} ${seg.href}` : seg.href);
		case "at-all":
			return ctx.atAll ? h("at", { type: "all" }) : h.text("@全体成员");
	}
}

/**
 * 这条消息里有哪些要**桥自己下载**的图(协议 §9)。
 *
 * blob 是**取过即焚**的,所以恰好取一次;而拿不到就整条失败,不发缺图的消息。
 */
export function imageUrlsIn(message: BridgeMessage): string[] {
	switch (message.kind) {
		case "image":
			return [message.url];
		case "composite":
			return message.segments.flatMap((seg) => (seg.type === "image" ? [seg.url] : []));
		case "forward-images":
			return message.images.map((image) => image.url);
		default:
			return [];
	}
}

export function renderMessage(message: BridgeMessage, ctx: RenderContext): h[] {
	switch (message.kind) {
		case "text":
			return [h.text(message.text)];
		case "image": {
			const out = [imageOf(message.url, ctx)];
			if (message.caption) out.push(h.text(message.caption));
			return out;
		}
		case "composite":
			return message.segments.map((seg) => segment(seg, ctx));
		case "forward-images":
			// 合并转发这个桥做不到(能力表里报的是 unsupported),协议要求**降级成多张图**。
			return message.images.map((image) => imageOf(image.url, ctx));
		case "miniapp-card":
			// 签不了 ark。降级用的是 `jumpUrl`(网页链接)——`path` 是小程序**页面路径**,
			// 贴到群里谁都点不开。
			return [h.text(`${message.title}\n${message.desc}\n${message.jumpUrl}`)];
	}
}
