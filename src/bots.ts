/**
 * koishi 的 bot → 报给 BN 的那份名单。
 *
 * 名单是**全量快照**(协议 §5.2):握手带一份,之后每次变了整份重推。BN 拿 `botId`
 * 回指「用哪个 bot 发」,所以那个 id 必须在这条连接内唯一且稳定 —— `平台:账号` 两样
 * koishi 都保证。
 */

import { capabilitiesFor } from "./capabilities";
import { PLATFORM_ICONS } from "./platform-icons";
import { type BridgeBotWire, type BridgeCapabilityState, idOf } from "./protocol";

/**
 * 只依赖这几格 —— 写全 koishi 的 `Bot` 等于把整个框架的形状焊进 wire 层。
 *
 * ⚠️ `platform` / `selfId` 在 koishi 里**是可选的**(bot 刚建、还没登上时两格都空)。
 * 少了任一格的借不出去:`botId` 拼不出来,BN 那头的推送目标也就指不着它。
 *
 * 🔴 写成 `unknown` 是故意的:类型说是 `string`,可第三方适配器塞个数字的账号、一个不是
 * 字符串的昵称进来 koishi 也照收。原样报上去,整帧 hello / bots 就是畸形帧(BN 那头这几格
 * 都是 `z.string()`)→ close 4003 → 插件当终局永不重连。
 */
export interface KoishiBotLike {
	platform?: unknown;
	selfId?: unknown;
	user?: { name?: unknown };
}

/**
 * 探出来的那一格(签不签得了小程序卡),按 bot 查;`undefined` = 还没探过。
 *
 * **按 bot 而不是按平台** —— 同一台 koishi 上两个 QQ 号,一个接的实现签得了小程序卡、
 * 另一个签不了,这是真会发生的。
 *
 * 🔴 六项里**只有这一项探得出来**,所以这里就写死成一格:写成「一份能力表补丁」的话,
 * 调用方递进来的别的格会被静默丢掉(报的和真发时按的就成了两回事)。
 */
export type ProbedMiniAppCard = (botId: string) => BridgeCapabilityState | undefined;

/**
 * `botId` —— koishi 自己也叫它 `sid`。平台 + 账号,一条连接内不会撞。
 *
 * 报名单、探能力、收到 `send` 时回查 bot、驮入站消息时说「这是谁收到的」,全都得拼出**同一个**
 * 串;手拼一遍就是一次赌博,而拼歪了的症状是「BN 那边配好的推送目标忽然发不出去」。
 * 没登上的 bot(两格里缺任一格)拼出来的东西不会跟任何真 id 相等 —— 调用方要么先挡掉,
 * 要么就靠这一点。
 */
export function sidOf(bot: { platform?: string; selfId?: string }): string {
	return `${bot.platform}:${bot.selfId}`;
}

export function botsOf(
	bots: readonly KoishiBotLike[],
	probed?: ProbedMiniAppCard,
): BridgeBotWire[] {
	return bots.flatMap((bot) => {
		// 平台是个词表里的词,不是 id —— 只认非空字符串,不替它转。
		const platform = typeof bot.platform === "string" && bot.platform !== "" ? bot.platform : undefined;
		// 账号过的是和入站那头**同一道**归一(`idOf`):数字转成字符串,说不清的当没登上。
		// 拼出来的 `botId` 与 koishi 自己的 `sid`(模板字符串拼的)是同一个串 —— 回查靠的就是它。
		const selfId = idOf(bot.selfId);
		if (platform === undefined || selfId === undefined) return [];
		const botId = sidOf({ platform, selfId });
		const wire: BridgeBotWire = {
			botId,
			platform,
			selfId,
			capabilities: capabilitiesFor(platform, probed?.(botId)),
		};
		// 没有就不报这一格 —— 编一个「未命名」出来,面板上就再也分不出「没名字」和
		// 「真的叫未命名」。不是非空字符串的也不报(见 `KoishiBotLike`)。
		const name = bot.user?.name;
		if (typeof name === "string" && name !== "") wire.name = name;
		// 平台图标同理:没有的不报,BN 那头退回平台名的头两个字母。
		const icon = PLATFORM_ICONS[platform];
		if (icon) wire.icon = icon;
		return [wire];
	});
}
