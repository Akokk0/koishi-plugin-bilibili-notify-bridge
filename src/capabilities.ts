/**
 * 这个桥**能替某个平台做到什么** —— 握手时逐 bot 报给 BN(协议 §7)。
 *
 * 🔴 **硬编,不是探测**:koishi 的 `bot.supports()` 粒度是 Satori 的 **API 方法**,而 @全体 /
 * 合并转发是**消息元素**;适配器碰到不认识的元素**静默丢弃、不抛错**,连 try/catch 都探不出。
 *
 * ⚠️ 所以**每一格都要有依据**,拿不准的一律 `unknown`。报错一格的代价是不对称的:
 * 谎报 `supported` 的症状是「@全体没生效而且一声不响」,而 `unknown` 只是让面板显示
 * 「还不知道」—— BN 照样会试。
 */

import type { BridgeCapabilityReport, BridgeCapabilityState } from "./protocol";

/**
 * @全体:**查过那个平台适配器的消息编码器**才写进来。
 *
 * - `onebot` —— `attrs.type === "all"` → `[CQ:at,qq=all]`(`koishi-plugin-adapter-onebot`)
 * - `discord` —— `attrs.type === "all"` → `@everyone`
 * - `kook` —— `attrs.type === "all"` → `(met)all(met)`
 * - `telegram` / `qq` —— 编码器里**根本没有 at-all 这一支**,元素会被静默丢掉
 *
 * 没列进来的(lark、slack……)按 `unknown` 走 —— 不是它们做不到,是**我们没查过**。
 * 加一行之前先去翻那个适配器的编码器。
 */
const AT_ALL: Record<string, BridgeCapabilityState> = {
	onebot: "supported",
	discord: "supported",
	kook: "supported",
	telegram: "unsupported",
	qq: "unsupported",
};

/**
 * 合并转发(「聊天记录」卡)。
 *
 * 🔴 判据是「那家的 `<figure>` **是不是真的合并转发卡**」,不是「有没有 figure 这一支」:
 *
 * - `onebot` —— `<figure>` 走 `send_group_forward_msg`,**真·聊天记录卡**
 * - `discord` / `telegram` —— 有 `figure`,但那是**换个头像分条发**(webhook 那套),
 *   不是一张卡。报支持的话主人会以为群里收到的是合并转发,实际是刷屏
 * - `kook` / `qq` —— 编码器里没有这一支
 */
const FORWARD: Record<string, BridgeCapabilityState> = {
	onebot: "supported",
	discord: "unsupported",
	telegram: "unsupported",
	kook: "unsupported",
	qq: "unsupported",
};

export function capabilitiesFor(
	platform: string,
	/**
	 * 探出来的那一格,盖在表上面。**只有小程序卡这一项**:六项里只有它探得出来,别的
	 * 全是硬编的(见上面那段)。
	 */
	probedMiniAppCard?: BridgeCapabilityState,
): BridgeCapabilityReport {
	// 🔴 **六格全写在这儿**,别退回「先整张填 unknown、再逐格盖」那种写法:那个循环填的值
	// 一格都活不下来(下面每格都盖了),真正的代价是它**顶掉了编译器**—— 加第七项能力时
	// 漏掉的那一格会静默变成「还不知道」,而 BN 那头「还不知道」的意思是「试试看」。
	// 写成字面量(不带 `as`),漏一格当场红。
	const report: BridgeCapabilityReport = {
		atAll: AT_ALL[platform] ?? "unknown",
		// 入站恒真:这个桥自己就在把消息转回去,与平台无关。
		inbound: "supported",
		// 🔴 markdown 恒假:这个桥不做 markdown → koishi 元素的转换,而 satori 的 discord
		// 适配器还会把 markdown 字符**转义掉**。报支持的话群里收到的是一堆反斜杠;报不支持
		// BN 会在它那侧剥成干净纯文本。
		markdown: "unsupported",
		forward: FORWARD[platform] ?? "unknown",
		// 分享卡里的链接:桥自己解得动就成立 —— 只有 QQ 家有 json / xml 卡这回事,不用问对面。
		// ⚠️ `supported` 的前提是那个 OneBot 实现**上报数组格式的消息段**;退回字符串格式的
		// CQ 码时,卡的 payload 在上报那一步就没了,我们解个空。
		shareCardLinks: platform === "onebot" ? "supported" : "unsupported",
		// 小程序卡:**只有 QQ 家有**(要向腾讯签 ark),别家压根没有这回事。
		// 🔴 onebot 那一档没探之前是 `unknown` 而不是 `unsupported`,刻意的 —— 它是六项里
		// **唯一探得出来的**(`get_mini_app_ark` 是个 API 调用,失败带 retcode;而 @全体那些
		// 是消息元素,适配器碰到不认识的静默丢弃,连 try/catch 都探不出)。探之前如实说不知道。
		miniAppCard: probedMiniAppCard ?? (platform === "onebot" ? "unknown" : "unsupported"),
	};
	return report;
}
