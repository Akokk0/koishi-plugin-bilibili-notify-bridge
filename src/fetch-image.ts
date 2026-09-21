/**
 * 把 BN 那条图 URL 取回来。
 *
 * 🔴 **图必须桥自己下载**(协议 §9):那条 URL 只保证桥自己可达 —— BN 常跑在 NAS 上,
 * 把它交给平台去拉是静默失败(消息到了、图没了、日志一个字都没有)。
 *
 * 所以这一步是**桥拿着 BN 递来的地址去访问网络**,而 BN 递什么完全由那条连接说了算。
 * 三道闸各自挡的是一种「照做了就出事」:
 *
 * 🔴 **只准 http / https**。koishi 的 `ctx.http.file()` 碰到 `file://` 走的是
 * `readFile(fileURLToPath(url))` —— 递一条 `file:///…/koishi.yml` 过来,桥就把宿主机的
 * 配置(里头有各平台的 token)当成一张图发进群。拿到了这条桥 token 的人(比如同一个内网
 * 里嗅探到的)因此白得一个**任意本地文件读取**;而现场看上去一切正常:发出去了、回执 ok。
 * 判在**调 `file()` 之前**:拦在之后的话文件已经读进内存了。
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

/** 测试拿它把时限、上限调小;生产里不传,用上面那两个常量。 */
export interface FetchImageOptions {
	timeoutMs?: number;
	maxBytes?: number;
}

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
	options: FetchImageOptions = {},
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
		const response = await http(url, {
			method: "GET",
			responseType: "stream",
			timeout: timeoutMs,
			signal: abort.signal,
			validateStatus: () => true,
			...DIRECT,
		});
		return await readImage(response, maxBytes);
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

/** 解析不动就回 `undefined` —— 「不是个 URL」和「是个别的协议」要分开说。 */
function protocolOf(url: string): string | undefined {
	try {
		return new URL(url).protocol;
	} catch {
		return undefined;
	}
}
