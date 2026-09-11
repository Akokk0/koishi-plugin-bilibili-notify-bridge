/**
 * 桥接协议 v1 的 wire 契约 —— **这一份是插件自己的**。
 *
 * 它是照 BN 那侧的 `extensions/bridge/PROTOCOL.md` 抄的:这个插件独立发版、装在别人的
 * koishi 里,不可能依赖 BN 的任何包。协议本身就是为此设计的 —— 两端各持一份、靠版本号
 * 与「不认识就忽略」的纪律各自演进。
 *
 * 🔴 **抄的东西会漂,而这一侧没有自动守卫**(插件跑不起一台 BN)。协议给的兜底是:
 * `major` 对不上 BN **不发 welcome、直接断连 4002** —— 所以漂了的症状是「连不上并给了
 * 一个明确的码」,不是「连上了但行为诡异」。改这个文件之前先对一遍那份 PROTOCOL.md。
 */

/** 判定只看 `major`。加可选字段 / 加帧类型只升 minor;改字段含义或删字段才升 major。 */
export const BRIDGE_PROTOCOL_VERSION = { major: 1, minor: 4 } as const;

/** 这个桥**必报**的六项能力(协议 §7)。 */
export const BRIDGE_CAPABILITIES = [
	"atAll",
	"inbound",
	"forward",
	"miniAppCard",
	"shareCardLinks",
	"markdown",
] as const;
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

/** 三态,不是布尔 —— 「不支持」是结论,「还不知道」是「试试看,可能行」。 */
export type BridgeCapabilityState = "supported" | "unsupported" | "unknown";
export type BridgeCapabilityReport = Record<BridgeCapability, BridgeCapabilityState>;

/** 借给 BN 的一个 bot。`botId` 只要求在这条连接内唯一;`platform` 是开放词表。 */
export interface BridgeBotWire {
	botId: string;
	platform: string;
	name?: string;
	/** 仅用于显示,别拿去当身份比对。 */
	selfId?: string;
	/** 平台图标,`data:image/…;base64,` 的 data URL,≤ 32 KB;BN 拿它画 bot 那一行的方块。 */
	icon?: string;
	capabilities?: Record<string, string>;
}

export type BridgeSegment =
	| { type: "text"; text: string }
	| { type: "image"; url: string; mime: string }
	| { type: "link"; href: string; title?: string }
	| { type: "at-all" };

export type BridgeMessage =
	| { kind: "text"; text: string }
	| { kind: "image"; url: string; mime: string; caption?: string }
	| { kind: "composite"; segments: BridgeSegment[] }
	/** `forward: true` 要 `forward` 能力;做不到就自己降级成多张图,**别整条丢**。 */
	| {
			kind: "forward-images";
			images: { url: string; width?: number; height?: number }[];
			forward: boolean;
	  }
	| {
			kind: "miniapp-card";
			title: string;
			desc: string;
			picUrl: string;
			/** 小程序**页面路径**,不是网页链接。 */
			path: string;
			/** 网页链接。签不了 ark 时降级成文字只用它。 */
			jumpUrl: string;
	  };

export type BridgeInboundMessage =
	/** 私聊**只有正文**:BN 的私聊入口只有指令,指令不认链接。 */
	| { scope: "private"; userId: string; text: string }
	| {
			scope: "group";
			groupId: string;
			userId: string;
			/** 用户敲的那句话,**只是那句话** —— 卡里的链接放下面两格,别拼进来。 */
			text: string;
			/** 1.4 起:普通分享卡里的链接。BN 跟正文里的链接一样解析。 */
			cardLinks?: string[];
			/**
			 * 1.4 起:**B 站小程序卡**(`com.tencent.miniapp_01`)里的链接。BN 读得出这一格
			 * 就**不会回卡** —— 群里已经有一张能点开播放的了。混进 `cardLinks` 就等于让它再回一张。
			 */
			miniAppCardLinks?: string[];
	  };

/** BN 要什么入站消息。桥在**自己这侧**过滤,省的是带宽与隐私。 */
export interface BridgeInboundSubscription {
	private: boolean;
	group: "none" | "with-links";
}

export interface BridgeSendFrame {
	type: "send";
	id: string;
	botId: string;
	platform: string;
	target: { scope: "private" | "group" | string; address: string; parentAddress?: string };
	message: BridgeMessage;
}

export interface BridgeWelcomeFrame {
	type: "welcome";
	protocol: { major: number; minor: number };
	server: { version: string };
	inbound: BridgeInboundSubscription;
}

export type ServerToBridgeFrame =
	| BridgeWelcomeFrame
	| BridgeSendFrame
	/** 1.3 起可选 `id`:带了就是面板在探活,`pong` 要原样回它。 */
	| { type: "ping"; id?: string }
	| { type: "error"; message: string };

export type BridgeToServerFrame =
	| {
			type: "hello";
			protocol: { major: number; minor: number };
			bridge: { kind: "koishi"; name?: string; version?: string };
			bots: BridgeBotWire[];
	  }
	| { type: "bots"; bots: BridgeBotWire[] }
	| { type: "inbound"; botId: string; platform: string; message: BridgeInboundMessage }
	| { type: "result"; id: string; ok: boolean; err?: string }
	| { type: "pong"; id?: string };

/**
 * BN 主动断连时给的码。**这几档别重连** —— 再试一次也是同样的结果,该把错显示给用户:
 * 4001 token 不对 / 4002 协议 major 对不上 / 4003 我们发了畸形帧 / 4004 没按时握手 /
 * 4005 这条接入被删了 / 4006 同 token 又连进来一条(新的赢)。
 *
 * ⚠️ **4007(这条接入被停用了)与其余一切都要退避重连** —— 用户把开关拨回来就该自己回去。
 */
export const BRIDGE_TERMINAL_CLOSE_CODES: readonly number[] = [4001, 4002, 4003, 4004, 4005, 4006];
