/**
 * 把 BN 那条图 URL 取回来。
 *
 * 🔴 **图必须桥自己下载**(协议 §9):那条 URL 只保证桥自己可达 —— BN 常跑在 NAS 上,
 * 把它交给平台去拉是静默失败(消息到了、图没了、日志一个字都没有)。
 *
 * 所以这一步是**桥拿着 BN 递来的地址去访问网络**,而 BN 递什么完全由那条连接说了算。
 * 下面几道闸各自挡的是一种「照做了就出事」:
 *
 * 🔴 **只准 http / https**。koishi 的 `ctx.http.file()` 碰到 `file://` 走的是
 * `readFile(fileURLToPath(url))` —— 递一条 `file:///…/koishi.yml` 过来,桥就把宿主机的
 * 配置(里头有各平台的 token)当成一张图发进群。拿到了这条桥 token 的人(比如同一个内网
 * 里嗅探到的)因此白得一个**任意本地文件读取**;而现场看上去一切正常:发出去了、回执 ok。
 * 判在**发出任何请求之前**,而且**跳转的每一跳都判**。
 *
 * 🔴 **只替 BN 取它自己的图和公网上的图,每一跳都判**。桥跑在主人的内网里;不设限的话,递一条
 * `http://127.0.0.1:5140/…`(koishi 自己的控制台)、路由器后台、云主机的元数据口过来,桥就替它
 * 去敲了,再当成一张图发进群。协议 §9 本来就只有两种图:BN 的取图口(常在内网,放行,见
 * `blobOriginOf`)与 B 站 CDN 上原样透传的公网地址。所以取图口以外的地址,解析出来的**每一个**
 * 地址都得是公网的(见 `refuseUnlessBlobOrPublic`)。
 *
 * 🔴 **要有整趟的时限**。BN 最多等 30 秒(协议 §5.4),超了那条推送就按失败记账。一条没有超时的
 * 下载会让主人看到「推送卡着不动」—— 比一条明确的失败难查得多。时限连读 body 那段一起算。
 *
 * 🔴 **要有上限,边读边数**。图整个进内存、交给适配器时还要 base64 一遍(再涨三分之一)。没有
 * 上限就是一条「递一条大文件的地址过来即可把 koishi 打爆」的路;读完再判等于已经被打爆了。
 *
 * 🔴 **不走 koishi 的全局代理**(见 `DIRECT`)。
 *
 * 🔴 **2xx 不等于拿到了图**。BN 挂在一层要登录的反代后面时,取图口回的是一张 200 的登录页;
 * 照单全收就是群里一张裂图、回执还是 ok。Content-Type 明说不是图的拒;字节再按魔数认一遍,
 * 认不出的也拒(见 `imageMimeOf`)。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "./address";
import { reasonOf } from "./protocol";

/** 比 BN 那 30 秒的回执窗口短一截 —— 超时了还来得及回一句人话。 */
export const IMAGE_FETCH_TIMEOUT_MS = 20_000;
/** BN 出的卡再大也就几百 KB;16 MiB 是给「明显不对劲」留的门,不是给正常图留的余量。 */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * 逐请求关掉 koishi 的全局代理 —— 并进请求配置里用。
 *
 * 🔴 koishi 的 loader 会装 proxy-agent,之后**每个** `ctx.http` 请求(连 `ctx.http.ws` 那条
 * WebSocket 也是)都套全局代理:内网 BN 的地址被送进代理,要么连不上 / 取不到,要么一次性的
 * 取图 URL 泄露给代理。BN 的地址是用户直接填的,怎么连到它由这个地址说了算。
 *
 * 为什么是空串:proxy-agent 那头取的是 `config?.proxyAgent ?? 全局那个`,空串过得了 `??`、
 * 过不了紧跟着的那道 `if (!proxy) return` —— 于是这一个请求不挂代理。`undefined` 不行
 * (被 `??` 退回全局那个)。`http.file()` 那条口只收 `timeout`,传不下去,所以取图得走
 * `ctx.http()` 本身。
 */
export const DIRECT = { proxyAgent: "" } as const;

/** 取图那一趟交给 `ctx.http` 的配置。 */
export interface ImageRequestConfig {
	method: "GET";
	/** 🔴 要的是**流**:整个读完再比上限,等于已经被打爆了。 */
	responseType: "stream";
	/** `ctx.http` 自己那只超时 —— 只管到响应头回来为止,读 body 那段归 `signal`。 */
	timeout: number;
	/** 整趟(连读 body)的时限由这边自己看表,到点从这里掐。 */
	signal: AbortSignal;
	/**
	 * 状态码自己判。交给 plugin-http 判的话,它碰到 4xx / 5xx 会先把**整个**错误页读进内存
	 * (`defaultDecoder`)才抛 —— 这一截没有上限。
	 */
	validateStatus(status: number): boolean;
	/** 跳转自己一跳一跳跟(每一跳都要重新判去处),不交给 fetch。 */
	redirect: "manual";
	proxyAgent: string;
}

/** `ctx.http()` 回来的那个响应里我们真用到的几格。流式时 `data` 就是响应体那条流。 */
export interface ImageResponse {
	status: number;
	headers: { get(name: string): string | null };
	data: ReadableStream<Uint8Array> | null;
}

/** `ctx.http` 本身(它能直接调)上我们真用到的那一种调法(测试拿它塞假的)。 */
export interface ImageHttp {
	(url: string, config: ImageRequestConfig): Promise<ImageResponse>;
}

export interface FetchImageOptions {
	/** 这条桥的取图口所在(`blobOriginOf` 的结果)。只有它底下的取图口不看地址。 */
	origin: BlobOrigin;
	/** 主机名怎么解析。生产里不传,走系统的(`resolveHost`)。 */
	resolve?: Resolve;
	/** 测试拿它把时限、上限调小;生产里不传,用上面那两个常量。 */
	timeoutMs?: number;
	maxBytes?: number;
}

/** 跳转最多跟几跳。 */
export const MAX_REDIRECTS = 5;

/** 取图口的路径前缀(协议 §9.1)。「前缀是 BN 的挂载点就是取图口,别的都是外部地址」。 */
export const BLOB_PATH_PREFIX = "/ext/bridge/blob/";

/**
 * BN 取图口所在的源:协议(`http` / `https`)、主机名(小写;IPv6 带方括号,跟 `URL.hostname`
 * 同一个写法)、实际端口(默认端口已补上)。两边都规范成这个样子再比,`:80` 写没写、大小写
 * 就不会让同一个源被认成两个。
 */
export interface BlobOrigin {
	scheme: "http" | "https";
	host: string;
	port: number;
}

/**
 * 桥接地址的协议 → 取图口的协议。http(s) 也收:koishi 的 `ctx.http.ws` 自己会把 http(s) 换成
 * ws(s),这么填的配置今天连得上,不能在这儿把它拒了。
 */
const HTTP_OF_BRIDGE: Readonly<Record<string, BlobOrigin["scheme"]>> = {
	"ws:": "http",
	"wss:": "https",
	"http:": "http",
	"https:": "https",
};

/** 实际端口:`URL.port` 在端口等于默认值时是空串,补回来。判空串而不是真假:`"0"` 不是没写。 */
function portOf(scheme: BlobOrigin["scheme"], port: string): number {
	return port === "" ? (scheme === "http" ? 80 : 443) : Number(port);
}

/**
 * 桥连 BN 用的那条地址 → BN 取图口所在的源(`ws`→`http`,`wss`→`https`)。
 *
 * BN 拿握手请求的 `Host` 头拼取图地址(反代后面按 `X-Forwarded-Proto` 定 http / https,
 * 协议 §9.1),所以取图口就在**桥连过去的这个地址**上。算不出来时抛一句人话 —— 它会进 koishi
 * 的日志,是主人改配置的唯一线索。
 */
export function blobOriginOf(bridgeUrl: string): BlobOrigin {
	let url: URL;
	try {
		url = new URL(bridgeUrl.trim());
	} catch {
		throw new Error(`桥接地址解析不动:「${bridgeUrl}」`);
	}
	const scheme = HTTP_OF_BRIDGE[url.protocol];
	if (scheme === undefined) {
		throw new Error(`桥接地址得是 ws:// 或 wss:// 开头,这条是「${bridgeUrl}」`);
	}
	if (url.hostname === "") throw new Error(`桥接地址里没有主机名:「${bridgeUrl}」`);
	const port = portOf(scheme, url.port);
	// 超过 65535 的 `URL` 自己就不收;0 它收,可那不是个能连的端口。
	if (port === 0) throw new Error(`桥接地址的端口不对:「${bridgeUrl}」`);
	return { scheme, host: url.hostname, port };
}

/** 主机名 → 它解析出来的**全部**地址。测试换成替身,不碰真 DNS。 */
export type Resolve = (host: string) => Promise<string[]>;

/** 默认的解析:系统的 getaddrinfo,**全部**结果(`all: true`)。 */
export const resolveHost: Resolve = async (host) =>
	(await lookup(host, { all: true })).map((entry) => entry.address);

/** 认图要看的字节数:WEBP 要看到第 12 个字节(`RIFF`….`WEBP`),ISO-BMFF 的品牌也在 8..12。 */
export const SNIFF_BYTES = 12;

/**
 * ISO-BMFF(`ftyp` 盒)里是**图**的那些品牌 → 它的 mime。mp4 视频也是 `ftyp` 打头,只看第
 * 4..8 个字节等于把一段视频当成图放过去。品牌清单照 AstrBot 那侧(`bridge/fetch_image.py`)。
 */
const ISO_BMFF_IMAGE_BRANDS: Readonly<Record<string, string>> = {
	avif: "image/avif",
	avis: "image/avif",
	heic: "image/heic",
	heix: "image/heic",
	heim: "image/heic",
	heis: "image/heic",
	hevc: "image/heic-sequence",
	hevx: "image/heic-sequence",
	mif1: "image/heif",
	msf1: "image/heif-sequence",
};

function startsWith(head: Uint8Array, magic: readonly number[], at = 0): boolean {
	if (head.length < at + magic.length) return false;
	return magic.every((byte, i) => head[at + i] === byte);
}

/** `head` 里 `[from, to)` 那一段当 ASCII 读。 */
function asciiOf(head: Uint8Array, from: number, to: number): string {
	return head.length < to ? "" : String.fromCharCode(...head.subarray(from, to));
}

/**
 * 按开头的魔数认图,回它的 mime;认不出回 `undefined`。
 *
 * 🔴 **认出来的这个就是交给渲染层的 mime**,不是对头说的那个:带参数的 content-type
 * (`image/png; charset=binary`)会让 onebot 的 `data:` 正则失配、整张图发不出去;标错了的
 * (说 jpeg、其实是 png)照它发就是一张打不开的图。
 */
export function imageMimeOf(head: Uint8Array): string | undefined {
	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
	const six = asciiOf(head, 0, 6);
	if (six === "GIF87a" || six === "GIF89a") return "image/gif";
	if (asciiOf(head, 0, 4) === "RIFF" && asciiOf(head, 8, 12) === "WEBP") return "image/webp";
	if (asciiOf(head, 0, 2) === "BM") return "image/bmp";
	if (asciiOf(head, 4, 8) === "ftyp") {
		const brand = asciiOf(head, 8, 12);
		if (Object.hasOwn(ISO_BMFF_IMAGE_BRANDS, brand)) return ISO_BMFF_IMAGE_BRANDS[brand];
	}
	return undefined;
}

/**
 * 对头声称的类型(去掉参数、小写)。**明说了不是图的直接拒**。
 *
 * 没标、或者标成通用的 `application/octet-stream` 的放过去,交给字节认 —— 有的 CDN / 对象
 * 存储就是这么回图的。
 */
function declaredTypeOf(contentType: string | null | undefined): string {
	const declared = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (declared !== "" && !declared.startsWith("image/") && declared !== "application/octet-stream") {
		throw new Error(`取回来的是 ${declared},不是图片`);
	}
	return declared;
}

/**
 * 字节认不出是图就拒。Content-Type 挡得住老实的登录页,挡不住一张标着 `image/png` 的错误页 ——
 * 字节才作数。🔴 拒的时候别把字节倒进这句话:它会原样进 BN 的推送历史。
 */
function mimeOrRefuse(head: Uint8Array, declared: string): string {
	const mime = imageMimeOf(head);
	if (mime === undefined) {
		throw new Error(`取回来的内容不像图片(Content-Type: ${declared || "对面没给"})`);
	}
	return mime;
}

export async function fetchImage(
	http: ImageHttp,
	url: string,
	options: FetchImageOptions,
): Promise<{ data: Uint8Array; mime: string }> {
	const protocol = protocolOf(url);
	// 说清是什么协议、哪条地址:这条真触发时主人得看得出是 BN 递了条奇怪的东西过来,
	// 而不是「取图失败」这种谁都查不动的话。
	if (protocol === undefined) throw new Error(`这条图地址解析不出协议,不敢取:${url}`);
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`图只从 http / https 取,这条是 ${protocol}:${url}`);
	}

	const timeoutMs = options.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
	const resolve = options.resolve ?? resolveHost;
	/**
	 * 🔴 **整趟的时限自己看表。** 流式读的时候,`ctx.http` 自己那只超时在响应头回来那一刻就撤了
	 * (plugin-http 在 `finally` 里清掉它)—— 一滴一滴给的对头能把读 body 那段拖到天荒地老。
	 */
	const abort = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort.abort(new Error("取图超时"));
	}, timeoutMs);
	try {
		// 🔴 跳转**自己一跳一跳跟**,每一跳都重新判协议与去处:交给 fetch 自动跟的话,中间那几跳
		// 谁都没判过 —— 一条公网地址 302 一下就进了内网,或者跳去一条 `file://`。
		let current = new URL(url);
		for (let hop = 0; ; hop += 1) {
			if (hop > MAX_REDIRECTS) throw new Error(`跳转了 ${MAX_REDIRECTS} 次还没到头,不取了`);
			if (current.protocol !== "http:" && current.protocol !== "https:") {
				throw new Error(`图只从 http / https 取,跳转到的这条是 ${current.protocol}:${current.href}`);
			}
			// 解析也算在时限里:一个一直不回的 DNS 不该把这趟拖过 BN 的回执窗口。
			await untilAborted(refuseUnlessBlobOrPublic(current, options.origin, resolve), abort.signal);
			const response = await http(current.href, {
				method: "GET",
				responseType: "stream",
				timeout: timeoutMs,
				signal: abort.signal,
				validateStatus: () => true,
				redirect: "manual",
				...DIRECT,
			});
			const next = redirectOf(response, current);
			if (next === undefined) return await readImage(response, maxBytes);
			// 跳转那一跳的响应体没人要,掐掉。
			response.data?.cancel().catch(() => {});
			current = next;
		}
	} catch (err) {
		// 不管是哪一种失败,连接都掐掉 —— 别让一条没人要的下载接着往内存里灌。
		abort.abort();
		if (timedOut) throw new Error(`取图超时(超过 ${timeoutMs}ms)`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 读响应体。**边读边判**:状态码、声称的类型、Content-Length 在读 body 之前判;读的时候边数
 * 边比上限,够认魔数时当场认 —— 哪一道没过都当场掐掉那条流,不把剩下的拉下来。
 */
async function readImage(
	response: ImageResponse,
	maxBytes: number,
): Promise<{ data: Uint8Array; mime: string }> {
	const reader = response.data?.getReader();
	try {
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`对面回了 HTTP ${response.status}`);
		}
		const declared = declaredTypeOf(response.headers.get("content-type"));
		// 说了超就不读。没说、或者说得不对(撒谎说小)的,下面边读边数照样拦得住。
		const length = response.headers.get("content-length")?.trim();
		if (length !== undefined && /^\d+$/.test(length) && Number(length) > maxBytes) {
			throw new Error(`这张图太大(Content-Length 说 ${length} 字节,上限 ${maxBytes}),没下`);
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		let mime: string | undefined;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new Error(`这张图太大了,读到 ${total} 字节还没完,超过上限 ${maxBytes},已中止下载`);
			}
			chunks.push(value);
			// 够认了就当场认:不是图的话,别先把它整个(最多 maxBytes)拉下来再说。
			if (mime === undefined && total >= SNIFF_BYTES) {
				mime = mimeOrRefuse(concat(chunks, total).subarray(0, SNIFF_BYTES), declared);
			}
		}
		const data = concat(chunks, total);
		// 整个都不到 SNIFF_BYTES 字节的,读完再认(认不出就拒)。
		return { data, mime: mime ?? mimeOrRefuse(data, declared) };
	} catch (err) {
		// 掐掉那条流:不读了。这一步自己的失败没什么可说的,别让它盖过真正的原因。
		reader?.cancel().catch(() => {});
		throw err;
	}
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1 && chunks[0]?.byteLength === total) return chunks[0];
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/** 这一跳是跳转的话,回下一跳的地址(相对的按这一跳补全);不是回 `undefined`。 */
function redirectOf(response: ImageResponse, current: URL): URL | undefined {
	if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
	// 没给去处的跳转当一个普通的非 2xx 处理(`readImage` 会说出状态码)。
	const location = response.headers.get("location");
	if (location === null) return undefined;
	try {
		return new URL(location, current);
	} catch {
		throw new Error(`对面回了 HTTP ${response.status},可跳转地址解析不动:${location}`);
	}
}

/** 等 `promise`,但 `signal` 一掐就不等了(那条 promise 自己接着跑完,结果没人要)。 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** `URL.hostname` 里 IPv6 带着方括号;解析、判地址都要不带的那个。 */
function bareHost(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * 取图口放行、不看地址;别的一律当外部地址,解析出来的**每一个**都得是公网的(`isPublicAddress`)。
 *
 * 判的是**真要发出去**的那个 URL(`URL` 已经规范过:默认端口去掉、`..` 折掉、十进制 / 十六进制
 * 的 IPv4 写回点分),不是 BN 递来的原样字符串 —— 否则 `/ext/bridge/blob/../../api` 这种就
 * 混过去了。
 *
 * ⚠️ 不用 `ctx.http.isLocal`:它只看**第一个**解析结果,一个名字同时解析到公网与内网时照样放行。
 *
 * ⚠️ 剩下的一道缝(与 AstrBot 那侧一样留着):这里解析完,fetch 连接时**自己再解析一遍**。一个
 * 故意在两次之间换答案的域名(DNS rebinding)仍能把连接引到内网。这道闸挡住的是「BN 直接递一个
 * 内网地址过来」;要连那条缝一起堵,得把解析出来的地址钉给传输层,那是另一件事。
 */
async function refuseUnlessBlobOrPublic(url: URL, origin: BlobOrigin, resolve: Resolve): Promise<void> {
	const scheme = url.protocol === "https:" ? "https" : "http";
	const port = portOf(scheme, url.port);
	const onBlobPath = url.pathname.startsWith(BLOB_PATH_PREFIX);
	if (scheme === origin.scheme && url.hostname === origin.host && port === origin.port && onBlobPath) return;
	const host = bareHost(url.hostname);
	if (host === "") throw new Error("这条图地址没有主机名,不敢取");
	const addresses = isIP(host) !== 0 ? [host] : await resolveAll(host, resolve);
	for (const address of addresses) {
		if (isPublicAddress(address)) continue;
		// 同一台机器上的取图口,只是协议 / 端口和桥接地址对不上:拒的理由换成这一句。典型是 BN
		// 挂在反代后面、反代没设 X-Forwarded-Proto —— 只报「指向内网或本机」会把人往网络那头带。
		// 🔴 只换理由、不改放行:那个端口上可能是任何东西,所以照样拒。
		if (url.hostname === origin.host && onBlobPath) {
			throw new Error(
				`这条取图地址和桥接地址是同一台机器,但协议 / 端口对不上(桥连的是 ${origin.scheme}:${origin.port},BN 给的是 ${scheme}:${port})。BN 挂在反代后面时,反代要设 X-Forwarded-Proto;或者直接用 BN 给的那个协议和端口作为桥接地址。`,
			);
		}
		const where = address === host ? host : `${host} → ${address}`;
		throw new Error(`这条图地址指向内网或本机(${where}),桥只替 BN 取它自己的图和公网上的图`);
	}
}

async function resolveAll(host: string, resolve: Resolve): Promise<string[]> {
	let addresses: string[];
	try {
		addresses = await resolve(host);
	} catch (err) {
		throw new Error(`这条图地址的主机名解析不了(${host}:${reasonOf(err)})`);
	}
	if (addresses.length === 0) throw new Error(`这条图地址的主机名解析不出任何地址(${host})`);
	return addresses;
}

/** 解析不动就回 `undefined` —— 「不是个 URL」和「是个别的协议」要分开说。 */
function protocolOf(url: string): string | undefined {
	try {
		return new URL(url).protocol;
	} catch {
		return undefined;
	}
}
