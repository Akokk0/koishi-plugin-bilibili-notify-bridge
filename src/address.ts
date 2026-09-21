/**
 * 「这个 IP 是不是公网单播」—— 取图那道闸的判据(见 `fetch-image.ts`)。
 *
 * 语义照 Python `ipaddress` 的 `is_global and not is_multicast`(CPython 3.13 那几张表):
 * AstrBot 那侧的桥用的就是它,两边判的得是同一件事。表抄自
 * https://www.iana.org/assignments/iana-ipv4-special-registry 与对应的 IPv6 那张 ——
 * 「全球可达」一栏是「否」的那些。
 *
 * ⚠️ 不认识的写法一律当**不是**公网:这是一道「放行」的闸,认错了宁可少取一张图。
 */

import { isIPv4, isIPv6 } from "node:net";

/** 一段网络:起点 + 前缀长度。 */
type Net<T> = readonly [base: T, length: number];

/** IPv4 里「不是全球可达」的那些(CPython 3.13 `_IPv4Constants._private_networks`)。 */
const V4_NOT_GLOBAL: readonly Net<number>[] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.0.170", 31],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["240.0.0.0", 4],
	["255.255.255.255", 32],
	// CGNAT(运营商级 NAT)。Python 单列成 `_public_network`,`is_global` 一样排除它。
	["100.64.0.0", 10],
].map(([base, length]) => [v4Of(base as string), length as number] as const);

/** 上面那些里又被单独放出来的(`_private_networks_exceptions`)。 */
const V4_GLOBAL_EXCEPTIONS: readonly Net<number>[] = [
	["192.0.0.9", 32],
	["192.0.0.10", 32],
].map(([base, length]) => [v4Of(base as string), length as number] as const);

const V4_MULTICAST: Net<number> = [v4Of("224.0.0.0"), 4];

/** IPv6 里「不是全球可达」的那些(`_IPv6Constants._private_networks`)。 */
const V6_NOT_GLOBAL: readonly Net<bigint>[] = [
	["::1", 128],
	["::", 128],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
	["fc00::", 7],
	["fe80::", 10],
].map(([base, length]) => [v6Of(base as string), length as number] as const);

const V6_GLOBAL_EXCEPTIONS: readonly Net<bigint>[] = [
	["2001:1::1", 128],
	["2001:1::2", 128],
	["2001:3::", 32],
	["2001:4:112::", 48],
	["2001:20::", 28],
	["2001:30::", 28],
].map(([base, length]) => [v6Of(base as string), length as number] as const);

const V6_MULTICAST: Net<bigint> = [v6Of("ff00::"), 8];

/** `::ffff:0:0/96` —— IPv4 映射的 IPv6。它们**按它们代表的那个 IPv4 判**。 */
const V4_MAPPED_PREFIX = 0xffffn;

/** 点分十进制 → 32 位无符号整数。调用方先用 `isIPv4` 验过。 */
function v4Of(text: string): number {
	return text.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** IPv6 文本 → 128 位整数。调用方先用 `isIPv6` 验过(区域号 `%…` 已经剥掉)。 */
function v6Of(text: string): bigint {
	let s = text;
	// 末尾嵌着 IPv4 的写法(`::ffff:1.2.3.4`):换成两组十六进制。
	if (s.includes(".")) {
		const at = s.lastIndexOf(":");
		const v4 = v4Of(s.slice(at + 1));
		s = `${s.slice(0, at + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const [head = "", tail] = s.split("::");
	const headGroups = head === "" ? [] : head.split(":");
	const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
	const zeros = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
	const groups = [...headGroups, ...Array<string>(zeros).fill("0"), ...tailGroups];
	return groups.reduce((n, group) => (n << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function inV4(ip: number, [base, length]: Net<number>): boolean {
	// `>>>` 按 32 取模:移 32 位等于没移,前缀长度 0 得单独算(表里没有,防的是以后加)。
	return length === 0 || (ip ^ base) >>> (32 - length) === 0;
}

function inV6(ip: bigint, [base, length]: Net<bigint>): boolean {
	return (ip ^ base) >> BigInt(128 - length) === 0n;
}

function isPublicV4(ip: number): boolean {
	if (inV4(ip, V4_MULTICAST)) return false;
	const notGlobal = V4_NOT_GLOBAL.some((net) => inV4(ip, net));
	return !notGlobal || V4_GLOBAL_EXCEPTIONS.some((net) => inV4(ip, net));
}

function isPublicV6(ip: bigint): boolean {
	if (ip >> 32n === V4_MAPPED_PREFIX) return isPublicV4(Number(ip & 0xffffffffn));
	if (inV6(ip, V6_MULTICAST)) return false;
	const notGlobal = V6_NOT_GLOBAL.some((net) => inV6(ip, net));
	return !notGlobal || V6_GLOBAL_EXCEPTIONS.some((net) => inV6(ip, net));
}

/**
 * 这个 IP(v4 或 v6 的文本,不带方括号;v6 可以带区域号 `%…`)是不是**全球可达、又不是组播**。
 *
 * 私网、回环、链路本地(169.254.x,云元数据口在这儿)、CGNAT、ULA、文档 / 保留段都不是;
 * IPv4 映射的 IPv6(`::ffff:a.b.c.d`)按它代表的那个 IPv4 判 —— 不然 `::ffff:127.0.0.1`
 * 就是一条绕过去的路。认不出来的一律当不是。
 */
export function isPublicAddress(address: string): boolean {
	if (isIPv4(address)) return isPublicV4(v4Of(address));
	const bare = address.replace(/%.*$/, "");
	if (isIPv6(bare)) return isPublicV6(v6Of(bare));
	return false;
}
