/**
 * koishi 收到的一条消息 → 要不要驮给 BN、驮成什么样(协议 §5.3 / §8)。
 *
 * **过滤在桥这一侧做**,省的是带宽与隐私 —— BN 只说它要什么(`welcome` 里那份订阅),
 * 群白名单那种策略仍归 BN 自己判。
 */

import h from "@satorijs/element";
import { type CardElementLike, cardLinksOf } from "./onebot";
import { type BridgeInboundMessage, type BridgeInboundSubscription, idOf } from "./protocol";

/**
 * 只依赖这几格 —— 写全 koishi 的 `Session` 等于把整个框架焊进这一层。
 *
 * 🔴 三个 id 格故意写成 `unknown`:koishi 的类型说它们是 `string`,可运行时 `userId` 就是
 * `event.user?.id` —— Telegram 频道帖没有发送者,那一格是 `undefined`;第三方适配器塞个
 * 数字进来也照收。照类型信了它,就是往 BN 送一帧畸形的(见 `idOf`)。
 */
export interface SessionLike {
	/** 收到这条消息的那个 bot 在哪个平台上 —— 拼 `botId` 要它。 */
	platform: string;
	selfId?: unknown;
	userId?: unknown;
	/** 消息所在的频道。群消息拿它当群号 —— BN 回卡也回到这儿。 */
	channelId?: unknown;
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
 *
 * 🔴 `<quote>` 整棵**先摘掉**:koishi 把被回复的那条整个塞进它的子元素里,而协议 §5.3 要的
 * 是「用户敲的那句话」。留着的症状是主人回复一条三天前的视频链接说「这个我看过」,BN 对着
 * 那条老链接又回一张卡。`toString(true)` 是 satori 自己的「剥成纯文本」,与手写的深选 text
 * 等价 —— 少一份会跟着 satori 漂的手抄实现。
 */
function plainTextOf(content: string): string {
	return h
		.parse(content)
		.filter((element) => element.type !== "quote")
		.map((element) => element.toString(true))
		.join("")
		.trim();
}

export function inboundOf(
	session: SessionLike,
	subscription: BridgeInboundSubscription,
	/**
	 * 「这个人是不是这台 koishi 借给 BN 的某个 bot」。传谓词而不是一份名单:群消息是这条桥
	 * 最大的一股流量,每条消息重建一次集合是白烧的,而**缓存一份的话它会漂**(主人随时会在
	 * koishi 里加一个 bot)。生产里它直接查 koishi 自己那张按 `botId` 索引的表。
	 */
	isOurs: (platform: string, userId: string) => boolean,
): BridgeInboundMessage | null {
	// 🔴 拿不到发送者的不驮(频道帖就没有发送者):BN 那头 `userId` 是 `z.string().min(1)`,
	// 缺了这一格 → 畸形帧 → close 4003 → 插件当终局永不重连。
	const userId = idOf(session.userId);
	if (userId === undefined) return null;

	// 🔴 bot 自己发的一律不驮。漏了它,BN 会解析自己刚发出去的那条链接再回一张卡 —— 无限回卡。
	// 两边**过同一道归一**:bot 的账号是数字、发送者是字符串时,不归一就永远比不上。
	if (userId === idOf(session.selfId)) return null;

	// 🔴 **兄弟 bot 发的同样不驮。** 同一台 koishi 借出去两个号、都在同一个群里时,A 推出去的
	// 那张卡在 B 眼里是「别人发的消息」—— 上面那道自检拦不住它,而它里面正带着一条 B 站链接:
	// 驮上去 BN 就对着自己刚发的链接再回一张,链接解析的冷却配成 0 就是死循环。
	//
	// ⚠️ 代价:**另一个借出去的 bot 真·手动发的链接也被丢掉了**。两头不对称得很明显 ——
	// 这头是重复回卡乃至死循环,那头只是少解析一条链接。
	if (isOurs(session.platform, userId)) return null;

	// 订阅闸**排在剥正文之前**。BN 眼下不收这一档的话,下面那两步(解一遍元素树、把分享卡的
	// json/xml 拆开)全是白干的 —— 而群消息是这条桥最大的一股流量,`group: "none"` 时每一条
	// 都要白解一遍。两条路在这儿答的都是「不驮」,所以早退一步不改任何结果。
	// BN 今天群里没有指令入口,群消息唯一的用途就是链接解析 —— 所以「要含链接的」这一档
	// 之外没有别的档。
	if (session.isDirect ? !subscription.private : subscription.group !== "with-links") return null;

	// 私聊那一支**只有正文**(协议 §5.3):BN 的私聊入口只有指令,指令不认链接。所以卡在
	// 这条路上不解、也不拼 —— 拼进去的话主人在私聊里转一张卡,BN 会拿一串 URL 去匹配指令。
	if (session.isDirect) {
		const text = plainTextOf(session.content);
		return text === "" ? null : { scope: "private", userId, text };
	}

	// 群号拿不到的同样过不了 BN 的 `min(1)`,理由同上。判在解析之前:它便宜。
	const groupId = idOf(session.channelId);
	if (groupId === undefined) return null;

	// 🔴 分享卡里的链接**单独两格**(协议 1.4),不拼进正文。拼进去等于告诉 BN「这是用户敲的
	// 一条普通链接」—— 小程序卡因此会被回一张重复的卡(BN 那侧 `miniAppCardLinks` 刻意不解析,
	// 正是为了不回)。老协议(1.3)没有这两格才只好拼,现在有了。
	const { cardLinks, miniAppCardLinks } = cardLinksOf(session.elements ?? []);

	// 「含链接才驮」那道闸要把两格算进去:群里转一张 B 站卡时正文常常是空的,只看正文的话
	// 这条消息在桥这一侧就没了 —— 症状是「群里发卡片 BN 一声不吭」,而 BN 那头什么都没收到。
	const hasCard = cardLinks.length > 0 || miniAppCardLinks.length > 0;

	// **超集闸**:先拿**原文**挡一道,挡掉的不必再解元素树。koishi 往 content 里只转义
	// `&` `<` `>`,`https://` 这个前缀在原文里一定原样在着 —— 所以「原文里没有」⇒「剥完也
	// 没有」,这一闸只会放过、不会误杀。群里绝大多数消息既没链接也没卡,今天它们每一条都要
	// 先付一次解析元素树的钱再被丢掉(实测 1441ns/条 vs 正则 18ns/条)。
	if (!hasCard && !HAS_LINK.test(session.content)) return null;

	const text = plainTextOf(session.content);

	// 剥完再判一次**精确**的:上面那道是超集,`<img src="http://…"/>` 这种只有元素标记里有
	// 链接的照样过得去,得在这儿拦下 —— 不然主人在群里发一张图,BN 回一张莫名其妙的卡。
	if (!hasCard && !HAS_LINK.test(text)) return null;

	// 空的那格不带上去:群消息是这条桥最大的一股流量,而缺省与「这条没有那种卡」同义。
	return {
		scope: "group",
		groupId,
		userId,
		text,
		...(cardLinks.length > 0 ? { cardLinks } : {}),
		...(miniAppCardLinks.length > 0 ? { miniAppCardLinks } : {}),
	};
}
