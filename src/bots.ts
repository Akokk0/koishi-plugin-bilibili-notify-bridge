/**
 * koishi 的 bot → 报给 BN 的那份名单。
 *
 * 名单是**全量快照**(协议 §5.2):握手带一份,之后每次变了整份重推。BN 拿 `botId`
 * 回指「用哪个 bot 发」,所以那个 id 必须在这条连接内唯一且稳定 —— `平台:账号` 两样
 * koishi 都保证。
 */

import { capabilitiesFor } from "./capabilities";
import type { BridgeBotWire, BridgeCapabilityReport } from "./protocol";

/**
 * 只依赖这几格 —— 写全 koishi 的 `Bot` 等于把整个框架的形状焊进 wire 层。
 *
 * ⚠️ `platform` / `selfId` 在 koishi 里**是可选的**(bot 刚建、还没登上时两格都空)。
 * 少了任一格的借不出去:`botId` 拼不出来,BN 那头的推送目标也就指不着它。
 */
export interface KoishiBotLike {
	platform?: string;
	selfId?: string;
	user?: { name?: string };
}

/**
 * 探出来的能力,按 bot 查。**按 bot 而不是按平台** —— 同一台 koishi 上两个 QQ 号,
 * 一个接的实现签得了小程序卡、另一个签不了,这是真会发生的。
 */
export type ProbedCapabilities = (botId: string) => Partial<BridgeCapabilityReport> | undefined;

export function botsOf(
	bots: readonly KoishiBotLike[],
	probed?: ProbedCapabilities,
): BridgeBotWire[] {
	return bots.flatMap((bot) => {
		if (!bot.platform || !bot.selfId) return [];
		const wire: BridgeBotWire = {
			// koishi 自己也叫它 `sid`。平台 + 账号,一条连接内不会撞。
			botId: `${bot.platform}:${bot.selfId}`,
			platform: bot.platform,
			selfId: bot.selfId,
			capabilities: capabilitiesFor(bot.platform, probed?.(`${bot.platform}:${bot.selfId}`)),
		};
		// 没有就不报这一格 —— 编一个「未命名」出来,面板上就再也分不出「没名字」和
		// 「真的叫未命名」。
		if (bot.user?.name) wire.name = bot.user.name;
		return [wire];
	});
}
