/**
 * 「这个 bot 现在该不该探一次签卡口」—— 只有这一个决策,单独一个文件是为了**测得着**
 * (`index.ts` 引 koishi,而 koishi 的 ESM 产物在纯 Node 下加载即炸,测试进不去)。
 *
 * 🔴 探本身是一行 API 调用,难的是**时机**:satori 派 `login-added` 在 `bot.start()`
 * **之前**,而 `koishi-plugin-adapter-onebot` 要等自己那条 WS 连上才给 `internal._request`
 * (断开时还会删掉)。所以冷启动那一发必然被拒 —— 读出来是「还不知道」、什么都记不下。
 * 结论:**问出结论之前一直问**(bot 上线会派 `login-updated`),问出来之后不再问。
 */

import type { BridgeCapabilityState } from "./protocol";

/** 探之前只看得见这两格 —— `internal._get` 在不在是运行时的事,由调用方自己判。 */
export interface ProbeCandidate {
	platform?: string;
	selfId?: string;
}

export function shouldProbe(
	bot: ProbeCandidate,
	/** 这个 bot 眼下记着的那一格;`undefined` = 一次都没探过。 */
	remembered: BridgeCapabilityState | undefined,
	/** 上一发探还没回来。 */
	probing: boolean,
): boolean {
	// 六项里**只有这一项探得出来**,而且只有 QQ 家有小程序卡这回事 —— 别家探等于白发一个
	// 必失败的调用。
	if (bot.platform !== "onebot") return false;
	// 还没登上的拼不出 `botId`,探到的结果记不到任何人头上。
	if (!bot.selfId) return false;
	// 问出结论的不再问:这一格一旦有了答案就不会再变(换了实现要重启插件)。
	if (remembered === "supported" || remembered === "unsupported") return false;
	// 冷启动那几秒里三个口(启动扫一遍、`login-added`、`login-updated`)会挨个叫到同一个
	// bot;上一发还没回来就再发一次,是白白多打一次腾讯。
	return !probing;
}
