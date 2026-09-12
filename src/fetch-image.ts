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
 * 🔴 **要有超时**。BN 最多等 30 秒(协议 §5.4),超了那条推送就按失败记账。一条没有超时的
 * 下载会让主人看到「推送卡着不动」—— 比一条明确的失败难查得多。
 *
 * 🔴 **要有上限**。图整个进内存、交给适配器时还要 base64 一遍(再涨三分之一)。没有上限
 * 就是一条「递一条大文件的地址过来即可把 koishi 打爆」的路。
 */

/** 比 BN 那 30 秒的回执窗口短一截 —— 超时了还来得及回一句人话。 */
export const IMAGE_FETCH_TIMEOUT_MS = 20_000;
/** BN 出的卡再大也就几百 KB;16 MiB 是给「明显不对劲」留的门,不是给正常图留的余量。 */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** `ctx.http` 上我们真用到的那一格(测试拿它塞假的)。 */
export interface ImageHttp {
	file(url: string, options: { timeout: number }): Promise<{ data: ArrayBuffer; type?: string | null }>;
}

export async function fetchImage(
	http: ImageHttp,
	url: string,
): Promise<{ data: Uint8Array; mime: string | undefined }> {
	const protocol = protocolOf(url);
	// 说清是什么协议、哪条地址:这条真触发时主人得看得出是 BN 递了条奇怪的东西过来,
	// 而不是「取图失败」这种谁都查不动的话。
	if (protocol === undefined) throw new Error(`这条图地址解析不出协议,不敢取:${url}`);
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`图只从 http / https 取,这条是 ${protocol}:${url}`);
	}

	const file = await http.file(url, { timeout: IMAGE_FETCH_TIMEOUT_MS });
	if (file.data.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(`这张图太大(${file.data.byteLength} 字节,上限 ${MAX_IMAGE_BYTES}):${url}`);
	}
	// 🔴 回 `undefined` 而不是 `null` / 空串:渲染那一层拿 `??` 去接帧里声明的那个 mime,
	// 而 `h.image(data, null)` 发出去的是已废弃的 `base64://`(见 message.ts)。
	return { data: new Uint8Array(file.data), mime: file.type || undefined };
}

/** 解析不动就回 `undefined` —— 「不是个 URL」和「是个别的协议」要分开说。 */
function protocolOf(url: string): string | undefined {
	try {
		return new URL(url).protocol;
	} catch {
		return undefined;
	}
}
