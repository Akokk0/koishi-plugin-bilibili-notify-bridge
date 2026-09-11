/**
 * koishi 收到的一条消息 → 要不要驮给 BN、驮成什么样(协议 §5.3 / §8)。
 *
 * **过滤在桥这一侧做**,省的是带宽与隐私 —— BN 只说它要什么(`welcome` 里那份订阅),
 * 群白名单那种策略仍归 BN 自己判。
 */

import h from "@satorijs/element";
import { type CardElementLike, cardLinksOf } from "./onebot";
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
	/** 归一化之后的元素。分享卡(`json` / `xml` 段)只在这里看得见。 */
	elements?: readonly CardElementLike[];
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

	// 订阅闸**排在剥正文之前**。BN 眼下不收这一档的话,下面那两步(解一遍元素树、把分享卡的
	// json/xml 拆开)全是白干的 —— 而群消息是这条桥最大的一股流量,`group: "none"` 时每一条
	// 都要白解一遍。两条路在这儿答的都是「不驮」,所以早退一步不改任何结果。
	// BN 今天群里没有指令入口,群消息唯一的用途就是链接解析 —— 所以「要含链接的」这一档
	// 之外没有别的档。
	if (session.isDirect ? !subscription.private : subscription.group !== "with-links") return null;

	const text = plainTextOf(session.content);

	// 私聊那一支**只有正文**(协议 §5.3):BN 的私聊入口只有指令,指令不认链接。所以卡在
	// 这条路上不解、也不拼 —— 拼进去的话主人在私聊里转一张卡,BN 会拿一串 URL 去匹配指令。
	if (session.isDirect) {
		return text === "" ? null : { scope: "private", userId: session.userId, text };
	}

	// 🔴 分享卡里的链接**单独两格**(协议 1.4),不拼进正文。拼进去等于告诉 BN「这是用户敲的
	// 一条普通链接」—— 小程序卡因此会被回一张重复的卡(BN 那侧 `miniAppCardLinks` 刻意不解析,
	// 正是为了不回)。老协议(1.3)没有这两格才只好拼,现在有了。
	const { cardLinks, miniAppCardLinks } = cardLinksOf(session.elements ?? []);

	// 「含链接才驮」那道闸要把两格算进去:群里转一张 B 站卡时正文常常是空的,只看正文的话
	// 这条消息在桥这一侧就没了 —— 症状是「群里发卡片 BN 一声不吭」,而 BN 那头什么都没收到。
	if (!HAS_LINK.test(text) && cardLinks.length === 0 && miniAppCardLinks.length === 0) return null;

	// 空的那格不带上去:群消息是这条桥最大的一股流量,而缺省与「这条没有那种卡」同义。
	return {
		scope: "group",
		groupId: session.channelId,
		userId: session.userId,
		text,
		...(cardLinks.length > 0 ? { cardLinks } : {}),
		...(miniAppCardLinks.length > 0 ? { miniAppCardLinks } : {}),
	};
}
