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
	BRIDGE_PROTOCOL_VERSION,
	BRIDGE_TERMINAL_CLOSE_CODES,
	type BridgeBotWire,
	type BridgeInboundMessage,
	type BridgeInboundSubscription,
	type BridgeSendFrame,
	type BridgeToServerFrame,
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
export function reasonOf(event: unknown): string {
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
export function shouldReconnectAfterHttp(status: number): boolean {
	return status !== 401;
}

export function bridgeBackoffMs(attempt: number): number {
	return Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
}

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

	function send(frame: BridgeToServerFrame): boolean {
		if (!socket || !shook) return false;
		socket.send(JSON.stringify(frame));
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
			outcome = { ok: false, err: (err as Error).message };
		}
		if (!socket || !shook) return;
		socket.send(
			JSON.stringify(
				outcome.ok
					? { type: "result", id: frame.id, ok: true }
					: { type: "result", id: frame.id, ok: false, err: outcome.err ?? "发不出去" },
			),
		);
	}

	function onFrame(frame: Record<string, unknown>): void {
		switch (frame.type) {
			case "welcome": {
				shook = true;
				// 握完手才算连通,退避从头数 —— 按「socket 开了」算的话,一个连上就被踢的
				// 循环会一直用最短那档去捶 BN。
				attempt = 0;
				const server = frame.server as { version?: string } | undefined;
				opts.log.info(`已连上 bilibili-notify v${server?.version ?? "?"}`);
				opts.onWelcome(frame.inbound as BridgeInboundSubscription);
				break;
			}
			case "ping":
				// 带 id 的是面板在探活(量往返),原样回;心跳的不带。
				socket?.send(
					JSON.stringify(typeof frame.id === "string" ? { type: "pong", id: frame.id } : { type: "pong" }),
				);
				break;
			case "send":
				void onSend(frame as unknown as BridgeSendFrame);
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
		const next = opts.open();
		socket = next;
		next.addEventListener("open", () => {
			// hello 是第一帧,而它自己不经过 `send()`(那道闸要求已握手)。
			next.send(
				JSON.stringify({
					type: "hello",
					protocol: { ...BRIDGE_PROTOCOL_VERSION },
					bridge: { kind: "koishi", name: "koishi", version: opts.version },
					bots: opts.bots(),
				}),
			);
		});
		next.addEventListener("message", (ev: { data?: unknown }) => {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(String(ev?.data ?? "")) as Record<string, unknown>;
			} catch {
				opts.log.warn("BN 发来一帧不是 JSON 的东西,忽略");
				return;
			}
			onFrame(frame);
		});
		next.addEventListener("close", (ev: { code?: number }) => {
			shook = false;
			const code = ev?.code ?? 1006;
			// upgrade 被拒那一路先判:那时 close code 是 1006,和网线松了分不出来。
			if (refusedBy !== undefined && !shouldReconnectAfterHttp(refusedBy)) {
				opts.log.warn(`BN 回了 ${refusedBy}:token 不对或已吊销,不重连了 —— 去 BN 拓展页对一下`);
				return;
			}
			if (BRIDGE_TERMINAL_CLOSE_CODES.includes(code)) {
				// 再试一次也是同样的结果 —— 该把错显示给用户,而不是拿同样的 token 去捶 BN。
				opts.log.warn(`BN 断开了这条连接(${code}):这是配置那头的事,不重连`);
				return;
			}
			retry(`断了(${code})`);
		});
		next.addEventListener("error", (ev: never) => {
			const reason = reasonOf(ev);
			const status = REFUSED.exec(reason)?.[1];
			if (status) refusedBy = Number(status);
			// 🔴 **把原因说出来**。这一句是主人手里唯一的线索:连不上时它就是全部。
			opts.log.warn(`连不上 ${opts.url}:${reason}`);
		});
	}

	connect();

	return {
		connected: () => shook,
		pushBots(bots) {
			// 没连上就不发 —— 名单是现取的,握手那一刻自然报的就是最新那份。
			send({ type: "bots", bots });
		},
		pushInbound(botId, platform, message) {
			// 协议不补发:推一条三小时前的消息比不推更糟。
			send({ type: "inbound", botId, platform, message });
		},
		dispose() {
			disposed = true;
			cancelRetry?.();
			try {
				socket?.close(1000, "plugin disposed");
			} catch {
				// 已经没了
			}
		},
	};
}
