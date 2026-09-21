/**
 * 连 BN 的那条长连接 —— 协议 §12「最小实现清单」里除「真的连得上」之外的每一条。
 *
 * socket 是**注入口**:生产里由 `index.ts` 交进来 koishi 的 `ctx.http.ws`(它认
 * `Authorization` 头,而且 ctx 收摊时自己会 close)。这一层只管帧与时序。
 *
 * 两条写死在协议里的纪律:
 * - **不认识的帧忽略**,别断连 —— 那是让两端各自演进的唯一出路。
 * - **收到 `send` 一定回执**,哪怕发失败、哪怕投递里抛了异常。不回的话 BN 只能等到超时,
 *   而那 30 秒里主人看到的是「推送卡着不动」,比一条明确的失败难查得多。
 */

import {
	BRIDGE_PLUGIN_BUG_CLOSE_CODES,
	BRIDGE_PROTOCOL_VERSION,
	BRIDGE_TERMINAL_CLOSE_CODES,
	type BridgeBotWire,
	type BridgeInboundMessage,
	type BridgeInboundSubscription,
	type BridgeSendFrame,
	type BridgeToServerFrame,
	clipErr,
	reasonOf,
	type ServerToBridgeFrame,
} from "./protocol";

/** koishi 的 `ctx.http.ws()` 回的就是这个形状(DOM 那一套)。 */
export interface SocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, fn: (ev: never) => void): void;
}

export interface BridgeClientOptions {
	/** 开一条新 socket。**每次重连都会叫**,所以别在外面缓存。 */
	open(): SocketLike;
	/** 连的是哪儿 —— 只进日志。连不上时「地址是什么」往往就是答案。 */
	url: string;
	/** 握手那一刻的全量 bot 名单 —— 现取,重连时报的是最新那份。 */
	bots(): BridgeBotWire[];
	/** 这个插件的版本,报给 BN 排障用。 */
	version: string;
	/** 把一条 `send` 真发出去。**永远不该抛** —— 抛了也会被接住并回一条失败回执。 */
	deliver(frame: BridgeSendFrame): Promise<{ ok: boolean; err?: string }>;
	/** BN 说它要什么入站消息。每次握手都会重新下发。 */
	onWelcome(subscription: BridgeInboundSubscription): void;
	/**
	 * 这条 socket 没了(断开 / 被看门狗踢掉),**一条连接只叫一次**。收摊不叫 —— 那是我们
	 * 自己走的,宿主整个都在拆。宿主拿它把上一条连接的入站订阅收回去:不收的话下一次握手
	 * 之前,群里的消息还照着一份作废的订阅往外驮。
	 */
	onDisconnect?(): void;
	log: { info(message: string): void; warn(message: string): void };
	/** 第 n 次重连等多久。默认 0.5s 起翻倍、封顶 30s。 */
	backoff?(attempt: number): number;
	/** 排一个定时器,回一个取消函数。生产里交进来的是 koishi 的 `ctx.setTimeout`。 */
	later(fn: () => void, ms: number): () => void;
}

export interface BridgeClient {
	/** 名单变了,推一份**全量快照**上去。没连上就只记着,握手时随 hello 报。 */
	pushBots(bots: BridgeBotWire[]): void;
	/** 驮一条入站消息上去。没连上就丢掉 —— 协议不补发。 */
	pushInbound(botId: string, platform: string, message: BridgeInboundMessage): void;
	connected(): boolean;
	dispose(): void;
}

/**
 * upgrade 被拒时,`ws` 只把状态码写进 error 事件那句话里(`unexpected-response` 要单独
 * 监听才有,而 koishi 交回来的是 DOM 那一套)。所以只能从这句话里捞。
 */
const REFUSED = /Unexpected server response:\s*(\d{3})/;

/** 从 error 事件里把**人能看懂的那句话**捞出来。吞掉它等于让人对着连不上的 BN 猜。 */
function eventReasonOf(event: unknown): string {
	const ev = event as { message?: unknown; error?: { message?: unknown } } | undefined;
	const message = typeof ev?.message === "string" ? ev.message : undefined;
	const inner = typeof ev?.error?.message === "string" ? ev.error.message : undefined;
	return message ?? inner ?? "不知道为什么";
}

/**
 * upgrade 被这个状态码拒了之后,还要不要重连(协议 §2)。
 *
 * **只有 401 是「别再试了」** —— token 不对 / 已吊销,再试一万次也一样,该把错显示给用户。
 * 404(这台 BN 上眼下没有桥在跑)与 503(这条接入被停用了)都是拨一下开关就好的暂时状态。
 *
 * 🔴 这一档**照 close code 判不出来**:upgrade 被拒时 close code 是 1006,和网线松了长得
 * 一模一样。漏了它的症状是「token 填错 → koishi 永远捶 BN」,而屏幕上什么有用的都没有。
 */
function shouldReconnectAfterHttp(status: number): boolean {
	return status !== 401;
}

/** 投递那头没说为什么时回的那句。 */
const NO_REASON = "发不出去(投递那头没说为什么)";

/**
 * 回执里的那句原因 —— **只在这儿截一次**(`clipErr` 不幂等),投递回来的、抛出来的都走它:
 * 一句异常原文就能撑爆 BN 的单帧上限、把桥打断线。
 *
 * 🔴 空串当「没说原因」:`??` 拦不住空串,回执里一个空的 `err` 等于连「不知道为什么」都没说。
 * 不是字符串的也一样 —— BN 那头 `err` 是 `string | 缺省`,回个别的就是畸形帧 → 4003。
 */
function resultErrOf(err: unknown): string {
	return clipErr(typeof err === "string" && err.trim() !== "" ? err : NO_REASON);
}

function bridgeBackoffMs(attempt: number): number {
	return Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
}

/**
 * 多久没听见 BN 说一个字,就当这条连接已经死了。
 *
 * 🔴 **「连着」不等于「通着」**:NAT、家宽、睡着的路由器会把一条闲着的 TCP 静默掐断 ——
 * 两头都不发 FIN,`close` 事件永远不来。不自己看表的话 `connected()` 恒为 true:插件以为
 * 自己在岗,而 BN 那头 90 秒后早把会话清了 —— 推送全部失败,koishi 的日志里一个字都没有。
 *
 * 判据是**「最近听见过任何帧」**而不是「回过 pong」:BN 每 30 秒催一声,名单、回执、入站
 * 一样算它说过话。给三个心跳的宽限 —— 偶尔慢一发不该把一条好连接踢掉。
 */
export const BRIDGE_SILENCE_LIMIT_MS = 90_000;

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
	const backoff = opts.backoff ?? bridgeBackoffMs;
	let socket: SocketLike | undefined;
	let shook = false;
	let disposed = false;
	let attempt = 0;
	let cancelRetry: (() => void) | undefined;
	/** 一条 socket 只安排一次重连:`error` 与 `close` 往往接连来。 */
	let scheduled = false;
	/** 这一轮的 upgrade 被哪个状态码拒了 —— close 那头据它决定要不要回去。 */
	let refusedBy: number | undefined;
	/** 眼下排着的那只看门狗。收到任何帧就撤了重排 —— 一次只该有一只。 */
	let cancelWatchdog: (() => void) | undefined;
	/**
	 * 这条连接上**最后真发出去过**的那份名单(序列化后的样子)。
	 *
	 * 🔴 koishi 的 `login-updated` 每一次状态翻转都响,而 bot 的线上形状里**没有状态那一格** ——
	 * 一个连不上的 bot 抖一分钟,就是十几份一模一样的 KB 级帧。名单是全量快照,一样的那份
	 * 再推一遍一个字的新消息都没有。
	 */
	let sentBots: string | undefined;

	/**
	 * 重新计时。**收到任何帧都叫一次** —— 判据是「听见过」,不是「回过 pong」。
	 * 排的是一发定时器而不是轮询:省一次 `Date.now()` 比较,也省掉「多久查一次」那个参数。
	 */
	function armWatchdog(): void {
		cancelWatchdog?.();
		cancelWatchdog = opts.later(onSilence, BRIDGE_SILENCE_LIMIT_MS);
	}

	function clearWatchdog(): void {
		cancelWatchdog?.();
		cancelWatchdog = undefined;
	}

	/**
	 * 到点了还没听见 BN 说话 —— 当它断了。
	 *
	 * **先把 `socket` 摘掉再关**:`close()` 在一条已经死掉的 TCP 上要等到 `ws` 自己的关闭
	 * 超时(默认 30 秒)才会真的触发 `close` 事件,而那时我们早就连回去了。摘掉之后那条
	 * 迟到的事件认不出自己是「当前这条」,于是不会再安排第二次重连。
	 */
	function onSilence(): void {
		cancelWatchdog = undefined;
		if (disposed || !socket) return;
		const dead = socket;
		socket = undefined;
		shook = false;
		// 说清楚是哪一种断:这一下和网线松了长得一模一样,不说没人查得出来。
		opts.log.warn(`BN ${BRIDGE_SILENCE_LIMIT_MS}ms 没说过话(心跳也没了),当它断了`);
		try {
			dead.close(1000, "no frames from bilibili-notify");
		} catch {
			// 已经没了
		}
		// 这一路也是「连丢了」—— 对宿主来说和收到一个 close 没有区别。
		opts.onDisconnect?.();
		retry("静默超时");
	}

	/**
	 * 往**指定的**那条 socket 上写一帧。序列化只此一处 —— 手抄的第二处迟早跟这儿说的不是
	 * 一回事(比如哪天要加个长度上限、或者换成压缩帧)。
	 *
	 * 收 socket 而不是读闭包里那个:hello 与 pong 都只该写在「触发它的那条」连接上。
	 */
	function write(target: SocketLike, frame: BridgeToServerFrame): void {
		target.send(JSON.stringify(frame));
	}

	/** 过一道「连着且握过手」的闸再写。业务帧一律走这儿。 */
	function send(frame: BridgeToServerFrame): boolean {
		if (!socket || !shook) return false;
		write(socket, frame);
		return true;
	}

	function retry(why: string): void {
		if (disposed || scheduled) return;
		scheduled = true;
		const wait = backoff(attempt);
		attempt += 1;
		opts.log.info(`${why},${wait}ms 后重连(第 ${attempt} 次)`);
		cancelRetry = opts.later(connect, wait);
	}

	async function onSend(frame: BridgeSendFrame): Promise<void> {
		let outcome: { ok: boolean; err?: string };
		try {
			outcome = await opts.deliver(frame);
		} catch (err) {
			// 抛了也得回执 —— 见文件头那条。
			outcome = { ok: false, err: reasonOf(err) };
		}
		// 走 `send()` 那道「连着且握过手才发」的闸 —— 投递要花时间(下图、签卡),回到这儿
		// 时连接可能早没了。自己手写一遍那道判断,它迟早和 `send()` 说的不是一回事。
		send(
			outcome.ok
				? { type: "result", id: frame.id, ok: true }
				: { type: "result", id: frame.id, ok: false, err: resultErrOf(outcome.err) },
		);
	}

	function onFrame(target: SocketLike, frame: ServerToBridgeFrame): void {
		switch (frame.type) {
			case "welcome": {
				shook = true;
				// 握完手才算连通,退避从头数 —— 按「socket 开了」算的话,一个连上就被踢的
				// 循环会一直用最短那档去捶 BN。
				attempt = 0;
				opts.log.info(`已连上 bilibili-notify v${frame.server?.version ?? "?"}`);
				opts.onWelcome(frame.inbound);
				break;
			}
			case "ping":
				// 绕开 `send()` 那道握手闸:ping 是 BN 在问「你还在吗」,而「还没 welcome」
				// 恰恰是最该老实回一声的时候 —— 咽下去只会被当成死了。
				// id 原样抄回去。1.3 起 BN 每一发 ping 都带它(心跳那些也带)—— 不抄的话
				// 面板那颗「测试」配不上这一趟,只会如实超时。
				write(target, typeof frame.id === "string" ? { type: "pong", id: frame.id } : { type: "pong" });
				break;
			case "send":
				void onSend(frame);
				break;
			case "error":
				opts.log.warn(`BN 报了个错:${String(frame.message)}`);
				break;
			// 不认识的一律忽略。
		}
	}

	function connect(): void {
		if (disposed) return;
		scheduled = false;
		shook = false;
		refusedBy = undefined;
		// 新的一条连接什么都不知道,hello 自己会报全量名单 —— 去重的记忆跟着清空,不然
		// 上一条连接上发过的那份会把这一条的第一次推送咽掉。
		sentBots = undefined;
		let next: SocketLike;
		try {
			next = opts.open();
		} catch (err) {
			/**
			 * 🔴 地址少个 `ws://` 这种,`ctx.http.ws` 是**当场抛**(`Invalid URL`),不是回一条
			 * 连不上的 socket。不接住的话:这一轮没有 socket、`scheduled` 又刚被清掉,没人再
			 * 安排重连 —— 插件从此彻底不动;而且从重连定时器里抛出去的那一发没人接得住。
			 */
			socket = undefined;
			opts.log.warn(`连不上 ${opts.url}:${eventReasonOf(err)}`);
			retry("开连接就抛了");
			return;
		}
		socket = next;
		// 连上之后 BN 迟迟不说话也算死 —— 「开着但一直没 welcome」与「半路被掐断」是同一种坏。
		armWatchdog();
		/**
		 * 这个事件是**当前这条** socket 发的吗。被看门狗摘掉的那条晚到的 close / error 会
		 * 拿着同一个回调回来,不认一下身份的话它能替刚建好的连接再安排一次重连。
		 */
		const mine = (): boolean => socket === next;
		next.addEventListener("open", () => {
			if (!mine()) return;
			// hello 是第一帧,所以它**故意**不走 `send()` —— 那道闸要求已握手,而握手正是
			// 这一帧要去换来的。写在 `next` 上而不是闭包里那个:意思是「这条连接的开场白」。
			write(next, {
				type: "hello",
				protocol: { ...BRIDGE_PROTOCOL_VERSION },
				bridge: { kind: "koishi", name: "koishi", version: opts.version },
				bots: opts.bots(),
			});
		});
		next.addEventListener("message", (ev: { data?: unknown }) => {
			/**
			 * 🔴 收摊之后还会落进来帧(关闭握手那几十毫秒)。`disposed` 不挡的话:`armWatchdog()`
			 * 是往 koishi 一只已经失效的 scope 上排定时器(`ctx.setTimeout` 直接抛
			 * `INACTIVE_EFFECT`),而那一帧 `send` 还会被真投递出去 —— 插件都卸载了还在发消息。
			 */
			if (disposed || !mine()) return;
			// 听见了就重新计时 —— 认不认得这一帧不重要,它说话了就算活着。
			armWatchdog();
			let frame: unknown;
			try {
				frame = JSON.parse(String(ev?.data ?? ""));
			} catch {
				opts.log.warn("BN 发来一帧不是 JSON 的东西,忽略");
				return;
			}
			// `null` 与 `123` 都是合法 JSON,但都不是帧。不挡的话下一步读 `.type` 当场抛在 ws
			// 的回调里 —— 那儿没人接得住,整个 koishi 吃一发 uncaughtException。
			if (typeof frame !== "object" || frame === null) {
				opts.log.warn(`BN 发来的这一帧不是对象(${frame === null ? "null" : typeof frame}),忽略`);
				return;
			}
			// 这一步是**唯一**的信任边界:线上下来的东西到此为止按帧看待,形状不对的照协议
			// §11 忽略(而不是断连)。再往里就不用一路 `as` 了。
			onFrame(next, frame as ServerToBridgeFrame);
		});
		next.addEventListener("close", (ev: { code?: number }) => {
			if (!mine()) return;
			clearWatchdog();
			shook = false;
			// 连丢了就叫一声 —— 重不重连是下面的事,订阅这会儿已经作废了。
			opts.onDisconnect?.();
			const code = ev?.code ?? 1006;
			// upgrade 被拒那一路先判:那时 close code 是 1006,和网线松了分不出来。
			if (refusedBy !== undefined && !shouldReconnectAfterHttp(refusedBy)) {
				opts.log.warn(`BN 回了 ${refusedBy}:token 不对或已吊销,不重连了 —— 去 BN 拓展页对一下`);
				return;
			}
			if (BRIDGE_TERMINAL_CLOSE_CODES.includes(code)) {
				// 再试一次也是同样的结果。但**赖谁**得分清:让人去翻一份没毛病的配置,
				// 比不说还费时间 —— 这两档他该做的是把这行贴成一个 issue。
				opts.log.warn(
					BRIDGE_PLUGIN_BUG_CLOSE_CODES.includes(code)
						? `BN 断开了这条连接(${code}):${code === 4003 ? "我们发的帧形状不对" : "我们没能按时握手"} —— 这是插件自己的 bug,烦请拿这行去提个 issue`
						: `BN 断开了这条连接(${code}):这是配置那头的事,不重连`,
				);
				return;
			}
			retry(`断了(${code})`);
		});
		next.addEventListener("error", (ev: never) => {
			if (!mine()) return;
			const reason = eventReasonOf(ev);
			const status = REFUSED.exec(reason)?.[1];
			if (status) refusedBy = Number(status);
			// 🔴 **把原因说出来**。这一句是主人手里唯一的线索:连不上时它就是全部。
			// 握手前后是两回事:一条**跑着的**连接上报错还说「连不上 <地址>」,是把人往地址 /
			// 防火墙那头带 —— 而那地址明明刚刚还通着,真正的原因在后半句里。
			opts.log.warn(shook ? `连接出错:${reason}` : `连不上 ${opts.url}:${reason}`);
		});
	}

	connect();

	return {
		connected: () => shook,
		pushBots(bots) {
			const snapshot = JSON.stringify(bots);
			if (snapshot === sentBots) return;
			// 没连上就不发 —— 名单是现取的,握手那一刻自然报的就是最新那份。发成了才记:
			// 没发出去的那次要是也记下,连上之后第一份真名单就被自己咽了。
			if (send({ type: "bots", bots })) sentBots = snapshot;
		},
		pushInbound(botId, platform, message) {
			// 协议不补发:推一条三小时前的消息比不推更糟。
			send({ type: "inbound", botId, platform, message });
		},
		dispose() {
			disposed = true;
			cancelRetry?.();
			// 看门狗也得收摊,不然 koishi 卸载插件之后它还会醒一次。
			clearWatchdog();
			// **先摘再关**:`close()` 只是开了个关闭握手,socket 还要活几十毫秒。摘掉之后
			// `connected()` 当场说实话,一条还在路上的投递回到 `send()` 时也不会再往这条
			// 正在关的 socket 上写(`mine()` 同时失效 —— 那声 close 不会被当成「连丢了」)。
			const dying = socket;
			socket = undefined;
			shook = false;
			try {
				dying?.close(1000, "plugin disposed");
			} catch {
				// 已经没了
			}
		},
	};
}
