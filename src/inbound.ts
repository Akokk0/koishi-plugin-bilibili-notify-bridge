/**
 * koishi 收到的一条消息 → 要不要驮给 BN、驮成什么样(协议 §5.3 / §8)。
 *
 * **过滤在桥这一侧做**,省的是带宽与隐私 —— BN 只说它要什么(`welcome` 里那份订阅),
 * 群白名单那种策略仍归 BN 自己判。
 */

import h from "@satorijs/element";
import type { BridgeInboundMessage, BridgeInboundSubscription } from "./protocol";

/** 只依赖这几格 —— 写全 koishi 的 `Session` 等于把整个框架焊进这一层。 */
export interface SessionLike {
	selfId: string;
	userId: string;
	/** 消息所在的频道。群消息拿它当群号 —— BN 回卡也回到这儿。 */
	channelId: string;
	isDirect: boolean;
	/** koishi 的原始正文,**带元素标记**。 */
	content: string;
}

/** 判「这条里有没有链接」。够宽即可 —— 真正解析什么是 BN 的活。 */
const HAS_LINK = /https?:\/\/\S+/i;

/**
 * 把 koishi 的正文剥成人说的那些字。
 *
 * 原样驮上去的话,BN 会把 `<img src="http://…"/>` 里那条 URL 当成正文里的链接去解析 ——
 * 症状是主人在群里发一张图,BN 回一张莫名其妙的卡。
 */
function plainTextOf(content: string): string {
	return h
		.select(h.parse(content), "text")
		.map((element) => String(element.attrs.content ?? ""))
		.join("")
		.trim();
}

export function inboundOf(
	session: SessionLike,
	subscription: BridgeInboundSubscription,
): BridgeInboundMessage | null {
	// 🔴 bot 自己发的一律不驮。漏了它,BN 会解析自己刚发出去的那条链接再回一张卡 —— 无限回卡。
	if (session.userId === session.selfId) return null;

	const text = plainTextOf(session.content);
	if (text === "") return null;

	if (session.isDirect) {
		return subscription.private ? { scope: "private", userId: session.userId, text } : null;
	}
	// BN 今天群里没有指令入口,群消息唯一的用途就是链接解析 —— 所以「要含链接的」这一档
	// 之外没有别的档。
	if (subscription.group !== "with-links") return null;
	if (!HAS_LINK.test(text)) return null;
	return { scope: "group", groupId: session.channelId, userId: session.userId, text };
}
