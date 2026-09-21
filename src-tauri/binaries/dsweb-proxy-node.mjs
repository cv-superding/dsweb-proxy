#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) {
		__defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	}
	if (!no_symbols) {
		__defProp(target, Symbol.toStringTag, { value: "Module" });
	}
	return target;
};

//#endregion
//#region src/core/cookies.ts
/**
* 归一化一个 cookie 的过期形态。两种来源的字段名不同，这里统一。
*
* 判定顺序：显式 `session === true` 优先；否则看 `expires` / `expirationDate`。
* 缺失、非数、`<= 0` **一律当会话级** —— CDP 对会话级给的就是 `-1`，
* 而"0"在 Unix epoch 里也毫无意义，当成有效时间会算出 1970 年。
*/
function readCookieExpiry(raw) {
	if (!raw || typeof raw !== "object") return { session: true };
	if (raw.session === true) return { session: true };
	const seconds = Number(raw.expires ?? raw.expirationDate);
	if (!Number.isFinite(seconds) || seconds <= 0) return { session: true };
	return {
		session: false,
		expiresAt: Math.round(seconds * 1e3)
	};
}
/**
* 从任意来源的 cookie 数组里挑出目标域的，转成 `CookieMeta`。
*
* ⚠️ `filter` 由调用方给出、且**必须与该处拼 cookie 头的过滤条件逐字一致**：
* 这些元信息要描述的正是"请求里实际带上的那批 cookie"。两条捕获路径原本的过滤条件
* 不同（真实浏览器那条用 `deepseek`，Electron 那条用 `deepseek.com`），
* 这里刻意不强行统一 —— 统一就等于改了请求头内容，而那个改动是没法靠单测兜住的。
*/
function pickCookieMeta(cookies, filter) {
	const out = [];
	for (const raw of cookies ?? []) {
		const name = typeof raw?.name === "string" ? raw.name : "";
		if (!name) continue;
		const domain = String(raw?.domain ?? "");
		if (!filter(domain)) continue;
		const { session, expiresAt } = readCookieExpiry(raw);
		out.push({
			name,
			domain,
			session,
			...expiresAt !== void 0 ? { expiresAt } : {}
		});
	}
	return out;
}
/**
* 规整"已经归一化过"的 `CookieMeta` 数组（从磁盘读账号记录时用）。
* 形状不对的条目直接丢掉，不抛错 —— 一份坏记录不该让整个账号库读不出来。
*/
function normalizeCookieMetaList(raw) {
	if (!Array.isArray(raw)) return void 0;
	const out = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const name = typeof item.name === "string" ? item.name : "";
		if (!name) continue;
		const expiresRaw = Number(item.expiresAt);
		const hasExpiry = Number.isFinite(expiresRaw) && expiresRaw > 0;
		const session = item.session === true || !hasExpiry;
		out.push({
			name,
			domain: typeof item.domain === "string" ? item.domain : "",
			session,
			...session ? {} : { expiresAt: Math.round(expiresRaw) }
		});
	}
	return out.length > 0 ? out : void 0;
}

//#endregion
//#region src/core/paths.ts
/**
* 路径解析 —— 单独成文件，避免 auth.ts ↔ accounts.ts 互相 import 形成环。
*
* dsweb-proxy 的状态目录解析顺序：
*   1. DSWEB_PROXY_HOME（显式指定，测试与 Tauri 壳用）
*   2. DSH_HOME/web-login —— 与 DSH 插件共享旧状态（平滑迁移，凭证不用重登）
*   3. ~/.dsweb-proxy —— 全新安装的缺省位置
*
* 兼容说明：DSH 插件把状态放在 `${DSH_HOME || ~/.dsh}/web-login/`。本反代保留同一
* 解析顺序作为缺省，让已装过 DSH 插件的机器**零迁移**复用登录态与账号库。
*/
/** 反代自己的主目录（与 DSH 生态兼容的解析顺序）。 */
function resolveProxyHome() {
	if (process.env.DSWEB_PROXY_HOME) return process.env.DSWEB_PROXY_HOME;
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(dshHome, "web-login");
}
/** 反代的状态目录（凭证 / 账号库 / 配置 / 台账都放这里）。 */
function webLoginDir() {
	return resolveProxyHome();
}

//#endregion
//#region src/core/accounts.ts
/**
* 账号库 —— 把「一个账号」升级成「一库账号，一键切换」。
*
* ## 为什么要做（2026-09-12，借鉴 workbuddy-switch）
*
* 原来只有一份凭证文件（`deepseek-auth.json`），换号的代价是：
* **退出 → 清除浏览器分区 → 重新登录 → 等它捕获**，期间原来的号也回不去了。
* 参考项目把"账号"当成一等公民管理（账号卡片、状态、临期高亮、导入导出），
* 这里把其中适用的部分搬过来：**多账号并存 + 一键切换 + 导入导出**。
*
* 目录结构：
* ```
* <DSH_HOME>/web-login/
*   ├── accounts.json            # 索引：{ activeId }（顺序与展示信息都在各账号文件里）
*   ├── accounts/acc_xxxx.json   # 每个账号一份（WebAuth + 元信息），原子写 + 0600
*   └── deepseek-auth.json       # 旧版单账号文件（只用于首次迁移）
* ```
*
* ## ⚠️ 风险提示（必须让使用者看见，不只是写在文档里）
*
* 账号库让"换号"变得很容易，而**用多账号轮换规避单账号限流，是有代价的**：
*
*  1. 同一服务商会把多账号**关联**起来（同设备、同 IP、同指纹、彼此相近的行为模式）。
*     一旦被判定为"同一人的多开小号"，处置通常比单账号超频更重，且可能波及**全部**关联账号。
*  2. 因此本插件**只提供手动切换**，刻意**不做自动轮换** ——
*     真人不会在几分钟内换一个账号继续发消息，自动换号是极强的机器行为特征，
*     与本插件在传输层/间隔/会话清理上"降低机器可识别性"的努力**直接冲突**。
*  3. 账号库里的每个文件都含**可完整登录的凭证**（token + cookie）。
*     导出的备份文件同样是明文 —— 分享给别人等于把账号给出去。
*
* 换句话说：这个功能的目标是「**在你自己的多个正常账号之间切换得更省事**」
* （比如工作号/个人号），**不是**「靠轮换把限流绕过去」。
*/
const INDEX_VERSION = 1;
function accountsDir() {
	return join(webLoginDir(), "accounts");
}
function accountsIndexPath() {
	return join(webLoginDir(), "accounts.json");
}
function assertSafeAccountId(id) {
	const text = String(id ?? "");
	if (!text || text.includes("\0") || text === "." || text === ".." || /[/\\]/.test(text)) throw new Error(`账号 id 不合法（含路径分隔符或相对路径段）：${JSON.stringify(text)}`);
	return text;
}
function accountFilePath(id) {
	return join(accountsDir(), `${assertSafeAccountId(id)}.json`);
}
/** 新账号 id。用随机 id 而不是 token 哈希：token 会刷新，id 不该跟着变。 */
function newAccountId() {
	return `acc_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
/** 原子写（临时文件 + 替换），非 Windows 下收紧权限到 0600。 */
function writeJsonAtomic(file, value) {
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), {
		encoding: "utf8",
		mode: 384
	});
	try {
		renameSync(tmp, file);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw error;
	}
	if (process.platform !== "win32") try {
		chmodSync(file, 384);
	} catch {}
}
function readJson(file) {
	try {
		if (!existsSync(file)) return void 0;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
}
function readIndex() {
	const parsed = readJson(accountsIndexPath());
	return {
		version: INDEX_VERSION,
		...typeof parsed?.activeId === "string" && parsed.activeId ? { activeId: parsed.activeId } : {}
	};
}
function writeIndex(index) {
	writeJsonAtomic(accountsIndexPath(), {
		version: INDEX_VERSION,
		...index.activeId ? { activeId: index.activeId } : {}
	});
}
/** 把任意对象规整成 AccountRecord（缺字段补默认值；凭证无效返回 undefined）。 */
function normalizeRecord(raw, fallbackId) {
	if (!raw || typeof raw !== "object") return void 0;
	const token = typeof raw.token === "string" ? raw.token : "";
	if (!token) return void 0;
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : fallbackId ?? newAccountId(),
		token,
		cookie: typeof raw.cookie === "string" ? raw.cookie : "",
		hifDliq: typeof raw.hifDliq === "string" ? raw.hifDliq : "",
		hifLeim: typeof raw.hifLeim === "string" ? raw.hifLeim : "",
		wasmUrl: typeof raw.wasmUrl === "string" ? raw.wasmUrl : "",
		userAgent: typeof raw.userAgent === "string" ? raw.userAgent : "",
		...raw.extraHeaders && typeof raw.extraHeaders === "object" ? { extraHeaders: raw.extraHeaders } : {},
		capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "",
		...raw.unverified === true ? { unverified: true } : {},
		...raw.user && typeof raw.user === "object" ? { user: raw.user } : {},
		...(() => {
			const meta = normalizeCookieMetaList(raw.cookieMeta);
			return meta ? { cookieMeta: meta } : {};
		})(),
		...typeof raw.label === "string" && raw.label ? { label: raw.label } : {},
		...typeof raw.groupId === "string" && raw.groupId ? { groupId: raw.groupId } : {},
		...typeof raw.serverId === "string" && raw.serverId ? { serverId: raw.serverId } : {},
		...typeof raw.lastVerifiedAt === "string" ? { lastVerifiedAt: raw.lastVerifiedAt } : {},
		...raw.lastVerifyError && typeof raw.lastVerifyError?.at === "string" ? { lastVerifyError: {
			at: raw.lastVerifyError.at,
			message: String(raw.lastVerifyError.message ?? "")
		} } : {},
		...raw.limit && Number.isFinite(raw.limit?.untilMs) ? { limit: {
			untilMs: Number(raw.limit.untilMs),
			observedAt: String(raw.limit.observedAt ?? "")
		} } : {}
	};
}
/** 库里全部账号，按捕获时间倒序（最近捕获的在前）。 */
function listAccounts() {
	let names = [];
	try {
		names = readdirSync(accountsDir()).filter((name) => name.endsWith(".json") && !name.includes(".tmp-"));
	} catch {
		return [];
	}
	const records = [];
	for (const name of names) {
		const id = name.replace(/\.json$/, "");
		const record = normalizeRecord(readJson(accountFilePath(id)), id);
		if (record) records.push(record);
	}
	records.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
	return records;
}
function readAccount(id) {
	if (!id) return void 0;
	return normalizeRecord(readJson(accountFilePath(id)), id);
}
function saveAccount(record) {
	writeJsonAtomic(accountFilePath(record.id), record);
}
function activeAccountId() {
	const { activeId } = readIndex();
	if (!activeId) return void 0;
	try {
		return existsSync(accountFilePath(activeId)) ? activeId : void 0;
	} catch {
		return;
	}
}
/** 当前生效的账号（没有就返回 undefined）。 */
function activeAccount() {
	const id = activeAccountId();
	return id ? readAccount(id) : void 0;
}
function setActiveAccount(id) {
	if (!existsSync(accountFilePath(id))) return false;
	writeIndex({
		version: 1,
		activeId: id
	});
	return true;
}
function clearActiveAccount() {
	writeIndex({ version: 1 });
}
/**
* 从账号库里移除一个账号（**删除凭证文件**）。
*
* 为什么不学其它可逆操作"改名留档"：这里存的是**可完整登录的凭证**，
* 「退出/移除」的语义就是"这份凭证不该再留在磁盘上" ——
* 留一个 `.removed-<时间>` 的明文备份会让"已登出"变成谎话（安全上的倒退）。
* 误删的保护交给两件事：界面上**二次确认**，以及账号库**导出备份**。
*/
function removeAccount(id) {
	const file = accountFilePath(id);
	if (!existsSync(file)) return false;
	try {
		rmSync(file, { force: true });
	} catch {
		return false;
	}
	if (readIndex().activeId === id) clearActiveAccount();
	return true;
}
/**
* 写入/更新一个账号的凭证（登录捕获、手动粘贴 token 都走这里）。
*
* 去重顺序：
*  1. 有 `serverId` 且库里已有同 `serverId` → **更新那一条**（同一账号重新捕获）；
*  2. 否则 token 完全相同的记录 → 更新（serverId 还没拿到的场景）；
*  3. 都没有 → 新增。
*
* ⚠️ **凭证字段一律以本次传入的为准，不做合并**：调用方（例如登录流程）用
* `writeAuth({ ...auth, unverified: true })` 表示"这次没校验成功"，
* 若沿用旧记录的字段，这条 `unverified` 会永远粘住、再也清不掉。
* 需要跨次保留的只有元信息（备注名/探活时间/限制状态），所以只挑那几个字段继承。
*/
function upsertAccount(auth, patch = {}) {
	const incoming = auth;
	const serverId = patch.serverId ?? incoming.serverId;
	const all = listAccounts();
	const existing = (serverId ? all.find((item) => item.serverId && item.serverId === serverId) : void 0) ?? (serverId ? all.find((item) => !item.serverId && item.user?.id === serverId) : void 0) ?? all.find((item) => item.token === auth.token);
	const id = patch.id ?? existing?.id ?? newAccountId();
	const carried = {};
	for (const key of [
		"label",
		"groupId",
		"serverId",
		"lastVerifiedAt",
		"lastVerifyError",
		"limit"
	]) {
		const value = patch[key] ?? incoming[key] ?? existing?.[key];
		if (value !== void 0) carried[key] = value;
	}
	const userFromPatch = patch?.user;
	const userFromIncoming = incoming?.user;
	const mergedUser = {
		...existing?.user ?? {},
		...userFromIncoming && typeof userFromIncoming === "object" ? userFromIncoming : {},
		...userFromPatch && typeof userFromPatch === "object" ? userFromPatch : {}
	};
	if (Object.keys(mergedUser).length > 0) carried.user = mergedUser;
	const record = normalizeRecord({
		...auth,
		...carried,
		id
	}, id);
	saveAccount(record);
	return record;
}

//#endregion
//#region src/core/auth.ts
/** 当前生效的登录凭证（没有选择账号 → undefined）。 */
function readAuth() {
	return activeAccount();
}
/**
* 写入/更新凭证。
*
* 语义：**写进去的那个就是接下来要用的那个** —— 所有调用点（浏览器捕获、
* 手动粘 token、登录流程回填账号信息）表达的都是这个意思，所以这里顺带把它设为当前账号。
* 同一个账号重复写入会**更新原记录**（按 serverId / token 去重，见 accounts.upsertAccount）。
*/
function writeAuth(auth) {
	const record = upsertAccount(auth);
	setActiveAccount(record.id);
}
/**
* 把「**可信校验**得到的身份」归一进凭证：`user.id` → `serverId`（去重键）。
*
* ⚠️ 为什么必须有这一步（审计 F04）：库里按 `serverId` 去重（同账号重新登录 → 更新而不是新增），
* 但 `user.id` 原本只在登录时被塞进 `user` 字段、**从没写进 `serverId`** ——
* 于是 token 一刷新，去重键就失效，同一个号在库里堆成好几条：
* 真实登录路径上「两级去重」等于没接上（既有测试是手工传 `serverId` 才通过的）。
*
* 只在**服务端校验返回了身份**之后调用（浏览器捕获、分区恢复、手动 token、/status、探活）。
* 备份文件自报的 id 不在这里采信 —— 那条路径由 `importAccounts` 单独把关。
*/
function withVerifiedIdentity(auth, user) {
	const display = typeof user?.display === "string" && user.display ? user.display : void 0;
	const serverId = typeof user?.id === "string" && user.id ? user.id : void 0;
	return {
		...auth,
		unverified: void 0,
		...display || serverId ? { user: {
			...auth.user,
			...display ? { display } : {},
			...serverId ? { id: serverId } : {}
		} } : {},
		...serverId ? { serverId } : {}
	};
}
/**
* 退出登录：把当前账号从库里**移除**（并清掉当前指针）。
*
* 库里还有其它账号时**刻意不自动切换**：自动换号会让人以为"我只是登出了，
* 怎么又用上另一个号了"。界面会提示"账号库里还有 N 个，点「切换」即可使用"，
* 由人明确选择。
*/
function clearAuth() {
	const active = activeAccount();
	if (active) removeAccount(active.id);
	clearActiveAccount();
}
function hasUsableAuth(auth) {
	return !!auth && typeof auth.token === "string" && auth.token.length > 8;
}
/**
* 解包页面读回的 token（兼容裸字符串与 AppKit 包装 JSON）。
*
* ⚠️ 两个必须守住的边界（都是实测形态）：
*  - 未登录时网页端返回的是 `{"value":null,"__version":"0"}` → 必须得到**空串**，
*    绝不能把字符串 "null" 当 token（否则会拿垃圾 token 去请求，报 40003 让人一头雾水）。
*  - 旧版本网页端存的是裸 token 字符串 → 原样返回。
*/
function unwrapStoredToken(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return "";
	if (text.startsWith("{")) try {
		const parsed = JSON.parse(text);
		return typeof parsed?.value === "string" ? parsed.value.trim() : "";
	} catch {
		return "";
	}
	return text === "null" || text === "undefined" ? "" : text;
}
/**
* 适配器边界错误。自带 `failure` 与 `code` 自有数据属性 ——
* LlmRuntime.normalizeLlmFailure 通过自有属性（而非 instanceof）读取结构化
* 失败信息，因此跨模块边界的自包含打包也能携带 code/status/retryAfter。
*/
var AdapterLlmError = class extends Error {
	failure;
	code;
	/**
	* 账号级限制的**解除时间**（毫秒时间戳），仅在 `user is muted` 时有值。
	*
	* 为什么要单独带一个字段：`providerRetryAfterMs` 是相对值（给重试策略用的），
	* 而"记下这个账号被限到什么时候"需要绝对值。让调用方去解析错误文案里的时间是不可靠的。
	*/
	mutedUntilMs;
	constructor(message, code, options = {}) {
		super(message);
		this.name = "LlmError";
		this.code = code;
		if (options.mutedUntilMs !== void 0) this.mutedUntilMs = options.mutedUntilMs;
		this.failure = {
			message,
			code,
			...options.status !== void 0 ? { status: options.status } : {},
			...options.providerRetryAfterMs !== void 0 ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}
		};
		if (options.cause !== void 0) this.cause = options.cause;
	}
};
/** 把 HTTP 状态映射为稳定错误码（对齐 dsh-llm 默认可重试码表：SERVER/RATE_LIMIT/TIMEOUT/TRANSPORT）。 */
function httpErrorCode(status) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 429) return "RATE_LIMIT";
	if (status === 402) return "QUOTA";
	if (status >= 500) return "SERVER";
	return "PROVIDER_ERROR";
}
/** 解析 Retry-After（秒数或 HTTP-date），返回毫秒。 */
function parseRetryAfterMs(raw) {
	if (!raw) return void 0;
	const text = String(raw).trim();
	if (/^\d+$/.test(text)) return Math.max(1e3, Number(text) * 1e3);
	const parsed = Date.parse(text);
	if (!Number.isNaN(parsed)) return Math.max(1e3, parsed - Date.now());
}

//#endregion
//#region src/providers/estimate.ts
/** token 估算（从 DSH adapter.ts 原样移植，供 usage 上报用）。 */
function estimateTokens(text) {
	if (!text) return 0;
	let cjk = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 12288 && code <= 40959) cjk += 1;
	}
	const ascii = text.length - cjk;
	return Math.ceil(cjk / 1.5 + ascii / 4);
}

//#endregion
//#region src/core/gate.ts
/**
* 推荐的调用间隔：**随机区间 2~4 秒**（下限 / 上限）。
*
* 为什么是区间而不是固定值：固定间隔的方差≈0，在统计上就是「定时器特征」；
* 人的操作间隔是有方差的。同类项目 cuckoo-code（从未被风控）用的正是 2000~4000ms 随机区间。
*/
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 2e3;
const DEFAULT_MAX_REQUEST_INTERVAL_MS = 4e3;
/**
* 长任务保护：连续跑这么多次之后，强制长休一次。0 = 关闭。
*
* 为什么需要它：间隔只管"两次之间空多久"，管不了"一刻不停跑了多久"。
* 实测 2026-09-12 一个 SSH 插件开发任务，12 分钟里发了约 70 次请求（大量是只调工具、
* 不说话的轮次），间隔设到 2~4 秒仍然全程零停顿 —— 那种形态比间隔大小更像脚本，
* 当天该账号两次被临时限制（第二次长达 3 天）。
*/
const DEFAULT_LONG_RUN_THRESHOLD = 15;
/** 长休时长区间（1~3 分钟）。 */
const DEFAULT_LONG_RUN_BREAK_MS = {
	min: 6e4,
	max: 18e4
};
/** 长休区间的合法范围（30 秒 ~ 10 分钟）。 */
const LONG_RUN_BREAK_BOUNDS_MS = {
	min: 3e4,
	max: 6e5
};
/** 长休阈值的合法范围（0 = 关闭，上限 100 次）。 */
const LONG_RUN_THRESHOLD_BOUNDS = {
	min: 0,
	max: 100
};
/**
* 每次请求发送的 prompt **字符上限**。
*
* 为什么它是防风的头号阀门（2026-09-13 实测）：网页 API 无状态，**每一轮都要把整段转写重发**，
* 所以转写越长、单次请求越贵。同一个会话里单次输入估算从 9.7k token 涨到 **293k**，
* 180 次请求累计约 **2900 万 token**（这是我们自己的估算值，不是服务端账单，
* 但"每次都在重发历史"是代码事实）。四个账号在两天内陆续被限制，体量是主要嫌疑。
*
* 边界取值理由：
* - 上限就取**原来的默认值 150 万**：再大就有撑爆 1M 上下文的风险
*   （纯中文 150 万字符 ≈ 100 万 token）。
* - 下限取**更早的默认值 12 万**：那是长期在用的值，说明这个量级还能干活（工具目录占约 5.6 万）。
*/
const MAX_PROMPT_CHARS_BOUNDS = {
	min: 12e4,
	max: 15e5
};
/**
* **默认**上限 —— 0.1.76 起由 150 万降到 **40 万**。
*
* 它同时是一个**风控阀门**：网页端无状态，每一轮都要把整段转写重发，所以这个数字直接决定
* 单次请求的体量。会话内实测单次输入从 9.7k token 一路涨到 293k，而 150 万字符（纯中文
* ≈100 万 token）意味着默认就允许"一次顶满 1M 上下文" —— 四个账号两天内陆续被限制，
* 体量是主要嫌疑。40 万 ≈27 万 token，够跑长任务，又不会让默认配置本身贴着天花板。
*
* ⚠️ 可调范围不变（见上面的 BOUNDS）：确实需要更长的转写可以自己往上调，
* 但要知道那是在拿账号的稳定换更长的记忆 —— 面板上那个旋钮的说明写了同一件事。
*/
const DEFAULT_MAX_PROMPT_CHARS = 4e5;
/** 规整 prompt 字符上限：非数 → 默认；越界 → 夹到边界。 */
function clampMaxPromptChars(value) {
	if (!Number.isFinite(value)) return DEFAULT_MAX_PROMPT_CHARS;
	return Math.max(MAX_PROMPT_CHARS_BOUNDS.min, Math.min(MAX_PROMPT_CHARS_BOUNDS.max, Math.round(value)));
}
/**
* 一次请求最多带多少张图片（请求体里 `ref_file_ids` 的长度）。
*
* 为什么默认 24（2026-09-19 群友实测报告）：网页端对这一批引用的数量有上限 ——
* 最后一次成功是 40 张、第一次失败是 52 张，真值落在 (40, 52]。越过之后
* `biz_code 10 / too many ref file` 会让**该会话此后每一轮都失败**（图还留在历史里，
* 每轮重发都超标），用户唯一出路是丢掉整个会话。24 给已知安全线留了 16 张余量。
*
* `0` ＝ 不限制 —— 留着这个取值只是给"确实需要"的人，但**别设**：那等于把 code 10 放回来。
*/
const MAX_REF_IMAGES_BOUNDS = {
	min: 0,
	max: 100
};
const DEFAULT_MAX_REF_IMAGES = 24;
/** 规整图片数量上限：非数 → 默认；越界 → 夹到边界。 */
function clampMaxRefImages(value) {
	if (!Number.isFinite(value)) return 24;
	return Math.max(MAX_REF_IMAGES_BOUNDS.min, Math.min(MAX_REF_IMAGES_BOUNDS.max, Math.round(value)));
}
/** 距上次请求超过这么久就算"歇过了"，连续计数归零。 */
const LONG_RUN_IDLE_RESET_MS = 12e4;
/** 设置页滑块的取值上限。 */
const MAX_INTERVAL_MS = 3e4;
/** 攒够几个：默认 6~10（均值 8，等于旧默认）。 */
const DEFAULT_CLEANUP_BATCH = {
	min: 6,
	max: 10
};
/** 从第一个会话入队起最多等多久：默认 60~120 秒（均值 90s，等于旧默认）。 */
const DEFAULT_CLEANUP_DELAY_MS = {
	min: 6e4,
	max: 12e4
};
/** 两次删除之间的间隔：默认 0.8~2.5 秒。
*  新增项 —— 批量删除不被服务端接受时会退化成"逐个删"，原来那串请求中间**没有间隔**。 */
const DEFAULT_CLEANUP_GAP_MS = {
	min: 800,
	max: 2500
};
/** 各区间允许被设置到的范围（设置页滑块也按这个画）。 */
const CLEANUP_BATCH_BOUNDS = {
	min: 1,
	max: 50
};
const CLEANUP_DELAY_BOUNDS_MS = {
	min: 5e3,
	max: 6e5
};
const CLEANUP_GAP_BOUNDS_MS = {
	min: 0,
	max: 6e4
};
/**
* 把任意输入规整成一个合法区间：非数忽略、按 bounds 夹住、**上下限颠倒时自动交换**。
* 返回 undefined 表示"这个字段不合法、当没给"（调用方回落到默认）。
*/
function normalizeCleanupRange(value, bounds) {
	if (!value || typeof value !== "object") return void 0;
	const raw = value;
	const lo = Number(raw.min);
	const hi = Number(raw.max);
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return void 0;
	const clamp = (n) => Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)));
	return {
		min: clamp(Math.min(lo, hi)),
		max: clamp(Math.max(lo, hi))
	};
}
/** 把任意输入规整成合法间隔：非数 → 默认，负 → 0，超上限 → 上限。 */
function clampInterval(value) {
	if (!Number.isFinite(value)) return DEFAULT_MIN_REQUEST_INTERVAL_MS;
	return Math.min(MAX_INTERVAL_MS, Math.max(0, Math.floor(value)));
}
function createRequestGate(options = {}) {
	let allowConcurrent = options.allowConcurrent === true;
	let longRunThreshold = options.longRunThreshold ?? 15;
	let longRunBreakMs = options.longRunBreakMs;
	/** 连续请求计数（长休后、或歇够了之后归零）。 */
	let consecutive = 0;
	let minIntervalMs = clampInterval(options.minIntervalMs ?? (options.maxIntervalMs !== void 0 ? options.maxIntervalMs : 2e3));
	let maxIntervalMs = clampInterval(options.maxIntervalMs ?? (options.minIntervalMs !== void 0 ? options.minIntervalMs : 4e3));
	if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
	const random = options.random ?? Math.random;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const logger = options.logger;
	/** 队尾：每个调用完成后才 resolve，保证 FIFO 且「上一个没结束就不放行下一个」。 */
	let tail = Promise.resolve();
	let running = 0;
	let waiting = 0;
	let lastFinishedAt = 0;
	/** 是否已经有调用结束过 —— 首次调用不该被间隔规则拖住。 */
	let hasFinished = false;
	async function acquire(label = "call", signal) {
		let releaseMine;
		const mine = new Promise((resolve) => {
			releaseMine = resolve;
		});
		const prev = tail;
		tail = prev.then(() => mine);
		const aborted = () => {
			const error = /* @__PURE__ */ new Error(`「${label}」在闸门等待中被取消`);
			error.name = "AbortError";
			return error;
		};
		/** 让等待可被中断：abort 时立刻 reject，不等定时器/前序请求。 */
		const waitOrAbort = (inner) => {
			if (!signal) return inner.then(() => void 0);
			if (signal.aborted) return Promise.reject(aborted());
			return new Promise((resolve, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					reject(aborted());
				};
				signal.addEventListener("abort", onAbort, { once: true });
				inner.then(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				});
			});
		};
		waiting += 1;
		try {
			if (signal?.aborted) throw aborted();
			if (!allowConcurrent) {
				if (running > 0 || waiting > 1) logger?.debug?.(`deepseek-web: 「${label}」排队等待（前面还有 ${running} 个在跑 / ${waiting - 1} 个在等）`);
				await waitOrAbort(prev);
			}
			if (hasFinished && now() - lastFinishedAt > LONG_RUN_IDLE_RESET_MS) consecutive = 0;
			const breakRange = longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS;
			const needsBreak = longRunThreshold > 0 && consecutive > 0 && consecutive >= longRunThreshold;
			const gap = needsBreak ? Math.round(breakRange.min + random() * Math.max(0, breakRange.max - breakRange.min)) : nextGap();
			if (hasFinished && (needsBreak || maxIntervalMs > 0)) {
				const waitMs = lastFinishedAt + gap - now();
				if (needsBreak) logger?.info?.(`deepseek-web: 已连续 ${longRunThreshold} 次请求 —— 长休 ${Math.round(gap / 1e3)}s 再继续（长任务保护：连续跑比间隔小更像脚本）`);
				if (waitMs > 0) {
					if (!needsBreak) logger?.info?.(`deepseek-web: 距上次请求不足 ${gap}ms（区间 ${minIntervalMs}~${maxIntervalMs}），等 ${Math.round(waitMs)}ms 再发「${label}」（防账号级限流）`);
					await waitOrAbort(sleep(waitMs));
				}
			}
			if (signal?.aborted) throw aborted();
			if (needsBreak) consecutive = 0;
		} catch (error) {
			releaseMine();
			throw error;
		} finally {
			waiting -= 1;
		}
		running += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			running -= 1;
			lastFinishedAt = now();
			hasFinished = true;
			consecutive += 1;
			releaseMine();
		};
	}
	/** 本次实际使用的间隔：区间内随机；上下限相等则固定。 */
	function nextGap() {
		if (maxIntervalMs <= minIntervalMs) return minIntervalMs;
		return Math.round(minIntervalMs + random() * (maxIntervalMs - minIntervalMs));
	}
	/** 会话清理策略不在本模块实现，只借用设置文件存储（由宿主读取后交给 cleaner）。 */
	/** prompt 字符上限（同 cleanupMode：只是存着，执行在 adapter）。 */
	let maxPromptChars = clampMaxPromptChars(options.maxPromptChars ?? 4e5);
	let maxRefImages = clampMaxRefImages(options.maxRefImages ?? 24);
	let cleanupMode = options.sessionCleanup;
	let cleanupBatch = normalizeCleanupRange(options.cleanupBatch, CLEANUP_BATCH_BOUNDS);
	let cleanupDelayMs = normalizeCleanupRange(options.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS);
	let cleanupGapMs = normalizeCleanupRange(options.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS);
	function settings() {
		return {
			allowConcurrent,
			minRequestIntervalMs: minIntervalMs,
			maxRequestIntervalMs: maxIntervalMs,
			...cleanupMode ? { sessionCleanup: cleanupMode } : {},
			...cleanupBatch ? { cleanupBatch } : {},
			...cleanupDelayMs ? { cleanupDelayMs } : {},
			...cleanupGapMs ? { cleanupGapMs } : {},
			longRunThreshold,
			...longRunBreakMs ? { longRunBreakMs } : {},
			maxPromptChars,
			maxRefImages
		};
	}
	function configure(next) {
		if (typeof next.allowConcurrent === "boolean") allowConcurrent = next.allowConcurrent;
		if (next.minRequestIntervalMs !== void 0) minIntervalMs = clampInterval(Number(next.minRequestIntervalMs));
		if (next.maxRequestIntervalMs !== void 0) maxIntervalMs = clampInterval(Number(next.maxRequestIntervalMs));
		if (next.sessionCleanup !== void 0) cleanupMode = next.sessionCleanup;
		if (next.maxPromptChars !== void 0) maxPromptChars = clampMaxPromptChars(Number(next.maxPromptChars));
		if (next.maxRefImages !== void 0) maxRefImages = clampMaxRefImages(Number(next.maxRefImages));
		if (next.cleanupBatch !== void 0) {
			const value = normalizeCleanupRange(next.cleanupBatch, CLEANUP_BATCH_BOUNDS);
			if (value) cleanupBatch = value;
		}
		if (next.cleanupDelayMs !== void 0) {
			const value = normalizeCleanupRange(next.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS);
			if (value) cleanupDelayMs = value;
		}
		if (next.cleanupGapMs !== void 0) {
			const value = normalizeCleanupRange(next.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS);
			if (value) cleanupGapMs = value;
		}
		if (next.longRunThreshold !== void 0 && Number.isFinite(next.longRunThreshold)) longRunThreshold = Math.max(LONG_RUN_THRESHOLD_BOUNDS.min, Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, Math.round(next.longRunThreshold)));
		if (next.longRunBreakMs !== void 0) {
			const value = normalizeCleanupRange(next.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS);
			if (value) longRunBreakMs = value;
		}
		if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs;
		logger?.info?.(`deepseek-web: 请求节流设置已更新 —— ${allowConcurrent ? "允许并发（不推荐）" : "串行"} · 间隔 ${minIntervalMs}~${maxIntervalMs}ms（随机）` + (cleanupBatch ? ` · 清理阈值 ${cleanupBatch.min}~${cleanupBatch.max} 个` : "") + (cleanupDelayMs ? ` · 最长等待 ${Math.round(cleanupDelayMs.min / 1e3)}~${Math.round(cleanupDelayMs.max / 1e3)}s` : "") + (cleanupGapMs ? ` · 删除间隔 ${cleanupGapMs.min}~${cleanupGapMs.max}ms` : "") + ` · 长任务保护 ${longRunThreshold > 0 ? `每 ${longRunThreshold} 次长休 ${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).min / 1e3)}~${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).max / 1e3)}s` : "关闭"}`);
		return settings();
	}
	return {
		acquire,
		stats: () => ({
			running,
			waiting,
			lastFinishedAt
		}),
		settings,
		configure
	};
}

//#endregion
//#region src/providers/account-ctx.ts
var account_ctx_exports = /* @__PURE__ */ __exportAll({
	clearActiveAuth: () => clearActiveAuth,
	commitCapturedAuth: () => commitCapturedAuth,
	readActiveAuth: () => readActiveAuth
});
/** 当前生效的登录凭证（没有 → undefined）。 */
function readActiveAuth() {
	return readAuth();
}
/** 捕获/校验成功后落库并切为当前账号。 */
function commitCapturedAuth(auth) {
	const normalized = withVerifiedIdentity(auth, auth.user);
	writeAuth(normalized);
	return normalized;
}
/** 清除当前账号凭证（不动浏览器分区的登录态 —— 那是 login 命令的事）。 */
function clearActiveAuth() {
	clearAuth();
}

//#endregion
//#region src/core/context-feed.ts
/** 默认每轮重发全量 —— 与 0.1.61 及以前的行为一致，不改动既有用户。 */
const DEFAULT_CONTEXT_MODE = "full";
/** 严格前缀：prev 是 next 的前缀（含相等时不算"追加"）。 */
function isStrictPrefix(prev, next) {
	if (next.length <= prev.length) return false;
	for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return false;
	return true;
}
/**
* 决定本轮发什么。**纯函数**：不读文件、不看时间、不改全局状态。
*
* 判据宁可保守：只要能续链就发增量，任何一处不确定都退回"全量 + parent=null"
* （退回去只是多花点 token，和以前行为一致；错续链则会让模型上下文错位，代价大得多）。
*/
function decideFeed(input) {
	const full = input.full;
	if (input.mode !== "chained") return {
		prompt: full,
		parentMessageId: null,
		next: void 0,
		reason: "mode-full"
	};
	const head = input.head;
	const entries = input.entries;
	if (typeof head !== "string" || !Array.isArray(entries)) return {
		prompt: full,
		parentMessageId: null,
		next: void 0,
		reason: "no-parts"
	};
	const restart = (reason) => ({
		prompt: full,
		parentMessageId: null,
		next: {
			head,
			entries: entries.slice(),
			sessionId: input.sessionId,
			accountKey: input.accountKey
		},
		reason
	});
	if (!input.reused) return restart("new-session");
	const chain = input.chain;
	if (!chain) return restart("no-chain");
	if (chain.sessionId !== input.sessionId) return restart("session-changed");
	if (chain.accountKey !== input.accountKey) return restart("account-changed");
	if (chain.head !== head) return restart("head-changed");
	if (!isStrictPrefix(chain.entries, entries)) return restart("not-appended");
	const delta = entries.slice(chain.entries.length).join("\n\n");
	if (delta.trim().length === 0) return restart("empty-delta");
	const cap = input.maxChars;
	if (typeof cap === "number" && Number.isFinite(cap) && cap > 0 && delta.length > cap) return restart("delta-too-long");
	return {
		prompt: delta,
		parentMessageId: chain.parentId,
		next: {
			head,
			entries: entries.slice(),
			sessionId: input.sessionId,
			accountKey: input.accountKey
		},
		reason: "chained"
	};
}
let currentMode = DEFAULT_CONTEXT_MODE;
/** 取当前生效的模式（即时生效，无需重启）。 */
function currentContextMode() {
	return currentMode;
}

//#endregion
//#region src/core/webapi.ts
/**
* DeepSeek 网页版 (chat.deepseek.com) API 客户端：
* PoW SHA3 WASM 求解 + chat_session 生命周期 + /chat/completion SSE 流式解析。
*
* 协议依据（2026 年多个活跃逆向实现交叉验证）：
*   POST /api/v0/chat/create_pow_challenge  {target_path} → data.biz_data.challenge
*   POST /api/v0/chat_session/create        {}            → data.biz_data.chat_session.id
*   POST /api/v0/chat_session/delete        {chat_session_id}
*   POST /api/v0/chat/completion            {chat_session_id, parent_message_id:null, prompt,
*                                            ref_file_ids:[], thinking_enabled, search_enabled,
*                                            model_type, action:null, preempt:false}
*   请求头：Authorization: Bearer <token>、Cookie、x-hif-*、x-ds-pow-response
*   SSE 负载为 patch 流：
*     {"v":{"response":{...}}}                  完整快照（fragments / content）
*     {"p":"response/fragments","o":"APPEND","v":{type,content}}
*     {"p":"response/fragments/-1/content","v":"…"}
*     {"p":"response/thinking_content","v":"…"} 旧格式：思考直连
*     {"p":"response/content","v":"…"}          旧格式：正文直连
*     {"v":"…"} / {"o":"APPEND","v":"…"}        承接上一个 path 的续段
*     {"p":"response/status","v":"FINISHED"}    状态
*/
const DS_BASE = "https://chat.deepseek.com";
/** PoW 求解器 WASM 的已知默认地址（页面资源捕获失败时兜底）。 */
const DEFAULT_WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
/** 浏览器 UA 兜底（捕获失败时使用）。 */
const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/**
* 组装一次网页端请求的头。
* 优先复用登录时捕获的浏览器真实头（extraHeaders），再用最新登录态覆盖
* authorization/cookie/指纹；user-agent 采用浏览器值（网页端接口需要浏览器指纹），
* DSH 归属信息通过 `x-deepseek-harness` 头显式声明。
*/
function buildDsHeaders(auth, referer) {
	const headers = {
		"user-agent": auth.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		accept: "application/json, text/plain, */*",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		"content-type": "application/json",
		origin: DS_BASE,
		referer: referer || `${"https://chat.deepseek.com"}/`,
		"x-client-platform": "web",
		"x-client-version": "2.0.0",
		"x-app-version": "2.0.0",
		...auth.extraHeaders ?? {}
	};
	headers.authorization = `Bearer ${auth.token}`;
	headers["content-type"] = "application/json";
	headers.origin = DS_BASE;
	headers.referer = referer || `${"https://chat.deepseek.com"}/`;
	headers["user-agent"] = auth.userAgent || headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
	headers["x-deepseek-harness"] = "deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness); provider=deepseek-web";
	delete headers["x-ds-pow-response"];
	if (auth.cookie) headers.cookie = auth.cookie;
	else delete headers.cookie;
	if (auth.hifDliq) headers["x-hif-dliq"] = auth.hifDliq;
	if (auth.hifLeim) headers["x-hif-leim"] = auth.hifLeim;
	return headers;
}
/** 网页端统一信封：code===0 为成功；非 0 时 msg 是给用户看的诊断。 */
function envelopeError(json) {
	if (!json || typeof json !== "object") return void 0;
	const code = json.code;
	if (typeof code === "number" && code !== 0) return {
		code,
		msg: String(json.msg ?? json.message ?? "unknown error")
	};
	const bizCode = json.data?.biz_code;
	if (typeof bizCode === "number" && bizCode !== 0) {
		const bizMsg = json.data?.biz_msg;
		return {
			code: bizCode,
			msg: bizMsg === void 0 || bizMsg === null || bizMsg === "" ? "unknown error" : String(bizMsg)
		};
	}
}
/**
* 账号被临时限制判定（实测 2026-09-11）：
*   {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted",
*                     "biz_data":{"is_muted":1,"mute_until":1789173841.894}}}
* 这是**服务端对账号的限制**（免费网页端对高频自动化调用的静默限流），不是插件 bug：
* 登录态有效、建会话也成功，只有 completion 被拒。必须把解除时间明确告诉用户，
* 并且**不要空转重试** —— 否则每一轮都白发请求，还可能延长限制。
*/
function isMutedError(biz) {
	return biz?.code === 5 || /user\s+is\s+muted|account\s+is\s+muted/i.test(String(biz?.msg ?? ""));
}
/** 从响应信封里读出解除限制的时间（ms）；读不到返回 undefined。 */
function muteUntilMs(json) {
	const raw = json?.data?.biz_data?.mute_until;
	const seconds = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) return void 0;
	return Math.round(seconds * 1e3);
}
/** 被限制时的用户可读文案（带解除时间）。 */
function mutedMessage(untilMs) {
	if (untilMs === void 0) return "DeepSeek 网页端已临时限制本账号（user is muted），未给出解除时间。这期间任何网页模型调用都会失败；请等待解除，或改用官方 API key。";
	return `DeepSeek 网页端已临时限制本账号（user is muted）：预计 ${new Date(untilMs).toLocaleString("zh-CN", { hour12: false })} 解除，约 ${Math.max(1, Math.round((untilMs - Date.now()) / 6e4))} 分钟后。这期间任何网页模型调用都会失败（登录态本身有效、建会话也正常，只有发消息被拒）；请等待解除，或改用官方 API key。免费网页端对高频自动化调用会静默限流，刚跑过大量工具步骤的会话尤其容易被限。`;
}
/**
* 「同一账号同时只能生成一条」的并发拒绝（实测 2026-09-11：两个 DSH 窗口共用同一网页账号，
* 一个正在生成时另一个发请求即得此错：`A message is being generated, please try again later.`）。
* 它**不是封号**（封号是 `user is muted`），但也无法立刻成功 ——
* 归为可重试的 RATE_LIMIT，交由 dsh-llm-retry 稍后自动重发，而不是让整轮直接失败。
*/
function isBusyGenerating(message) {
	return /being generated|try again later|请稍后再试|稍后再试|正在生成/i.test(String(message ?? ""));
}
/**
* 连续节流的状态：被限一次就退避久一点，别在限流窗口里反复撞。
* （实测 2026-09-11 下午：同一个账号连续被限，5 次重试全落在窗口里 → 整轮失败。）
*/
/**
* 当前使用的 fetch 实现。
*
* 默认是 Node 的全局 fetch（undici）。宿主可以注入 **Electron 的 `net.fetch`** ——
* 后者走 Chromium 原生网络库，能带来与真实浏览器一致的 TLS / HTTP2 指纹。
* 为什么在意：实测 Node fetch 与 Chrome 的指纹差异是**结构性**的
* （JA4 的 h1 vs h2、Node 无 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同）。
*
* 注意：Electron 的 utility 进程里 `require('electron')` 只暴露 `net` 与 `systemPreferences`
* （实测 2026-09-12），所以宿主只能注入 net.fetch，拿不到别的网络相关能力。
*/
let injectedFetch;
/**
* 实际发请求用的 fetch —— 刻意做成**每次现取**（`injectedFetch ?? fetch`），
* 而不是在模块加载那一刻把全局 fetch 固化下来。
*
* 原因（2026-09-12 实测踩到）：固化写法会让「模块加载之后再替换 globalThis.fetch」失效 ——
* 单测正是用这种方式打桩，结果请求绕过了桩件、**真的发到了线上**
* （拿回一个 INVALID_TOKEN，测试看着在验证错误分类，实际在打网络）。
*/
function activeFetch(input, init) {
	return (injectedFetch ?? fetch)(input, init);
}
let throttleStreak = 0;
let lastThrottleAt = 0;
/** 取下一次节流退避（ms）：20s 起、每次翻倍、上限 90s，并加 0~30% 抖动。 */
function throttleBackoffMs(now = Date.now()) {
	if (now - lastThrottleAt > 3e5) throttleStreak = 0;
	const base = Math.min(2e4 * 2 ** throttleStreak, 9e4);
	return base + Math.round(base * .3 * Math.random());
}
/** 记录一次节流；返回本次应给的退避（ms）。 */
function noteThrottled(now = Date.now()) {
	if (now - lastThrottleAt > 3e5) throttleStreak = 0;
	throttleStreak += 1;
	lastThrottleAt = now;
	return throttleBackoffMs(now);
}
/**
* 账号级节流：「发得太频繁」。
*
* 实测 2026-09-11 16:11（SSE error 事件，不是 HTTP 429）：
*   `消息发送过于频繁，请稍后重试`
* ⚠️ 注意它和上面那条**差一个字**：并发拒绝写的是「请稍后再**试**」，节流写的是「请稍后**重**试」。
* 之前只匹配前者，于是这条落到 PROVIDER_ERROR（**不可重试**）→ 整轮直接失败、只能手点「继续」。
*
* 与 `user is muted`（有明确解除时间）也不是一回事：节流是短时的，退避够久就能过去。
* 退避给 20s（并发那条只给 5s）：撞得越勤越可能延长限制。
*/
function isThrottled(message) {
	return /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试|限流/i.test(String(message ?? ""));
}
/**
* 会话失效判定：服务端用 biz_msg 表达「这个 chat_session_id 不存在/无效」。
* 触发场景（实测）：请求发出前会话已被删除（旧版把删除排在建会话之后 1.5s，
* 而 PoW 求解 + 建连可能超过 1.5s），或服务端自行回收了闲置会话。
* 这类失败**可以透明恢复**：本插件每次调用都是全新会话、不依赖服务端历史 → 换个会话重发即可。
*/
function isInvalidSessionError(biz) {
	return /invalid\s+chat\s+session|chat\s+session\s+(?:not\s+found|expired|invalid)|chat_session_id[^\p{L}]{0,4}(?:无效|不存在|已过期|非法)|会话.{0,8}(?:无效|不存在|已过期)/iu.test(String(biz?.msg ?? ""));
}
/** 业务错误码 → 稳定错误码（40003/40001：授权失败）。 */
function bizErrorCode(code) {
	if (code === 40003 || code === 40001) return "AUTH";
	if (code === 429) return "RATE_LIMIT";
	return "PROVIDER_ERROR";
}
function bizErrorMessage(code, msg) {
	if (code === 40003 || code === 40001) return `DeepSeek 网页授权失败：${msg} —— 登录态已过期或无效，请到「设置 → DeepSeek 网页登录」重新登录`;
	return `DeepSeek 网页端错误（code ${code}）：${msg}`;
}
let wasmModuleCache = null;
/** 已验证可用/已发现的 WASM 地址（按凭证里记录的原值缓存，避免每次请求都探测）。 */
let resolvedWasmUrl = null;
async function readOfficialResource(url, max, outer) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.hostname !== "deepseek.com" && !parsed.hostname.endsWith(".deepseek.com")) throw new Error("非官方资源地址");
	const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3);
	const resp = await activeFetch(parsed.href, {
		signal,
		redirect: "error"
	});
	if (!resp.ok || !resp.body) {
		await resp.body?.cancel();
		throw new Error(`资源请求失败 HTTP ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.byteLength;
			if (size > max) throw new Error("资源超过字节上限");
			chunks.push(item.value);
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}
async function isReachable(url, outer) {
	if (!checkedWasmUrl(url)) return false;
	const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(1e4)]) : AbortSignal.timeout(1e4);
	let resp;
	try {
		resp = await activeFetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
			signal,
			redirect: "error"
		});
		return resp.ok;
	} catch {
		if (outer?.aborted) outer.throwIfAborted();
		return false;
	} finally {
		try {
			await resp?.body?.cancel();
		} catch {}
	}
}
/** 从网页端首页/JS chunk 里发现当前构建的 sha3 wasm 地址（哈希随版本变化）。 */
async function discoverWasmUrl(signal) {
	const decode = (bytes) => new TextDecoder().decode(bytes);
	const find = (text, base) => {
		for (const match of text.matchAll(/[^"'\s<>]*sha3[_a-z0-9.]*\.wasm/gi)) try {
			const url = checkedWasmUrl(new URL(match[0], base).href);
			if (url) return url;
		} catch {}
	};
	try {
		signal?.throwIfAborted();
		const html = decode(await readOfficialResource(`${DS_BASE}/`, 2097152, signal));
		const direct = find(html, `${DS_BASE}/`);
		if (direct) return direct;
		const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].slice(0, 8);
		for (const match of scripts) {
			signal?.throwIfAborted();
			try {
				const url = new URL(match[1], `${DS_BASE}/`).href;
				const found = find(decode(await readOfficialResource(url, 8388608, signal)), url);
				if (found) return found;
			} catch {
				if (signal?.aborted) signal.throwIfAborted();
			}
		}
	} catch {
		if (signal?.aborted) signal.throwIfAborted();
	}
}
/**
* 解析可用的 PoW WASM 地址：凭证记录值 → 已知默认值 → 页面发现。
* 结果按凭证原值缓存一次，避免每个请求都做探测。
*/
async function resolveWasmUrl(auth, signal) {
	const key = auth.wasmUrl || "";
	if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url;
	const fromAuth = checkedWasmUrl(auth.wasmUrl);
	if (auth.wasmUrl && !fromAuth) lastWasmUrlRejection = auth.wasmUrl;
	const candidates = [fromAuth, checkedWasmUrl(DEFAULT_WASM_URL)].filter((url) => !!url);
	for (const url of candidates) if (await isReachable(url, signal)) {
		resolvedWasmUrl = {
			key,
			url
		};
		return url;
	}
	const discovered = checkedWasmUrl(await discoverWasmUrl(signal));
	if (discovered) {
		resolvedWasmUrl = {
			key,
			url: discovered
		};
		return discovered;
	}
	return fromAuth ?? checkedWasmUrl("https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm") ?? "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
}
/**
* F12（2026-09-12 审计）：PoW WASM 地址的白名单校验。
*
* 为什么需要：`auth.wasmUrl` 主要来自**导入的账号备份**，可被构造成任意地址
* （审计已复现：可打内网 / 云元数据 / file: 协议）。Electron 的 net.fetch 支持的
* 协议比 Node fetch 更宽，不能把后者的协议限制当成统一边界。
*
* 为什么只限到 deepseek.com 而不是写死单个主机：默认地址里带内容哈希
* （sha3_wasm_bg.7b9ca65ddd.wasm），官方一改就失效；而 `wasmUrl` 实际上**不是**
* 浏览器抓来的（browser-login 里恒为空），页面发现（discoverWasmUrl）是唯一的
* 兜底路径。所以保留发现能力，只把「能不能用」收白名单，既挡 SSRF 又留后路。
*/
const MAX_WASM_BYTES = 8388608;
/** 最近一次被白名单拒绝的凭证 wasmUrl（诊断/单测用；本模块无日志器，留状态而不是打日志）。 */
let lastWasmUrlRejection;
/** 合法则返回规范化后的地址，否则返回 undefined（调用方负责回退并告警）。 */
function checkedWasmUrl(raw) {
	if (typeof raw !== "string" || !raw) return void 0;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	if (url.protocol !== "https:") return void 0;
	if (url.username || url.password) return void 0;
	if (url.port && url.port !== "443") return void 0;
	const host = url.hostname.toLowerCase();
	if (host !== "deepseek.com" && !host.endsWith(".deepseek.com")) return void 0;
	if (!url.pathname.toLowerCase().endsWith(".wasm")) return void 0;
	return url.href;
}
async function loadWasmModule(wasmUrl) {
	const url = checkedWasmUrl(wasmUrl);
	if (!url) throw new Error("非法 WASM 地址");
	if (wasmModuleCache?.url === url) return wasmModuleCache.promise;
	const promise = (async () => WebAssembly.compile(await readOfficialResource(url, MAX_WASM_BYTES)))();
	wasmModuleCache = {
		url,
		promise
	};
	promise.catch(() => {
		if (wasmModuleCache?.promise === promise) wasmModuleCache = null;
		if (resolvedWasmUrl?.url === url) resolvedWasmUrl = null;
	});
	return promise;
}
/**
* 调用 DeepSeek 的 sha3_wasm_bg 求解 PoW。
* wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)；
* prefix = `${salt}_${expire_at}_`；返回 float64 答案（取整）。
*/
async function solvePoW(challenge, wasmUrl) {
	const module = await loadWasmModule(wasmUrl);
	const e = (await WebAssembly.instantiate(module, { wbg: {} })).exports;
	if (typeof e.wasm_solve !== "function" || typeof e.__wbindgen_export_0 !== "function" || !e.memory) throw new Error("PoW WASM exports missing (wasm_solve / __wbindgen_export_0 / memory)");
	const encoder = new TextEncoder();
	const cBytes = encoder.encode(challenge.challenge);
	const pBytes = encoder.encode(`${challenge.salt}_${challenge.expire_at}_`);
	const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
	const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
	new Uint8Array(e.memory.buffer).set(cBytes, cP);
	new Uint8Array(e.memory.buffer).set(pBytes, pP);
	const sp = e.__wbindgen_add_to_stack_pointer(-16);
	e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(challenge.difficulty));
	const dv = new DataView(e.memory.buffer);
	const code = dv.getInt32(sp, true);
	const answer = dv.getFloat64(sp + 8, true);
	e.__wbindgen_add_to_stack_pointer(16);
	if (code === 0 || !Number.isFinite(answer) || answer <= 0) throw new Error(`PoW solve failed (code=${code})`);
	return Math.floor(answer);
}
/** 取得一次完成请求的 PoW 响应头值（base64 JSON）。 */
async function createPowHeader(auth, targetPath, signal) {
	let resp;
	try {
		resp = await activeFetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
			method: "POST",
			headers: buildDsHeaders(auth),
			body: JSON.stringify({ target_path: targetPath }),
			signal
		});
	} catch (error) {
		throw new AdapterLlmError(`DeepSeek PoW challenge request failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
	}
	const text = await resp.text();
	if (!resp.ok) {
		const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
		throw new AdapterLlmError(`DeepSeek PoW challenge failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`, httpErrorCode(resp.status), {
			status: resp.status,
			...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {}
		});
	}
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new AdapterLlmError("DeepSeek PoW challenge returned non-JSON", "MALFORMED_RESPONSE", { status: resp.status });
	}
	const biz = envelopeError(json);
	if (biz) throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status });
	const challenge = json?.data?.biz_data?.challenge;
	if (!challenge?.challenge || !challenge?.salt || !challenge?.signature) throw new AdapterLlmError("DeepSeek PoW challenge missing fields（登录态可能已过期，或被要求人机校验）", "MALFORMED_RESPONSE", { status: resp.status });
	const answer = await solvePoW(challenge, await resolveWasmUrl(auth, signal));
	const payload = JSON.stringify({
		algorithm: challenge.algorithm,
		challenge: challenge.challenge,
		salt: challenge.salt,
		answer,
		signature: challenge.signature,
		target_path: targetPath
	});
	return Buffer.from(payload).toString("base64");
}
/** 上传一张图片，返回 file_id。`data` 为原始编码字节（png/jpeg/webp/gif）。 */
async function uploadImageFile(auth, input, signal) {
	const targetPath = "/api/v0/file/upload_file";
	const powHeader = await createPowHeader(auth, targetPath, signal);
	const headers = { ...buildDsHeaders(auth) };
	delete headers["content-type"];
	headers["x-ds-pow-response"] = powHeader;
	const form = new FormData();
	const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
	form.append("file", new Blob([bytes], { type: input.mediaType || "image/png" }), input.name || "image.png");
	let resp;
	try {
		resp = await activeFetch(`${DS_BASE}${targetPath}`, {
			method: "POST",
			headers,
			body: form,
			signal
		});
	} catch (error) {
		throw new AdapterLlmError(`DeepSeek 图片上传失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
	}
	const text = await resp.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = void 0;
	}
	if (!resp.ok) throw new AdapterLlmError(`DeepSeek 图片上传失败 (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`, httpErrorCode(resp.status), { status: resp.status });
	const biz = envelopeError(json);
	if (biz) throw new AdapterLlmError(`DeepSeek 图片上传被拒（code ${biz.code}）：${biz.msg}`, bizErrorCode(biz.code), { status: resp.status });
	const fileId = json?.data?.biz_data?.id ?? json?.data?.id;
	if (typeof fileId !== "string" || !fileId) throw new AdapterLlmError("DeepSeek 图片上传未返回 file_id", "MALFORMED_RESPONSE", { status: resp.status });
	return {
		fileId,
		...input.name ? { name: input.name } : {}
	};
}
/** 新建一个网页端聊天会话，返回 chat_session_id。 */
async function createChatSession(auth, signal) {
	let resp;
	try {
		resp = await activeFetch(`${DS_BASE}/api/v0/chat_session/create`, {
			method: "POST",
			headers: buildDsHeaders(auth),
			body: "{}",
			signal
		});
	} catch (error) {
		throw new AdapterLlmError(`DeepSeek session create failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
	}
	const text = await resp.text();
	if (!resp.ok) {
		const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
		throw new AdapterLlmError(`DeepSeek session create failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ""}`, httpErrorCode(resp.status), {
			status: resp.status,
			...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {}
		});
	}
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new AdapterLlmError("DeepSeek session create returned non-JSON", "MALFORMED_RESPONSE", { status: resp.status });
	}
	const biz = envelopeError(json);
	if (biz) throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status });
	const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id;
	if (typeof id !== "string" || !id) throw new AdapterLlmError("DeepSeek session create missing id", "MALFORMED_RESPONSE", { status: resp.status });
	return id;
}
const DEFAULT_SESSION_CLEANUP = {
	mode: "deferred",
	delayMs: Math.round((DEFAULT_CLEANUP_DELAY_MS.min + DEFAULT_CLEANUP_DELAY_MS.max) / 2),
	batchSize: Math.round((DEFAULT_CLEANUP_BATCH.min + DEFAULT_CLEANUP_BATCH.max) / 2),
	gapMs: Math.round((DEFAULT_CLEANUP_GAP_MS.min + DEFAULT_CLEANUP_GAP_MS.max) / 2),
	batchRange: DEFAULT_CLEANUP_BATCH,
	delayRange: DEFAULT_CLEANUP_DELAY_MS,
	gapRange: DEFAULT_CLEANUP_GAP_MS
};
/**
* 单个请求里最多塞多少个会话 id。
*
* 为什么要有：队列在"清理很慢"时可能积很多（比如你离开两小时后回来，一次 flush 要删几十个）。
* 「一次请求删掉一大批」正是用户担心的事 —— 所以超过这个数就拆成多次，
* 每次之间按随机间隔停一下。
*/
const MAX_IDS_PER_REQUEST = 20;
let sessionLifecycleHook;
function emitSessionLifecycle(event) {
	try {
		sessionLifecycleHook?.(event);
	} catch {}
}
function createSessionCleaner(options = {}) {
	const policy = {
		mode: options.policy?.mode ?? DEFAULT_SESSION_CLEANUP.mode,
		delayMs: Math.max(0, Math.floor(options.policy?.delayMs ?? DEFAULT_SESSION_CLEANUP.delayMs)),
		batchSize: Math.max(1, Math.floor(options.policy?.batchSize ?? DEFAULT_SESSION_CLEANUP.batchSize)),
		gapMs: Math.max(0, Math.floor(options.policy?.gapMs ?? (options.policy?.gapRange ? DEFAULT_SESSION_CLEANUP.gapMs : 0))),
		...options.policy?.batchRange ? { batchRange: options.policy.batchRange } : {},
		...options.policy?.delayRange ? { delayRange: options.policy.delayRange } : {},
		...options.policy?.gapRange ? { gapRange: options.policy.gapRange } : {}
	};
	/** 策略切换时按模式给默认延迟/批量（immediate 用老参数）。 */
	function applyModeDefaults() {
		if (policy.mode === "immediate") {
			policy.delayMs = 1500;
			policy.batchSize = 1;
		} else if (policy.mode === "deferred" && policy.batchSize <= 1) {
			policy.delayMs = policy.delayRange ? pickInt(policy.delayRange) : DEFAULT_SESSION_CLEANUP.delayMs;
			policy.batchSize = policy.batchRange ? pickInt(policy.batchRange) : DEFAULT_SESSION_CLEANUP.batchSize;
		}
	}
	const doFetch = options.fetchImpl ?? fetch;
	const setT = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
	const clearT = options.clearTimeoutImpl ?? ((t) => clearTimeout(t));
	const logger = options.logger;
	let queue = [];
	let timer;
	/** 探测到服务端不接受批量删除后置位 —— 之后一律逐个删，不再浪费请求。 */
	let batchUnsupported = false;
	const random = options.randomImpl ?? Math.random;
	/** 在 [min, max] 里取整数（闭区间）。random 可注入，单测因此可重复。 */
	function pickInt(range) {
		const lo = Math.min(range.min, range.max);
		const hi = Math.max(range.min, range.max);
		if (hi <= lo) return lo;
		return Math.min(hi, lo + Math.floor(random() * (hi - lo + 1)));
	}
	/**
	* 新的一轮清理开始（队列由空变非空）时重新抽：这一轮攒几个、最多等多久。
	*
	* 为什么按"轮"抽而不是每次都抽：阈值与等待时间要在一轮里保持稳定，
	* 否则"攒够 6~10 个"会退化成"好像随时都在触发"。每轮换一组，既有方差又不失节奏。
	*/
	function rollCycle() {
		if (policy.mode !== "deferred") return;
		if (policy.batchRange) policy.batchSize = Math.max(1, pickInt(policy.batchRange));
		if (policy.delayRange) policy.delayMs = Math.max(0, pickInt(policy.delayRange));
	}
	/** 每次要发一个删除请求之前抽一次间隔（顺带记下当前值，供设置页显示）。 */
	function rollGap() {
		policy.gapMs = policy.gapRange ? Math.max(0, pickInt(policy.gapRange)) : Math.max(0, policy.gapMs);
		return policy.gapMs;
	}
	/** 用注入的定时器睡一会儿（单测里就是"等假表被触发"）。 */
	function sleep(ms) {
		if (!(ms > 0)) return Promise.resolve();
		return new Promise((resolve) => {
			setT(() => resolve(), ms)?.unref?.();
		});
	}
	/** 装一次「到点清理」的表（已经装了就不动）。 */
	function armTimer() {
		if (timer !== void 0) return;
		if (policy.mode === "keep") return;
		timer = setT(() => {
			flush();
		}, Math.max(0, policy.delayMs));
		timer?.unref?.();
	}
	/**
	* 服务端"看起来接受了"：HTTP ok 且响应体里没有业务错误信封。
	*
	* 网页端会在 HTTP 200 上裹一层 `{code, msg, data:{biz_code,biz_msg}}` ——
	* 只看 `resp.ok` 会把"其实没删掉"当成成功（F07 踩过这个坑）。
	*/
	async function respLooksOk(resp) {
		let ok = resp.ok;
		if (ok) {
			const text = await resp.text().catch(() => "");
			try {
				const json = text ? JSON.parse(text) : void 0;
				if (json && envelopeError(json)) ok = false;
			} catch {
				ok = false;
			}
		}
		return ok;
	}
	/**
	* 删一个，返回**是否确认删掉** —— 删除回执要用来摘掉"欠删除"日志里的记录
	* （见 session-journal.ts：只有确认删掉才移记录，否则下次启动还来补删）。
	*/
	async function deleteOne(auth, sessionId) {
		try {
			return await respLooksOk(await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
				method: "POST",
				headers: buildDsHeaders(auth),
				body: JSON.stringify({ chat_session_id: sessionId }),
				signal: AbortSignal.timeout(1e4)
			}));
		} catch {
			return false;
		}
	}
	/**
	* 删一批：优先一个请求批量删；服务端不接受则**逐个删**。
	*
	* 逐个删时两个请求之间会停一个随机间隔 —— 原来这里是**连发**（一批 20 个就是 20 个连续请求），
	* 那是最像脚本的部分。
	*/
	async function deleteChunk(batch) {
		if (batch.length === 0) return;
		const firstToken = batch[0].auth?.token;
		const sameAccount = batch.every((item) => item.auth?.token === firstToken);
		if (batch.length > 1 && !batchUnsupported && sameAccount) try {
			if (await respLooksOk(await doFetch(`${"https://chat.deepseek.com"}/api/v0/chat_session/delete`, {
				method: "POST",
				headers: buildDsHeaders(batch[0].auth),
				body: JSON.stringify({ chat_session_ids: batch.map((b) => b.sessionId) }),
				signal: AbortSignal.timeout(15e3)
			}))) {
				for (const item of batch) emitSessionLifecycle({
					kind: "deleted",
					sessionId: item.sessionId
				});
				logger?.debug?.(`deepseek-web: 已批量清理 ${batch.length} 个临时会话（只用了 1 个请求）`);
				return;
			}
			batchUnsupported = true;
			logger?.debug?.("deepseek-web: 服务端不接受批量删除会话，之后改为逐个删除");
		} catch {}
		for (let i = 0; i < batch.length; i += 1) {
			if (i > 0) await sleep(rollGap());
			if (await deleteOne(batch[i].auth, batch[i].sessionId)) emitSessionLifecycle({
				kind: "deleted",
				sessionId: batch[i].sessionId
			});
		}
		logger?.debug?.(`deepseek-web: 已清理 ${batch.length} 个临时会话`);
	}
	/** 真正干活的清理。分片：队列积很多时也不一口气删完（见 MAX_IDS_PER_REQUEST 的说明）。 */
	async function doFlush() {
		if (timer !== void 0) {
			clearT(timer);
			timer = void 0;
		}
		const batch = queue;
		queue = [];
		try {
			if (batch.length === 0) return;
			for (let i = 0; i < batch.length; i += MAX_IDS_PER_REQUEST) {
				if (i > 0) await sleep(rollGap());
				await deleteChunk(batch.slice(i, i + MAX_IDS_PER_REQUEST));
			}
		} catch (error) {
			logger?.debug?.(`deepseek-web: 会话清理出错（已忽略）：${error?.message ?? error}`);
		} finally {
			if (queue.length > 0) armTimer();
		}
	}
	/**
	* 立即清理队列。
	*
	* **串行化**：上一次还没删完时，这一次排在它后面等 —— 否则两轮 flush 的删除请求会交错发出，
	* 正是我们要避免的"连发"。排队的 flush 轮到自己时才取队列，所以能带上期间新攒的会话。
	*/
	let chain = Promise.resolve();
	function flush() {
		chain = chain.then(doFlush, doFlush);
		return chain;
	}
	function schedule(auth, sessionId) {
		if (policy.mode === "keep") return;
		if (queue.length === 0) rollCycle();
		queue.push({
			auth,
			sessionId
		});
		emitSessionLifecycle({
			kind: "queued",
			auth,
			sessionId
		});
		if (policy.mode === "deferred" && queue.length >= policy.batchSize) {
			flush();
			return;
		}
		armTimer();
	}
	function configure(next) {
		const modeChanged = next.mode !== void 0 && next.mode !== policy.mode;
		if (next.mode !== void 0) policy.mode = next.mode;
		if (next.delayMs !== void 0) policy.delayMs = Math.max(0, Math.floor(next.delayMs));
		if (next.batchSize !== void 0) policy.batchSize = Math.max(1, Math.floor(next.batchSize));
		if (next.gapMs !== void 0) policy.gapMs = Math.max(0, Math.floor(next.gapMs));
		for (const key of [
			"batchRange",
			"delayRange",
			"gapRange"
		]) {
			const value = next[key];
			if (value && Number.isFinite(value.min) && Number.isFinite(value.max)) policy[key] = {
				min: Math.floor(Math.min(value.min, value.max)),
				max: Math.floor(Math.max(value.min, value.max))
			};
		}
		if (modeChanged) applyModeDefaults();
		if (policy.mode === "keep") flush();
		logger?.info?.(`deepseek-web: 会话清理策略已更新 —— ${policy.mode}` + (policy.mode === "deferred" ? `（攒 ${policy.batchSize} 个或 ${Math.round(policy.delayMs / 1e3)}s 后清理` + (policy.gapRange ? `；批量删除不受支持时逐个删，间隔 ${policy.gapMs}ms` : "") + "）" : ""));
		return { ...policy };
	}
	return {
		schedule,
		flush,
		pendingCount: () => queue.length,
		policy: () => ({ ...policy }),
		configure
	};
}
/** 默认清理器（immediate 语义，兼容旧调用方）。 */
const defaultCleaner = createSessionCleaner({ policy: {
	mode: "immediate",
	delayMs: 1500,
	batchSize: 1
} });
function scheduleDeleteSession(auth, sessionId) {
	defaultCleaner.schedule(auth, sessionId);
}
function isReasoningType(type) {
	const t = type.toUpperCase();
	return t === "THINK" || t === "REASONING" || t === "THINKING";
}
/** 把字节流切成行（SSE 帧以 \n 分隔）。 */
async function* iterateLines(body) {
	const decoder = new TextDecoder();
	let buffer = "";
	const drain = function* () {
		let idx;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			yield buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
		}
	};
	if (typeof body?.getReader === "function") {
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				yield* drain();
			}
		} finally {
			try {
				reader.releaseLock?.();
			} catch {}
		}
	} else if (body?.[Symbol.asyncIterator]) for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		yield* drain();
	}
	if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}
/** F28：思考的标准包装标签。孤儿兜底用（见 finish 里的判据）。 */
const THINKING_WRAPPER_RE = /<\s*\/?\s*(analysis|summary|thinking|scratchpad|thought)\b/i;
/**
* F28 取证开关：把原始 SSE 逐行落盘，给「孤儿思考归正文」这类通道错位定论用。
* 默认关；设环境变量 `DSH_WEB_LOGIN_DUMP_SSE=1` 开启（需重启 DSH 生效）。
* 文件写到 `~/.dsh/deepseek-web/frames/<时间戳>-<序号>.sse`，逐行 append ——
* 就算进程被强杀，已收到的帧也在盘上（F24 的教训：别用构造帧当证据，要抓真实帧）。
*/
function dumpSinkPath() {
	if (process.env.DSH_WEB_LOGIN_DUMP_SSE !== "1") return null;
	try {
		const dir = join(homedir(), ".dsh", "deepseek-web", "frames");
		mkdirSync(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		return join(dir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.sse`);
	} catch {
		return null;
	}
}
function createSseState(options = {}) {
	const fragments = [];
	/** fragments 派生文本（仅用于快照对账候选）。 */
	let fragmentsText = "";
	let fragmentsThinking = "";
	/** 直连格式的派生文本（仅用于快照对账候选）。 */
	let directText = "";
	let directThinking = "";
	/** 已发射的规范流（只增不减）。 */
	let outText = "";
	let outThinking = "";
	let divergences = 0;
	let sink = null;
	/**
	* F25：通道未知的暂存文本。只在「请求开了思考、但还没出现任何 fragment」时使用
	* —— 正常流不会走到这里（首帧快照就带着 THINK fragment）。
	*/
	let orphanBuffer = "";
	const thinkingEnabled = options.thinkingEnabled === true;
	let pendingFinish;
	let sawData = false;
	/** 服务端上报的本消息 token 总量（见 WebStreamEvent 的 totalTokens 说明）。 */
	let totalTokens;
	const emit = (out, kind, delta) => {
		if (!delta) return;
		if (kind === "text") outText += delta;
		else outThinking += delta;
		out.push({
			kind,
			text: delta
		});
	};
	const emitText = (out, delta) => emit(out, "text", delta);
	const emitThinking = (out, delta) => emit(out, "thinking", delta);
	/**
	* F25：把暂存文本按**刚出现的 fragment 类型**归属并发射。
	*
	* 真实帧（2026-09-14 抓，4 轮同构）显示两条规律：
	*   1. 思考的 fragment 由**首帧快照**建立；正文的 fragment 由 `response/fragments`
	*      的 APPEND 建立（`fragments+1 [RESPONSE]`）；
	*   2. 第一个 RESPONSE fragment 出现之前，流上的内容**全是思考**。
	*
	* 所以无论先到的是 THINK 还是 RESPONSE fragment，暂存的那段都应归思考 ——
	* 正文不会"先于自己的 fragment"出现在流上。这样即使快照整帧丢失，
	* 思考仍会回到思考通道，而不是被当成正文顶到用户脸上。
	*/
	const settleOrphans = (out, firstType) => {
		if (!orphanBuffer) return;
		const text = orphanBuffer;
		orphanBuffer = "";
		if (!isReasoningType(firstType)) {}
		directThinking += text;
		emitThinking(out, text);
	};
	/** 快照对账：只在候选是严格延伸时补差；过期/分歧忽略（宁可漏一次快照，也不吐乱码或丢字）。 */
	const reconcile = (out, kind, candidate) => {
		const current = kind === "text" ? outText : outThinking;
		if (!candidate || candidate === current) return;
		if (candidate.startsWith(current)) {
			emit(out, kind, candidate.slice(current.length));
			return;
		}
		if (current.startsWith(candidate)) return;
		divergences += 1;
	};
	/** 重建 fragments 派生文本（快照覆盖时用）。 */
	const rebuildFragmentText = () => {
		fragmentsText = "";
		fragmentsThinking = "";
		for (const fragment of fragments) if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content;
		else fragmentsText += fragment.content;
	};
	/** 快照：整表替换 + 对账（不直接发射）。 */
	const replaceFragments = (list, out) => {
		fragments.length = 0;
		for (const f of list) if (f && typeof f === "object" && typeof f.content === "string") fragments.push({
			type: String(f.type ?? "RESPONSE"),
			content: f.content,
			emitted: 0
		});
		rebuildFragmentText();
		sink = fragments.length > 0 ? "fragments" : null;
		if (fragments.length > 0) settleOrphans(out, fragments[0].type);
	};
	/** 增量：追加 fragment（其 content 属于新内容 → 直接发射）。 */
	const appendFragments = (incoming, out) => {
		const list = Array.isArray(incoming) ? incoming : incoming !== void 0 ? [incoming] : [];
		let settled = false;
		for (const f of list) {
			if (!f || typeof f !== "object" || typeof f.content !== "string") continue;
			const fragment = {
				type: String(f.type ?? "RESPONSE"),
				content: f.content,
				emitted: 0
			};
			if (!settled) {
				settled = true;
				settleOrphans(out, fragment.type);
			}
			fragments.push(fragment);
			if (isReasoningType(fragment.type)) {
				fragmentsThinking += fragment.content;
				emitThinking(out, fragment.content);
			} else {
				fragmentsText += fragment.content;
				emitText(out, fragment.content);
			}
		}
		sink = fragments.length > 0 ? "fragments" : null;
	};
	/** 增量：续写最后一个 fragment。 */
	const appendToLastFragment = (text, out) => {
		const fragment = fragments[fragments.length - 1];
		if (!fragment) {
			if (sink === "thinking") {
				directThinking += text;
				emitThinking(out, text);
				return;
			}
			if (sink === "content") {
				directText += text;
				emitText(out, text);
				return;
			}
			if (thinkingEnabled) {
				orphanBuffer += text;
				return;
			}
			directText += text;
			emitText(out, text);
			return;
		}
		fragment.content += text;
		if (isReasoningType(fragment.type)) {
			fragmentsThinking += text;
			emitThinking(out, text);
		} else {
			fragmentsText += text;
			emitText(out, text);
		}
	};
	/** 增量：裸续段按当前 sink 归属。 */
	const appendSink = (text, out) => {
		if (sink === "thinking") {
			directThinking += text;
			emitThinking(out, text);
		} else if (sink === "content") {
			directText += text;
			emitText(out, text);
		} else if (sink === "fragments") appendToLastFragment(text, out);
	};
	return {
		/** 负载处理（增量直接发射；快照只对账）。 */
		handlePayload(d, eventName) {
			const out = [];
			sawData = true;
			if (d && typeof d === "object" && typeof d.response_message_id === "number") options.onResponseMessageId?.(d.response_message_id);
			if (d && typeof d === "object" && d.v && typeof d.v === "object" && d.v.response && typeof d.v.response === "object") {
				const response = d.v.response;
				if (Array.isArray(response.fragments)) {
					replaceFragments(response.fragments, out);
					if (fragments.length > 0) {
						reconcile(out, "thinking", fragmentsThinking);
						reconcile(out, "text", fragmentsText);
					}
				}
				if (typeof response.content === "string") {
					directText = response.content;
					sink = "content";
					if (fragments.length === 0) reconcile(out, "text", directText);
				}
				if (response.finish_reason !== void 0 && response.finish_reason !== null) pendingFinish = String(response.finish_reason);
				return out;
			}
			if (d && typeof d === "object" && d.type === "error") {
				const message = typeof d.content === "string" ? d.content : typeof d.message === "string" ? d.message : "model error";
				const event = {
					kind: "error",
					message,
					...d.finish_reason !== void 0 ? { raw: String(d.finish_reason) } : {}
				};
				if (isBusyGenerating(message)) {
					event.code = "RATE_LIMIT";
					event.retryAfterMs = 5e3;
					event.rateLimitKind = "concurrent";
				} else if (isThrottled(message)) {
					event.code = "RATE_LIMIT";
					event.retryAfterMs = noteThrottled();
					event.rateLimitKind = "throttled";
				}
				out.push(event);
				return out;
			}
			if (eventName === "toast") {
				const message = d && typeof d === "object" ? d.content ?? d.message ?? JSON.stringify(d) : String(d);
				const full = `DeepSeek toast: ${String(message).slice(0, 200)}`;
				const event = {
					kind: "error",
					message: full
				};
				if (isBusyGenerating(full)) {
					event.code = "RATE_LIMIT";
					event.retryAfterMs = 5e3;
					event.rateLimitKind = "concurrent";
				} else if (isThrottled(full)) {
					event.code = "RATE_LIMIT";
					event.retryAfterMs = noteThrottled();
					event.rateLimitKind = "throttled";
				}
				out.push(event);
				return out;
			}
			if (eventName === "title") return out;
			if (d && typeof d === "object" && d.finish_reason !== void 0 && d.finish_reason !== null) {
				pendingFinish = String(d.finish_reason);
				return out;
			}
			const path = d?.p;
			const value = d?.v;
			if (typeof path === "string") switch (path) {
				case "response/fragments":
					appendFragments(value, out);
					return out;
				case "response/fragments/-1/content":
					if (typeof value === "string") {
						appendToLastFragment(value, out);
						if (!(fragments.length === 0 && (sink === "thinking" || sink === "content"))) sink = "fragments";
					}
					return out;
				case "response/fragments/-1/elapsed_secs":
					if (typeof value === "number" && value > 0) settleOrphans(out, "THINK");
					return out;
				case "response/thinking_content":
					if (typeof value === "string") {
						directThinking += value;
						emitThinking(out, value);
						sink = "thinking";
					}
					return out;
				case "response/content":
					if (typeof value === "string") {
						directText += value;
						emitText(out, value);
						sink = "content";
					}
					return out;
				case "response/finish_reason":
					if (typeof value === "string") pendingFinish = value;
					return out;
				case "accumulated_token_usage":
					if (typeof value === "number" && Number.isFinite(value)) totalTokens = value;
					return out;
				case "response/status":
					if (typeof value === "string") {
						out.push({
							kind: "status",
							value
						});
						if (value === "FINISHED") pendingFinish = pendingFinish ?? "FINISHED";
					}
					return out;
				case "response":
					if (Array.isArray(value)) for (const op of value) {
						if (op && typeof op === "object" && op.p === "fragments" && op.o === "APPEND" && op.v !== void 0) appendFragments(op.v, out);
						if (op && typeof op === "object" && op.p === "accumulated_token_usage") {
							if (typeof op.v === "number" && Number.isFinite(op.v)) totalTokens = op.v;
						}
					}
					return out;
				default: return out;
			}
			if (typeof value === "string" && value.length > 0) appendSink(value, out);
			return out;
		},
		/** 对外入口（负载已直接发射增量，这里只做兜底对账）。 */
		handle(d, eventName) {
			return this.handlePayload(d, eventName);
		},
		/** 流结束：产出 finish（若确实收到过数据）。 */
		finish() {
			const out = [];
			if (sawData && orphanBuffer) {
				const text = orphanBuffer;
				orphanBuffer = "";
				if (thinkingEnabled && THINKING_WRAPPER_RE.test(text)) {
					directThinking += text;
					emitThinking(out, text);
				} else {
					directText += text;
					emitText(out, text);
				}
			}
			if (!sawData) return out;
			out.push({
				kind: "finish",
				reason: pendingFinish,
				...totalTokens !== void 0 ? { totalTokens } : {}
			});
			return out;
		},
		/** 诊断：已发射正文/思考长度与快照分歧次数（单测与排查用）。 */
		stats() {
			return {
				text: outText,
				thinking: outThinking,
				divergences,
				...orphanBuffer ? { orphanLen: orphanBuffer.length } : {},
				...totalTokens !== void 0 ? { totalTokens } : {}
			};
		}
	};
}
/** 解析 /chat/completion 的 SSE 字节流，产出增量文本/思考事件。 */
async function* parseWebSse(body, options) {
	const state = createSseState(options);
	let eventName = "";
	/**
	* F13（2026-09-12 审计）：SSE 规范允许一个事件里出现**多个** `data:` 行，
	* 收齐后要用 `\n` 拼接再整体解析。旧实现逐行 `JSON.parse`，一旦服务端把一个
	* JSON 拆到多行（或 payload 里本身含换行），每行都解析失败 → 被
	* `catch { continue }` 静默丢弃，表现为「流突然断了/少了一段」且无任何报错。
	*/
	let dataLines = [];
	const flushData = () => {
		if (dataLines.length === 0) return {
			events: [],
			done: false
		};
		const data = dataLines.join("\n").trim();
		dataLines = [];
		if (data.length === 0) return {
			events: [],
			done: false
		};
		if (data === "[DONE]") return {
			events: Array.from(state.finish()),
			done: true
		};
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			return {
				events: [],
				done: false
			};
		}
		return {
			events: Array.from(state.handle(parsed, eventName)),
			done: false
		};
	};
	const dumpPath = dumpSinkPath();
	for await (const line of iterateLines(body)) {
		if (dumpPath) try {
			appendFileSync(dumpPath, line + "\n");
		} catch {}
		if (line.length === 0) {
			const flushed = flushData();
			for (const event of flushed.events) yield event;
			if (flushed.done) return;
			eventName = "";
			continue;
		}
		if (line.startsWith(":")) continue;
		if (line.startsWith("event:")) {
			const flushed = flushData();
			for (const event of flushed.events) yield event;
			if (flushed.done) return;
			eventName = line.slice(6).trim();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trim());
			continue;
		}
	}
	const tail = flushData();
	for (const event of tail.events) yield event;
	if (tail.done) return;
	for (const event of state.finish()) yield event;
}
/**
* 复用一个网页端会话最多发多少次请求，超过就换一个新的；0 = 关闭复用（回到「每请求一个会话」）。
*
* 为什么可以复用（**实测**，不是推理）：
* 每次 completion 都发 `parent_message_id: null` → 每条消息都是会话里的**根消息**、没有父链，
* 服务端按消息树回溯上下文时回溯到空。判定实验（2026-09-12）：同一会话先发
* 「记住编号 ZC-7391-KX，只回 OK」→ 得到 `OK`；再问「编号是什么」→ 答 `不知道`。
* 证明同会话历史**不会**进入上下文。
* （0.1.21 注释里「复用会让上下文翻倍」的说法是未经实测的推理，已被这次实验推翻。）
*
* 收益：实测 2026-09-12 一天建了 182 个网页端会话（峰值 74 个/小时、最密 8 个/分钟），
* 因为每个 DSH 回合 = 建一个会话、用完再删一个 —— 真人不会这样建删对话。
* 复用后建会话数降到「轮次 / N」。
*/
const DEFAULT_SESSION_REUSE_TURNS = 20;
/** 复用槽：同一账号当前可复用的会话。key 是凭证摘要（不进日志、不拿明文当键）。 */
/**
* 复用槽。`cleanup` 记录**这个会话归谁回收**（2026-09-13 审计 N04）：
* 切号时旧槽要交回**原账号**的清理回调，不能用当前账号的去删别人的会话。
*/
let reuseSlot;
/**
* 链式投喂的链状态（2026-09-14）。只跟随**正在复用的那个会话**：
* 会话轮换、切号、请求失败/取消、流被污染，都会让它作废 —— 下一轮自动退回全量重发。
* 判定逻辑在 context-feed.ts（纯函数），这里只负责"喂进去 + 按结果记下来"。
*/
let contextChain;
/**
* 上一次上报过的决策原因（0.1.63）。链式投喂的决策每轮都在做，
* 但"原因"通常连续几百轮都不变 —— 只在**变化时**上报，日志才不会被刷满，
* 同时"哪一轮开始退回全量、为什么"又一定能看见。
*/
let lastFeedReason;
/** 凭证摘要：只用来判断「是不是同一个账号」。不做安全用途、不落日志。 */
function accountKey(auth) {
	const raw = `${auth?.token ?? ""}|${auth?.cookie ?? ""}`;
	let hash = 2166136261;
	for (let i = 0; i < raw.length; i += 1) {
		hash ^= raw.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
async function leaseSession(auth, signal, transport, maxTurns, cleanup) {
	signal.throwIfAborted();
	const key = accountKey(auth);
	const limit = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : 20;
	if (limit === 0) return {
		sessionId: await transport.createSession(auth, signal),
		reused: false
	};
	if (reuseSlot && reuseSlot.key === key && reuseSlot.turns < limit) {
		reuseSlot.turns += 1;
		return {
			sessionId: reuseSlot.sessionId,
			reused: true
		};
	}
	const previous = reuseSlot;
	const sessionId = await transport.createSession(auth, signal);
	if (signal.aborted) {
		try {
			cleanup?.(sessionId);
		} catch {}
		signal.throwIfAborted();
	}
	reuseSlot = {
		key,
		sessionId,
		turns: 1,
		...cleanup ? { cleanup } : {}
	};
	emitSessionLifecycle({
		kind: "leased",
		auth,
		sessionId
	});
	if (previous) try {
		previous.cleanup?.(previous.sessionId);
	} catch {}
	return {
		sessionId,
		reused: false
	};
}
/** 把某个会话从复用槽里摘掉（会话失效 / 请求失败时调用，下次会新建）。 */
function retireSession(sessionId) {
	if (!sessionId || reuseSlot && reuseSlot.sessionId === sessionId) reuseSlot = void 0;
	if (!sessionId || contextChain?.sessionId === sessionId) contextChain = void 0;
}
const defaultTransport = {
	createSession: createChatSession,
	powHeader: createPowHeader
};
/**
* 打开一次 completion 请求（建会话 + PoW + 发送），返回可用的会话与响应。
*
* 非 SSE 响应（HTTP 200 上裹着业务错误信封）在这里统一裁决：
*  - 会话失效（invalid chat session id）→ **换一个新会话透明重试一次**（用户无感）；
*  - 其它业务错误 → 按业务码抛出（AUTH / RATE_LIMIT / PROVIDER_ERROR…）。
*/
async function openCompletion(auth, params, signal, transport) {
	let lastFailure;
	for (let attempt = 0; attempt < 2; attempt++) {
		const lease = await leaseSession(auth, signal, transport, params.sessionReuseTurns ?? 20, params.onDeleteSession);
		const sessionId = lease.sessionId;
		const feed = decideFeed({
			mode: currentContextMode(),
			...params.promptParts ? {
				head: params.promptParts.head,
				entries: params.promptParts.entries,
				...params.promptParts.maxChars !== void 0 ? { maxChars: params.promptParts.maxChars } : {}
			} : {},
			full: params.prompt,
			sessionId,
			accountKey: accountKey(auth),
			reused: lease.reused,
			...contextChain ? { chain: contextChain } : {}
		});
		if (feed.reason !== lastFeedReason) {
			lastFeedReason = feed.reason;
			params.onContextFeed?.({
				reason: feed.reason,
				chained: feed.parentMessageId !== null,
				promptChars: feed.prompt.length
			});
		}
		let resp;
		try {
			resp = await activeFetch(`${DS_BASE}/api/v0/chat/completion`, {
				method: "POST",
				headers: {
					...buildDsHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
					accept: "text/event-stream",
					"x-ds-pow-response": await transport.powHeader(auth, "/api/v0/chat/completion", signal)
				},
				body: JSON.stringify({
					chat_session_id: sessionId,
					parent_message_id: feed.parentMessageId,
					prompt: feed.prompt,
					ref_file_ids: params.refFileIds ?? [],
					thinking_enabled: params.thinkingEnabled,
					search_enabled: params.searchEnabled ?? false,
					model_type: params.modelType,
					action: null,
					preempt: false
				}),
				signal
			});
		} catch (error) {
			retireSession(sessionId);
			params.onDeleteSession?.(sessionId);
			if (error instanceof AdapterLlmError) throw error;
			if (params.signal?.aborted) throw new AdapterLlmError("DeepSeek web request aborted by caller", "ABORTED", { cause: error });
			throw new AdapterLlmError(`DeepSeek web request failed: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			const code = httpErrorCode(resp.status);
			const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
			const hint = code === "AUTH" ? " —— 网页登录态可能已过期，请到「设置 → DeepSeek 网页登录」重新登录" : code === "RATE_LIMIT" ? " —— 网页端频控（免费额度），稍后重试即可" : "";
			retireSession(sessionId);
			params.onDeleteSession?.(sessionId);
			throw new AdapterLlmError(`DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}${hint}`, code, {
				status: resp.status,
				...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {},
				cause: new Error(text)
			});
		}
		if (!resp.body) {
			retireSession(sessionId);
			params.onDeleteSession?.(sessionId);
			throw new AdapterLlmError("DeepSeek web completion returned no body", "EMPTY_RESPONSE");
		}
		const contentType = String(resp.headers.get("content-type") ?? "");
		if (contentType.includes("text/event-stream")) return {
			sessionId,
			resp,
			feed
		};
		const text = await resp.text().catch(() => "");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {}
		const biz = envelopeError(parsed);
		const muted = isMutedError(biz);
		const busy = !muted && !!biz && isBusyGenerating(biz.msg);
		const untilMs = muteUntilMs(parsed);
		const failure = biz ? new AdapterLlmError(muted ? mutedMessage(untilMs) : busy ? "DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口/标签页正在用同一账号生成）。这一步会自动重试；若两个窗口都要用网页模型，建议其中一个换 provider 或换账号。" : bizErrorMessage(biz.code, biz.msg), muted || busy ? "RATE_LIMIT" : isInvalidSessionError(biz) ? "TRANSPORT" : bizErrorCode(biz.code), {
			status: resp.status,
			...muted && untilMs !== void 0 ? { providerRetryAfterMs: Math.max(0, untilMs - Date.now()) } : {},
			...muted && untilMs !== void 0 ? { mutedUntilMs: untilMs } : {},
			...busy ? { providerRetryAfterMs: 5e3 } : {}
		}) : new AdapterLlmError(`DeepSeek 网页端返回了非流式响应（content-type: ${contentType || "unknown"}）：${text.slice(0, 200)}`, "MALFORMED_RESPONSE", { status: resp.status });
		retireSession(sessionId);
		params.onDeleteSession?.(sessionId);
		if (attempt === 0 && biz && isInvalidSessionError(biz)) {
			lastFailure = failure;
			continue;
		}
		throw failure;
	}
	throw lastFailure ?? new AdapterLlmError("DeepSeek 网页端无法建立可用会话", "PROVIDER_ERROR");
}
/**
* 发起一次网页版完成请求并流式产出事件；会话在**流结束之后**尽力删除。
*
* ⚠️ 删除时机是这个模块最容易被写错的地方（2026-09-11 实测故障）：
* 旧实现把 `onDeleteSession` 放在**建会话之后立刻**调用，而它内部是「延迟 1.5s 删除」，
* 于是会话可能在 completion 请求发出之前就被自己删掉 —— 若 PoW 求解 + 建连超过 1.5s，
* 服务端回
*   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
* 更隐蔽的是「生成进行到一半会话消失」，服务端可能直接掐断流 —— 表现就是回答说半句就停、
* 工具调用没收全（正是我们一直在追的那类截断）。
* 现在删除只发生在 finally（流正常结束、报错或调用方中止都算），会话在整个请求期间都活着。
*/
/** 复用模式下的"飞行互斥"：保证同一时刻只有一个复用请求在跑，避免轮换撞上并发。 */
let reuseFlightTail = Promise.resolve();
async function* streamWebCompletion(auth, params, transport = defaultTransport) {
	const controller = new AbortController();
	const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
	const rawLimit = params.sessionReuseTurns ?? 20;
	const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 20;
	let release;
	let sessionId;
	let iterator;
	let body;
	let complete = false;
	let poisoned = false;
	let timer;
	/** 本轮实际发出去了什么（链式投喂据此记账；见 finally 里的链更新）。 */
	let sentFeed;
	/** 首帧 `event: ready` 给的 assistant message_id —— 就是下一轮的 parent_message_id。 */
	let responseMessageId;
	/** 同一个会话只回收一次（复用/轮换/失败三条路径可能都想回收它）。 */
	const deleted = /* @__PURE__ */ new Set();
	const cleanup = (id) => {
		if (deleted.has(id)) return;
		deleted.add(id);
		try {
			params.onDeleteSession?.(id);
		} catch {}
	};
	/** 让等待可被取消：abort 时立刻 reject，不等定时器/对端。 */
	const wait = (promise) => new Promise((resolve, reject) => {
		if (signal.aborted) {
			promise.catch(() => {});
			reject(signal.reason);
			return;
		}
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", abort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", abort);
			reject(error);
		});
	});
	const arm = (ms, message) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new AdapterLlmError(message, "TIMEOUT")), ms);
		timer.unref?.();
	};
	/**
	* F10：外层拥有本次调用创建过的**全部**会话。
	*
	* 建连阶段没有统一限时时，`createSession` 之后、响应头之前的任何失败都会让
	* 「已建出来但还没人认领」的会话漏在服务端；`openCompletion` 内部的失败分支只覆盖
	* 它自己 catch 得到的错误。超时/取消会**放弃**进行中的 `openCompletion`（不再等它），
	* 所以必须在这里兜住它后续才返回的那些会话。
	*/
	const owned = /* @__PURE__ */ new Set();
	let finalized = false;
	const tracked = {
		...transport,
		createSession: async (value, sig) => {
			const id = await transport.createSession(value, sig);
			if (finalized) {
				retireSession(id);
				cleanup(id);
			} else owned.add(id);
			return id;
		}
	};
	try {
		signal.throwIfAborted();
		if (limit > 0) {
			const previous = reuseFlightTail;
			const mine = new Promise((resolve) => {
				release = resolve;
			});
			reuseFlightTail = previous.then(() => mine, () => mine);
			await wait(previous);
		}
		const connectMs = Number.isFinite(params.connectTimeoutMs) && params.connectTimeoutMs > 0 ? Math.min(params.connectTimeoutMs, 6e5) : 45e3;
		arm(connectMs, `DeepSeek 建立流超时（${connectMs}ms）`);
		const opened = await wait(openCompletion(auth, {
			...params,
			sessionReuseTurns: limit,
			onDeleteSession: cleanup
		}, signal, tracked));
		sessionId = opened.sessionId;
		sentFeed = opened.feed;
		body = opened.resp.body;
		if (timer) clearTimeout(timer);
		iterator = parseWebSse(body, {
			thinkingEnabled: params.thinkingEnabled,
			onResponseMessageId: (id) => {
				responseMessageId = id;
			}
		});
		const idle = Number.isFinite(params.idleTimeoutMs) && params.idleTimeoutMs > 0 ? Math.min(params.idleTimeoutMs, 6e5) : 12e4;
		for (;;) {
			arm(idle, `DeepSeek 流等待超时（${idle}ms）`);
			const item = await wait(iterator.next());
			if (timer) clearTimeout(timer);
			if (item.done) {
				complete = true;
				break;
			}
			if (item.value.kind === "error") poisoned = true;
			yield item.value;
		}
	} catch (error) {
		if (params.signal?.aborted) throw new AdapterLlmError("请求已取消", "ABORTED", { cause: error });
		if (controller.signal.aborted && controller.signal.reason instanceof AdapterLlmError) throw controller.signal.reason;
		if (error instanceof AdapterLlmError) throw error;
		throw new AdapterLlmError("DeepSeek 流请求失败", "TRANSPORT", { cause: error });
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
		if (iterator) iterator.return(void 0).catch(() => {}).finally(() => {
			if (body && !body.locked) body.cancel().catch(() => {});
		});
		finalized = true;
		for (const id of owned) {
			if (id === sessionId && complete && !poisoned && limit > 0) continue;
			retireSession(id);
			cleanup(id);
		}
		if (sentFeed?.next && complete && !poisoned && typeof responseMessageId === "number") contextChain = {
			...sentFeed.next,
			parentId: responseMessageId
		};
		else if (contextChain && (!sessionId || contextChain.sessionId === sessionId)) contextChain = void 0;
		release?.();
	}
}

//#endregion
//#region src/core/protocol.ts
/**
* 提示词协议层：
*  1) 把 DSH 的消息词汇（system / user / assistant / tool-result / reasoning / tool-call）
*     序列化成网页端可吃的单段 prompt（网页 API 只有 `prompt` 字符串，无 tools 字段）。
*  2) 工具调用桥：网页模型没有原生 function calling，改用「JSON 协议 + 流式解析」——
*     指令要求模型只输出 {"tool_calls":[{"name":…,"arguments":{…}}]}，
*     本模块在流式文本上做 hold-back 扫描，命中即转成 tool-call 块，不命中则原样透传正文。
*/
/**
* 单个工具描述的上限。
*
* 2026-09-12 从 400 提到 3200。理由：DSH 实际下发 61 个工具，其中 17 个描述超过 400 字符，
* 而**被砍掉的恰恰是最要紧的部分** —— `pwsh` 的 3010 字符里有 2610 个字符在讲
* 「沙箱拒绝（file access denied）是策略判定、不是命令的 bug，别换个方式重试」
* 「命名管道不可用时 stdio:'pipe' 的 spawn 会报 EPERM，同样别换方式」
* 「只读沙箱下 .NET 静态调用 / Add-Type / COM / 反射会失败」这类**遇错该怎么办**的指引；
* `workflow` 的 2500 字符里是 agent() / pipeline() / parallel() 的钩子签名。
* 把它们砍掉，模型一遇错就只能瞎猜 —— 实测这两个工具正是 rejected.jsonl 里失败最多的。
*/
const MAX_DESCRIPTION_CHARS = 3200;
/**
* 工具目录（一节）的总预算。
*
* 2026-09-12 从 24_000 提到 56_000。理由：实测 DSH 下发 61 个工具、不截描述时共需
* **50,942 字符**，旧预算只装得下 35 个。更糟的是**截断是按字母序发生的**（工具按名排序），
* 于是 `write`(w)、`web_search`、`web_fetch`、`subagent`、`todo_write`、`skill`、`read_image`、
* 全部 `ssh_*`/`sftp_*` 被砍，而极少用的 `db_tx_rollback`、`db_list_connections` 反而留下。
* 取 56_000 留约十分之一余量（够再添几个中等大小的工具）；再超就走下面的"列出名字"兜底。
* 不至于撑爆上下文：DeepSeek 网页端上下文 1M token，而实际生效的 maxChars 是
* **150 万字符**（`index.ts` 的 `maxPromptChars` 默认值；这里 12 万那个旧注释已过时 ——
* 2026-09-13 核对时发现写的还是旧默认值，容易让人误判 prompt 体量）。
*/
const MAX_TOOLS_SECTION_CHARS = 56e3;
const HOLD_BACK_CHARS = 24;
const MAX_CAPTURE_CHARS = 262144;
/** 工具调用协议指令（固定文本，进 prompt 前缀，保持前缀缓存友好）。 */
/**
* head（system + 工具协议 + 工具目录）在 prompt 里最多占的比例。
* 0.62 是 0.1.33 调的：实测 61 个工具时 head 约 6.35 万字符，而 0.45 × 12 万 = 5.4 万装不下。
* 转写仍余约 5.6 万字符 —— 历史可以截，工具定义不可以。
*/
const HEAD_RATIO = .62;
/** 协议段拼接时的固定开销（换行、`---` 分隔、省略标记等）。 */
const PROTOCOL_SLACK_CHARS = 96;
const TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output ONLY a single JSON object, with no other text before or after it:

{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}

Rules:
1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch is allowed).
2. Stop immediately after that JSON object. The runner executes the call(s) and returns the results to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Do NOT use XML/HTML-like markup for tool calls: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), and none of the private delimiter-prefixed variants some DeepSeek surfaces use. The JSON object above is the ONLY accepted format. Markup is not just ignored — it leaks into the visible transcript (and into the web conversation) as broken output.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry — measured case: a model emitted 15 replayed calls inside one 8152-char payload, and every one of them had to be thrown away.
9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`;
/** 判定「这是一段要执行的程序」的最小长度：短于它的多半只是行内提及某个 API。 */
const MIN_TOOL_PROGRAM_CHARS = 80;
/**
* 检测「模型把工具程序写成了正文」——而不是作为工具调用发出。
*
* 现场（2026-09-17 11:00，`--F-Code-DSH-Code-gongji--` 会话）：第三方 preset（染神）
* 的 `tool-bootstrap.mjs` 注入了一条 PTC 说明 ——「你在 Programmatic Tool Calling 模式，
* 所有动作必须通过 run_code 写 TypeScript 程序完成」；同 preset 的 persona 还写着
* `One complete deliverable per turn: numbered steps or code blocks`。
* 于是模型把 run_code 的 code 参数**原样贴进了正文**：三轮里一次工具调用都没发出
* （`toolCallCount` 始终为 0），agent loop 判定回合结束 → 用户看到「它停下来了」。
* 模型自己在 reasoning 里也承认："我把 TypeScript 代码写成了正文文本，而不是作为工具调用发出"。
*
* 判据：正文里出现**围栏代码块**且块内含 `tools.<name>(…)` 形态的调用 —— 那是 PTC
* 程序体的特征（正常回答不会这么写）。没有围栏时只认带 `await` 的形态，更严格，
* 免得把「提到某个 API」错判成「写了程序」。
*
* ⚠️ 这**只是判据**：调用方还要确认「本轮零工具调用」，否则健康的程序化调用轮会被误伤。
*/
function looksLikeUnexecutedToolProgram(text) {
	const source = String(text ?? "");
	if (!source) return false;
	const blocks = [];
	const fence = /```[^\n]*\n([\s\S]*?)```/g;
	let match;
	while ((match = fence.exec(source)) !== null) blocks.push(match[1]);
	if (blocks.length === 0) return /await\s+tools\.[A-Za-z_$][\w$]*\s*\(/.test(source);
	return blocks.some((block) => block.length >= MIN_TOOL_PROGRAM_CHARS && /tools\.[A-Za-z_$][\w$]*\s*\(/.test(block));
}
function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}
/** 渲染工具目录（含 JSON Schema）。 */
function buildToolSection(tools, maxChars = MAX_TOOLS_SECTION_CHARS) {
	if (!tools || tools.length === 0) return "";
	const parts = ["", "## Available tools"];
	let budget = Math.max(0, Math.min(MAX_TOOLS_SECTION_CHARS, maxChars));
	for (let index = 0; index < tools.length; index += 1) {
		const tool = tools[index];
		let schemaText = "";
		try {
			schemaText = JSON.stringify(tool.parameters ?? {});
		} catch {
			schemaText = "{}";
		}
		const block = [
			"",
			`### ${tool.name}`,
			truncate(String(tool.description ?? "").replace(/\s+/g, " ").trim(), MAX_DESCRIPTION_CHARS),
			`Parameters (JSON Schema): ${schemaText}`
		].join("\n");
		if (budget - block.length < 0) {
			const rest = tools.slice(index).map((item) => String(item?.name ?? "")).filter(Boolean);
			parts.push(`\n(⚠️ The following ${rest.length} tools are NOT described above (omitted for length): ${rest.join(", ")}. If you need one of them, ask the user for its exact parameters — do NOT guess them.)`);
			break;
		}
		budget -= block.length;
		parts.push(block);
	}
	return parts.join("\n");
}
function flattenText(blocks, out = []) {
	for (const block of blocks ?? []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") out.push(block.text);
		else if (block.type === "tool-result" && Array.isArray(block.content)) flattenText(block.content, out);
	}
	return out;
}
/**
* 逐张产出图片占位标记，**按图片在消息里的实际顺序**。
*
* 为什么要分「带上」与「略过」（0.1.77，群友实测报告 `code 10 / too many ref file`）：
* 图片是**请求级**的（一次请求用 `ref_file_ids` 带一批），而网页端对这一批的数量有上限 ——
* 实测最后一次成功是 40 张、第一次失败是 52 张，真值落在 (40, 52]。超长会话里我们只发
* 最近的 N 张，更早的会被略过；此时若标记仍一律写 `[image attached]`，模型就会**以为它
* 收到了那些图**，然后对着没送出去的图瞎猜。所以分两种标记写。
*
* ⚠️ **必须按顺序逐个产出，不能写成「N 个 attached 再 M 个 omitted」** ——
* 那样标记的先后就不再对应图片的时间先后，模型会搞不清被省略的是哪几张。
*
* `kept` 为 undefined 时全部算「已发出」（＝ 0.1.77 之前的行为，续写轮与既有单测走这条路）；
* 图没有 `attachmentId` 时也算「已发出」—— 那种情况判断不了，保守起见别把真发出去的标成省略。
*/
function blockImageMarks(blocks, kept) {
	const marks = [];
	const walk = (list) => {
		for (const block of list ?? []) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "image") {
				const key = String(block.attachment?.attachmentId ?? "");
				marks.push(!kept || !key || kept.has(key) ? "[image attached]" : "[earlier image omitted]");
			} else if (block.type === "tool-result" && Array.isArray(block.content)) walk(block.content);
		}
	};
	walk(blocks);
	return marks;
}
/** mediaType → 文件名后缀。服务端按**后缀**判类型（不看 multipart 里的 content-type）。 */
const IMAGE_EXT_BY_MEDIA_TYPE = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
/** 服务端认得的图片后缀。不在此列的一律重建名字，别把 bmp/tiff 之类原样发过去再被拒一次。 */
const KNOWN_IMAGE_EXT = /* @__PURE__ */ new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif"
]);
/**
* 上传时该用的文件名。
*
* 为什么必须归一（2026-09-15 真机 A/B，三组对照，同一份 PNG 字节只改名字）：
*   `image.png` ✅ / `<64位hex>.png` ✅ / **纯 64 位 hex ❌ `code 9 unsupported file type`** /
*   不给 name（走缺省 image.png）✅
* ⇒ 服务端**按文件名后缀**判类型，content-type 说了不算。
* 而宿主给 `tool/result` 内嵌图片的 `name` 正是**纯 sha256（没有后缀）**，
* `user/message` 与 `agent/inbox` 给的是 `image.png` —— 于是"凡是经工具返回的图一律传不上去"：
* 本机 09-14 的 36 次 + 09-15 的 6 次被拒，全部是这个原因（会话日志里
* `tool/result` 的 name 无一例外是 64 位 hex，user/message 无一例外带 .png）。
*
* 所以这里只保留**受支持的后缀**，其余按 mediaType 重建为 `image.<ext>`
* ——保证发出去的文件名总是声明了一个服务端支持的类型。
*/
function imageUploadName(name, mediaType) {
	const ext = IMAGE_EXT_BY_MEDIA_TYPE[String(mediaType ?? "").trim().toLowerCase()] ?? "png";
	const base = (typeof name === "string" ? name.trim() : "").split(/[\\/]/).pop() ?? "";
	const matched = /\.([a-z0-9]{2,5})$/i.exec(base);
	if (matched && KNOWN_IMAGE_EXT.has(matched[1].toLowerCase())) return base;
	return `image.${ext}`;
}
/** 把一条 assistant 消息里的 tool-call 块渲染回协议 JSON（供历史学习格式）。 */
function renderToolCalls(blocks) {
	const calls = (blocks ?? []).filter((block) => block?.type === "tool-call");
	if (calls.length === 0) return null;
	const payload = { tool_calls: calls.map((call) => {
		let args = {};
		try {
			args = call.arguments ? JSON.parse(call.arguments) : {};
		} catch {
			args = { _raw: String(call.arguments ?? "") };
		}
		return {
			name: String(call.name ?? ""),
			arguments: args
		};
	}) };
	return JSON.stringify(payload);
}
/** 中间截断：保留开头（任务/协议）与结尾（最近回合），并把省略标记计入预算。 */
function truncateMiddle(text, maxChars, tailRatio = .7) {
	if (text.length <= maxChars) return text;
	const budget = Math.max(0, maxChars - 64);
	const tail = Math.floor(budget * tailRatio);
	const head = Math.max(0, budget - tail);
	const marker = `\n\n...[${text.length - head - tail} chars omitted]...\n\n`;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
/**
* 与 serializePrompt 同源，但额外交出 `head` 与未截断的 `entries`。
*
* 为什么需要（2026-09-14，链式投喂）：增量 = 本轮条目减去上一轮条目，必须拿
* **结构化**的条目数组去比前缀；而最终字符串可能被 truncateMiddle 从中间截过，
* 用字符串切前缀会把截断位置算错（截断点之后的"新增"其实是被挖掉的中段）。
*/
function serializePromptParts(options) {
	const maxChars = options.maxChars ?? 12e4;
	if (!Number.isSafeInteger(maxChars) || maxChars < 128) throw new RangeError("maxChars 必须为至少 128 的整数");
	const system = String(options.system ?? "").trim();
	const toolBudget = Math.max(0, Math.floor(maxChars * HEAD_RATIO) - system.length - TOOL_PROTOCOL_INSTRUCTIONS.length - PROTOCOL_SLACK_CHARS);
	const toolSection = buildToolSection(options.tools, toolBudget);
	const protocol = toolSection ? `\n\n${TOOL_PROTOCOL_INSTRUCTIONS}${toolSection}` : "";
	const lines = [];
	for (const message of options.messages ?? []) {
		if (!message || typeof message !== "object") continue;
		const blocks = Array.isArray(message.content) ? message.content : [];
		if (message.role === "system") {
			const text = flattenText(blocks).join("");
			if (text.trim()) lines.push(`[System]\n${text}`);
			continue;
		}
		if (message.role === "assistant") {
			const text = flattenText(blocks).join("");
			const renderedCalls = renderToolCalls(blocks);
			if (renderedCalls) lines.push(`Assistant: ${renderedCalls}`);
			else if (text.trim()) lines.push(`Assistant: ${text}`);
			continue;
		}
		const toolResults = blocks.filter((block) => block?.type === "tool-result");
		const text = flattenText(blocks.filter((block) => block?.type !== "tool-result")).join("");
		const imageMarks = blockImageMarks(blocks, options.keptImageKeys);
		const images = imageMarks.length;
		if (text.trim() || toolResults.length === 0 && images === 0 || images > 0) {
			const imageNote = imageMarks.length > 0 ? `\n${imageMarks.join(" ")}` : "";
			lines.push(`User: ${text}${imageNote}`);
		}
		for (const result of toolResults) {
			const body = flattenText(result.content).join("") || "(no output)";
			const errorMark = result.isError ? " [ERROR]" : "";
			lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? "")}]\n${body}`);
		}
	}
	const transcript = lines.join("\n\n");
	const head = system ? `${system}${protocol}` : protocol.trim();
	const merged = transcript ? `${head}\n\n---\n\n${transcript}` : head;
	if (merged.length <= maxChars) return {
		head,
		entries: lines,
		full: merged
	};
	const separator = transcript ? "\n\n---\n\n" : "";
	const budget = maxChars - head.length - separator.length;
	if (budget < 128) throw new AdapterLlmError("系统/工具定义超出 prompt 预算，请减少固定输入或扩大上限", "CONTEXT_WINDOW_EXCEEDED");
	return {
		head,
		entries: lines,
		full: head + separator + truncateMiddle(transcript, budget, .7)
	};
}
/** 完整 JSON 调用标记：{"tool_calls": 或 {"tool_call": （允许空白）。 */
const MARKER_RE = /\{\s*"tool_calls?"\s*:/;
/**
* XML 风格调用标记（实测：思考模式下模型偶尔改用这套标记，形如
* `<tool_calls><invoke name="read"><parameter name="file_path">…</parameter></invoke></tool_calls>`；
* 亦兼容 DeepSeek 自家的 DSML 前缀与 `dsml-` 连字符变体）。
*
* ⚠️ 2026-09-10 实测泄漏样本（真正的乱码来源）：模型把 DSML 前缀写成**重复的全角竖线**，
* 且包裹标签名退化成 `calls`：
*   `<` + `｜｜` + `DSML` + `｜｜` + ` ` + `calls>`
* 旧写法只容忍单个竖线（`[|｜]`），于是 `<` 后吃掉一个 `｜` 就要求紧跟 `DSML`，
* 却撞上第二个 `｜` → 整个标记认不出来 → 不进捕获态 → 原样进正文 → GUI 渲染成乱码。
* 现在竖线按 `+` 容忍（含全角/半角混用），并把 `calls` 也列入包裹标签名。
*/
const DSML_PREFIX = "(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?";
const WRAPPER_NAMES = "tool_calls|tool_call|function_calls|calls";
const XML_STARTER_RE = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES}|invoke)\\b`, "i");
/** 代码围栏收尾（模型常把调用块放进 ``` 里）。 */
const FENCE_TAIL_RE = /\n?[ \t]*```[a-zA-Z0-9]*[ \t]*\n?$/;
const FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/;
/**
* 开/收标签前缀（宽容写法）。严格解析与宽容解析**必须共用同一套**，否则会出现
* 「findXmlToolCallEnd 认得出收尾、parseXmlToolCalls 认不出 invoke」→ 整块被降级成正文泄漏。
* 覆盖：`< invoke`（标签名带空白）、单/重复竖线的 DSML 前缀（含全角）、`<dsml-invoke>`。
*/
const TAG_OPEN_PREFIX = `<\\s*${DSML_PREFIX}(?:dsml-)?`;
const TAG_CLOSE_PREFIX = `<\\/\\s*${DSML_PREFIX}(?:dsml-)?`;
const XML_CLOSE_NAMES = `parameter|invoke|${WRAPPER_NAMES}`;
/**
* 归一化 DSML 噪声 → 标准标签。
* 竖线支持**重复与全角**（实测样本是双全角竖线），并连带吃掉其后的空白，
* 让标签名紧跟在 `<` 之后（`<` + 前缀 + ` ` + `invoke` → `<invoke`）。
*/
function normalizeDsml(text) {
	return text.replace(new RegExp(`<(/?)${DSML_PREFIX}`, "gi"), "<$1").replace(/<\s*dsml-/gi, "<").replace(/<\/\s*dsml-/gi, "</");
}
/**
* JSON 调用标记前缀（用于跨包 hold-back 判断）。
* ⚠️ 2026-09 事故：真实分块会把标记切成 `{"tool` + `_calls":[{"name":…` 两半。
* 旧实现比较时多拼了一个引号（`{'{"' + body}`，而 body 已含前引号 → `{""tool`），
* 于是「末尾是潜在前缀」永远判 false → 半截标记被当正文吐出去、后半个再也拼不回完整标记
* → 整个 JSON 泄漏成正文。修复见 partialMarkerSuffixLength。
*/
const JSON_MARKER_STARTERS = ["{\"tool_calls\"", "{\"tool_call\""];
/** XML 标记前缀（用于跨包 hold-back 判断）。`calls` 是实测出现的退化包裹名。 */
const XML_MARKER_STARTERS = [
	"<tool_calls",
	"<tool_call",
	"<function_calls",
	"<calls",
	"<invoke",
	"<dsml-tool_calls",
	"<dsml-invoke"
];
/**
* 判断 text 末尾是否是（可能的）标记前缀 —— 决定是否 hold back。
* @returns 需要保留在缓冲区里的尾部字符数（0 = 无需保留）
*/
function partialMarkerSuffixLength(text) {
	const from = Math.max(0, text.length - 32);
	const raw = text.slice(from);
	const braceAt = raw.lastIndexOf("{");
	const angleAt = raw.lastIndexOf("<");
	const startAt = Math.max(braceAt, angleAt);
	if (startAt === -1) return 0;
	const held = raw.length - startAt;
	const normalized = normalizeDsml(raw.slice(startAt));
	if (normalized.startsWith("{")) {
		if (MARKER_RE.test(normalized)) return 0;
		const body = normalized.replace(/^\{\s*/, "").replace(/\s+/g, "");
		return JSON_MARKER_STARTERS.some((starter) => starter.startsWith(`{${body}`)) ? held : 0;
	}
	if (normalized.startsWith("<")) {
		if (XML_STARTER_RE.test(normalized)) return 0;
		const lower = normalized.toLowerCase().replace(/\s+/g, "");
		if (XML_MARKER_STARTERS.some((starter) => starter.startsWith(lower))) return held;
		const loose = lower.replace(/[|｜]|dsml/g, "");
		if (/^<\/?[a-z_]*$/.test(loose) && XML_MARKER_STARTERS.some((starter) => starter.startsWith(loose))) return held;
		return 0;
	}
	return 0;
}
/** 从 index 0 起抽取一个配平的 JSON 对象；不完整返回 null。 */
function extractBalancedJson(text) {
	if (text[0] !== "{") return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escape = true;
			continue;
		}
		if (ch === "\"") {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return {
				json: text.slice(0, i + 1),
				end: i + 1
			};
		}
	}
	return null;
}
/** 读取一个 XML 属性值（支持双引号/单引号/裸值）。 */
function readAttr(attrs, name) {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, "i").exec(attrs);
	if (!match) return void 0;
	return match[1] ?? match[2] ?? match[3];
}
/**
* 宽容 JSON 解析。实测场景：模型把 Windows 路径写成 `"D:\apps\DSH"`（单个反斜杠，
* 非法转义），JSON.parse 直接抛错 → 工具调用解析失败、整段标记被当正文吐给用户。
* 先试原样；失败则修补：非法转义补成字面反斜杠、字符串内裸换行转义、去尾逗号。
*/
function parseJsonLenient(text) {
	try {
		return JSON.parse(text);
	} catch {}
	for (const candidate of jsonRepairCandidates(text)) try {
		const parsed = JSON.parse(candidate);
		if (parsed !== void 0) return parsed;
	} catch {}
}
/**
* 依次尝试的修复候选（只在原样解析失败时使用）。顺序有讲究：
*
* 先跑「路径尾反斜杠」启发式（`"…\app.asar\"` 里的 `\"` 是转义引号 → 字符串不终止，
* 必须在切分字符串**之前**修，否则整个字符串范围都会错），再跑字符串级修复。
*
* 字符串级修复的智能规则：若某字符串里出现**非法转义**（如 `\A`），说明模型是「原样写出」
* 未转义的反斜杠 —— 此时该字符串内所有反斜杠都按字面处理，否则 `\resources` 里的 `\r`
* 会被 JSON 当成回车，路径被悄悄改坏（实测用户样本 #2）。
* 若字符串里没有非法转义，则只做保守修补（保留 `\\`、`\"` 等合法转义）。
*/
/**
* 修复「**字符串值里出现未转义的双引号**」——实测最高频的坏法，也是「自动停止」的元凶。
*
* 实测（2026-09-10 23:27:13，deepseek-reasoner）：命令天然写作
*   `Get-ChildItem "$env:USERPROFILE\.dsh" | Select-Object Name`
* 模型把这串里的引号**原样**塞进 JSON 字符串 → `Expected ',' or '}' after property value`
* → 整条调用被丢弃 → 那一轮没有工具调用 → agent loop 认为回合正常结束
* → 用户看到的症状就是「说半句就停了」。
*
* 判据（对 JSON 语法是稳的）：在字符串内部遇到双引号时，向后跳过空白看一个字符 ——
* 只有它还是 `,` `}` `]`（或文本结束）时才说明字符串真的结束；否则该引号是内容里的字面引号。
*
* ⚠️ 冒号必须**按位置**区别对待：`"` 后面跟 `:` 只在「键的位置」才是结构符。
* 若把值里的 `"` + `:` 也当成结束，那么命令内嵌 JSON 时会误判，例如
*   `node -e "const o={"a":1}"`
* 里的 `"a"` 会被当成字符串收尾 → 后面全部错位 → 整条调用照样被丢弃（我第一版就踩了这个洞）。
* 因此这里跟踪「进入字符串时是否处于键位置」（上一结构符是 `{` / `,` / `[`）。
*/
function escapeInnerQuotes(text) {
	let out = "";
	let inString = false;
	let keyPosition = false;
	let lastStructural = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!inString) {
			if (ch === "\"") {
				inString = true;
				keyPosition = lastStructural === "{" || lastStructural === "," || lastStructural === "[";
				out += ch;
				continue;
			}
			if (!" 	\n\r".includes(ch)) lastStructural = ch;
			out += ch;
			continue;
		}
		if (ch === "\\") {
			out += ch + (text[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (ch === "\"") {
			let j = i + 1;
			while (j < text.length && " 	\n\r".includes(text[j])) j++;
			const next = text[j];
			if (next === "," || next === "}" || next === "]" || next === void 0 || next === ":" && keyPosition) {
				inString = false;
				lastStructural = next === void 0 ? "" : next;
				out += ch;
			} else out += "\\\"";
			continue;
		}
		out += ch;
	}
	return out;
}
/**
* ⚠️ 刻意**不提供**「更激进的猜测」候选（例如把 `"` 后跟 `}` 也一律当内容）。
* 试过，结果是灾难：外层键的收尾引号也会被转义 → 整个载荷被搅坏；
* 而且即使侥幸解析成功，也可能交出一条**被改坏的命令**并真的执行它。
* 嵌套引号（`node -e "console.log({"k":"v"})"`）在原理上无法靠单字符前瞻消歧 ——
* 这种极端用例的正确处置是**拒绝 + 重试**（重试后模型通常会改用更简单的写法），
* 而不是猜。宁可拒绝，也绝不交出坏命令。
*/
function* jsonRepairCandidates(text) {
	const pathTail = (value) => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, "$1\\\\\"");
	for (const base of [text, ...structuralRepairCandidates(text)]) for (const variant of [base, escapeInnerQuotes(base)]) {
		yield repairJsonText(pathTail(variant), { mode: "smart" });
		yield repairJsonText(variant, { mode: "smart" });
		yield repairJsonText(pathTail(variant), { mode: "conservative" });
		yield repairJsonText(variant, { mode: "conservative" });
	}
}
/**
* 结构性修复候选：模型写的 tool_calls JSON 常有**括号结构错误**（漏写闭合、数组/对象闭合顺序错乱）。
*
* 已覆盖的实测形态：
*  - 每个调用对象少写一个 `}`（2026-09 事故 #4：批量 3 个调用各少一个）
*  - arguments 写成数组、且 `]`/`}` 顺序错乱（2026-09-11 事故 #5：
*    `{"tool_calls":[{"name":"pwsh","arguments":[{…}}]}`  ← args 数组没闭合就写了 `}`）
*  - 外层对象少写收尾 `}`
*
* 做法（rebuildToolCallJson）：栈引导重排 —— 遇到不匹配的闭合符时，**插入缺失的容器闭合**
* 使其匹配。只插入括号，绝不改写字符串内容。配合 parseToolCallJson 的
* 「arguments 数组 → 取唯一元素」解包，这类调用可以完整恢复并执行。
*/
function* structuralRepairCandidates(text) {
	if (!/^\s*\{\s*"tool_calls?"\s*:\s*\[/.exec(text)) return;
	const rebuilt = rebuildToolCallJson(text);
	if (rebuilt && rebuilt !== text) yield rebuilt;
}
/**
* 栈引导的 tool_calls JSON 重排（只在严格解析失败后使用，**只插入括号、绝不改写字符串内容**）。
*
* 规则：
*  1) 正常的开/闭符合配 → 原样输出并弹栈；
*  2) 闭合符与栈顶不匹配 → 在其前**插入**能使它匹配的闭合序列（有上限保护），再正常闭合；
*  3) `,` 出现在 tool_calls 数组的元素层级、而栈顶是未闭合的调用对象 → 先补 `}`
*     （实测形态：批量调用每个元素都少写一个 `}`）；
*  4) 收尾按栈补齐剩余闭合。
*
* ⚠️ 安全闸门：扫描结束时若**仍在字符串内**（流被服务端 60s 上限截断的典型特征）→ 返回 null。
* 此时补括号会得到一条**被截断的命令**并真的执行它 —— 宁可拒绝（→ 重试），也不执行半条命令。
*/
function rebuildToolCallJson(text) {
	if (!/^\s*\{\s*"tool_calls?"\s*:\s*\[/.test(text)) return null;
	let out = "";
	const stack = [];
	let inString = false;
	let escape = false;
	let insertions = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(ch);
			out += ch;
			continue;
		}
		if (ch === "}" || ch === "]") {
			const want = ch === "}" ? "{" : "[";
			while (stack.length > 0 && stack[stack.length - 1] !== want) {
				if (insertions >= 8) return null;
				out += stack[stack.length - 1] === "{" ? "}" : "]";
				stack.pop();
				insertions += 1;
			}
			if (stack.length === 0) return null;
			stack.pop();
			out += ch;
			continue;
		}
		if (ch === ",") {
			const bracketIndex = stack.indexOf("[");
			if (bracketIndex === 1 && stack.length - bracketIndex - 1 === 1 && stack[stack.length - 1] === "{" && /^\s*\{\s*"name"\s*:/.test(text.slice(i + 1))) {
				out += "}";
				stack.pop();
				insertions += 1;
			}
			out += ch;
			continue;
		}
		out += ch;
	}
	if (inString) return null;
	if (insertions > 8) return null;
	while (stack.length > 0) {
		out += stack[stack.length - 1] === "{" ? "}" : "]";
		stack.pop();
	}
	return out;
}
/**
* 修复常见 JSON 语法问题。
* @param options.mode - `smart`（默认）：字符串内出现非法转义时，把该字符串所有反斜杠按字面
*   处理（模型原样写路径的常态，避免 `\r`/`\n`/`\t` 被误当转义）；
*   `conservative`：只补非法转义，其余原样保留。
*/
function repairJsonText(text, options = {}) {
	const mode = options.mode ?? "smart";
	let out = "";
	let inString = false;
	let buf = "";
	const flushString = () => {
		const raw = buf;
		const body = mode === "smart" && hasInvalidEscape(raw) ? literalizeBackslashes(raw) : escapeInvalidEscapes(raw);
		out += `"${body}"`;
		buf = "";
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!inString) {
			if (ch === "\"") {
				inString = true;
				buf = "";
				continue;
			}
			out += ch;
			continue;
		}
		if (ch === "\\") {
			const next = text[i + 1];
			if (next === void 0) {
				buf += "\\\\";
				continue;
			}
			buf += ch + next;
			i += 1;
			continue;
		}
		if (ch === "\"") {
			flushString();
			inString = false;
			continue;
		}
		if (ch === "\n") {
			buf += "\\n";
			continue;
		}
		if (ch === "\r") {
			buf += "\\r";
			continue;
		}
		if (ch === "	") {
			buf += "\\t";
			continue;
		}
		buf += ch;
	}
	if (inString) flushString();
	return out.replace(/,(\s*[}\]])/g, "$1");
}
/** 字符串里是否存在「非法转义」（判断模型是否原样写出了未转义的反斜杠）。 */
function hasInvalidEscape(body) {
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\") continue;
		const next = body[i + 1];
		if (next === void 0) return true;
		if (!"\"\\/bfnrtu".includes(next)) return true;
		i += 1;
	}
	return false;
}
/**
* 把「模型原样写出的字符串」按字面语义重新转义。
* 逐字符处理以避免正则的重复加倍：`\\` 保留为一个字面反斜杠、`\"` 保留为转义引号，
* 其余单个反斜杠一律补成 `\\`（关键：让 `\resources` 里的 `\r` 不再变成回车）。
*/
function literalizeBackslashes(raw) {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = raw[i + 1];
		if (next === "\\") {
			out += "\\\\";
			i += 1;
			continue;
		}
		if (next === "\"") {
			out += "\\\"";
			i += 1;
			continue;
		}
		out += "\\\\";
	}
	return out;
}
/** 只把「非法转义」补成字面反斜杠，合法转义原样保留。 */
function escapeInvalidEscapes(body) {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = body[i + 1];
		if (next === void 0) {
			out += "\\\\";
			continue;
		}
		if ("\"\\/bfnrtu".includes(next)) {
			out += ch + next;
			i += 1;
			continue;
		}
		out += "\\\\";
	}
	return out;
}
/** 去掉 CDATA 包装并按 JSON 解析值（解析不出就当字符串）。 */
function parseParameterValue(raw) {
	let text = raw.trim();
	const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text);
	if (cdata) text = cdata[1];
	if (text === "") return "";
	const parsed = parseJsonLenient(text);
	return parsed === void 0 ? text : parsed;
}
/**
* 解析 XML/DSML 风格的工具调用块（整块文本，可能含多个 invoke）。
* 支持：`<tool_calls>`/`<function_calls>` 包裹、裸 `<invoke>`、`|DSML|` 前缀、
* CDATA 值、属性任意顺序、围栏包裹。
*/
function parseXmlToolCalls(block) {
	const text = normalizeDsml(block).replace(FENCE_HEAD_RE, "").replace(/```\s*$/, "");
	const invokeRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}invoke\\s*>`, "gi");
	const calls = [];
	let invoke;
	while ((invoke = invokeRe.exec(text)) !== null) {
		const name = readAttr(invoke[1], "name");
		if (!name) continue;
		const body = invoke[2];
		const args = {};
		let sawParam = false;
		const paramRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}parameter\\s*>`, "gi");
		let param;
		while ((param = paramRe.exec(body)) !== null) {
			const key = readAttr(param[1], "name");
			if (!key) continue;
			sawParam = true;
			args[key] = parseParameterValue(param[2]);
		}
		if (!sawParam) {
			const inner = body.trim();
			if (inner) try {
				const parsed = JSON.parse(inner);
				if (parsed && typeof parsed === "object") Object.assign(args, parsed);
				else args._raw = parsed;
			} catch {
				args._raw = inner;
			}
		}
		calls.push({
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			name,
			arguments: JSON.stringify(args)
		});
	}
	if (calls.length > 0) return calls;
	return salvageXmlToolCalls(text);
}
/**
* 宽容抢救：模型写出的 XML 调用块**收尾不全**时的最后一道网。
*
* 实测泄漏样本（2026-09，正是「一个字符一行」乱码的来源）：
*   `<tool_calls><invoke name="pwsh"><parameter name="command">…</parameter>`
* —— 参数值写完了，但**缺内层 `</invoke>`**（流被服务端上限截断时常见）。此时严格解析
* 认不出 invoke（它的正则要求 `</invoke>` 收尾），于是整块被当正文吐给用户；
* 而 Web GUI 把命令行里的 `$…$` 当 KaTeX 渲染 → 用户看到「一个字符一行 + 弯引号」的乱码。
* （注：只缺最外层 `</tool_calls>` 的情形严格解析本来就能兜住，不是泄漏源。）
*
* 做法：不依赖任何闭合标签，只按「`<invoke name=…>` 开标签 → 下一个开标签或块尾」切段取值。
* ⚠️ 只在**严格解析完全失败**时兜底，因此不会抢占正常路径。
* 宁可能截断也不要泄漏 —— 截断的调用会在下一轮被模型自己纠正。
*/
function salvageXmlToolCalls(text) {
	const invokeStartRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>`, "gi");
	const starts = [];
	let match;
	while ((match = invokeStartRe.exec(text)) !== null) starts.push({
		index: match.index,
		attrs: match[1]
	});
	if (starts.length === 0) return null;
	const calls = [];
	for (let i = 0; i < starts.length; i++) {
		const name = readAttr(starts[i].attrs, "name");
		if (!name) continue;
		const bodyStart = starts[i].index + starts[i].attrs.length;
		const nextStart = starts[i + 1]?.index ?? text.length;
		const body = text.slice(bodyStart, nextStart);
		calls.push({
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			name,
			arguments: JSON.stringify(salvageXmlParameters(body))
		});
	}
	return calls.length > 0 ? calls : null;
}
/** 从残缺的 invoke 内文里取出参数：按开标签切段，值取到下一个开标签或段尾。 */
function salvageXmlParameters(body) {
	const args = {};
	const paramStartRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>`, "gi");
	const found = [];
	let match;
	while ((match = paramStartRe.exec(body)) !== null) {
		const key = readAttr(match[1], "name");
		if (key) found.push({
			start: match.index,
			end: paramStartRe.lastIndex,
			key
		});
	}
	for (let i = 0; i < found.length; i++) {
		const valueEnd = found[i + 1] ? found[i + 1].start : body.length;
		args[found[i].key] = parseParameterValue(stripXmlClosers(body.slice(found[i].end, valueEnd)));
	}
	if (found.length === 0) {
		const inner = stripXmlClosers(body).trim();
		if (inner) {
			const parsed = parseJsonLenient(inner);
			if (parsed && typeof parsed === "object") Object.assign(args, parsed);
			else args._raw = inner;
		}
	}
	return args;
}
/** 剥掉值尾部残留的收尾标签与空白。 */
function stripXmlClosers(value) {
	const re = new RegExp(`(?:\\s*${TAG_CLOSE_PREFIX}(?:${XML_CLOSE_NAMES})\\s*>)+\\s*$`, "i");
	return value.replace(re, "");
}
/**
* 判断捕获到的协议块是否**确实是一次工具调用尝试**（而不是正文里恰好提到了 `<invoke>` 这类词）。
* 只用于「解析失败时该丢弃还是该透出」的裁决：
*  - 像调用 → 丢弃 + 告警（绝不泄漏成乱码，交给上层重试）
*  - 不像调用 → 当普通正文透出（绝不吞掉模型正文）
*/
function looksLikeToolCallBlock(mode, raw) {
	if (mode === "json") return MARKER_RE.test(raw);
	const text = normalizeDsml(raw);
	return new RegExp(`${TAG_OPEN_PREFIX}invoke\\b[^>]*\\bname\\s*=`, "i").test(text) || new RegExp(`${TAG_OPEN_PREFIX}parameter\\b[^>]*\\bname\\s*=`, "i").test(text);
}
/**
* 分类失败形态，用于诊断 —— 日志只保留前 400 字符，看不到后半段的坏点，
* 所以必须把「没收全」与「收全了但结构不对」分开，否则永远在猜。
*
*  - `unbalanced`：块没配平/没收全 —— 多半是流被服务端 60s 上限截断，不是模型写错；
*  - `unparsable`：块是完整的，但结构不符（漏括号、引号没转义、形状不对）；
*  - `echo`      ：载荷里裹着转写回声（模型在回放历史，不是在调用）。
*/
function classifyFailure(mode, raw) {
	if (/\[\s*Tool Result\b/i.test(raw)) return "echo";
	if (mode === "json") return extractBalancedJson(raw.replace(FENCE_HEAD_RE, "")) ? "unparsable" : "unbalanced";
	return findXmlToolCallEnd(raw) === -1 ? "unbalanced" : "unparsable";
}
/** 把解析出的 JSON 转成工具调用请求；非协议形状返回 null。 */
function parseToolCallJson(json) {
	const parsed = parseJsonLenient(json);
	if (!parsed || typeof parsed !== "object") return null;
	const raw = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : parsed.tool_call && typeof parsed.tool_call === "object" ? [parsed.tool_call] : null;
	if (!raw) return null;
	const calls = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.name === "string" ? entry.name : typeof entry.tool === "string" ? entry.tool : "";
		if (!name) continue;
		let args = entry.arguments ?? entry.parameters ?? entry.args ?? {};
		if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) args = args[0];
		if (typeof args === "string") {
			if (parseJsonLenient(args) === void 0) args = JSON.stringify({ _raw: args });
		} else try {
			args = JSON.stringify(args ?? {});
		} catch {
			args = "{}";
		}
		calls.push({
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
			name,
			arguments: String(args)
		});
	}
	return calls.length > 0 ? calls : null;
}
/**
* 流尾兜底的 JSON 抢救（比 parseToolCallJson 多退一步）。
*
* 捕获缓冲里可能带着捕获后残留的多余字符（围栏、正文），此时整段 `JSON.parse` 必然失败，
* 但**配平的前缀本身是好的调用** —— 取前缀再解析，别把能救的调用整批丢掉。
* 注意：不配平的截断仍由 structuralRepairCandidates 的安全闸门拒绝（宁可不执行半条命令）。
*/
function parseSalvagedToolCallJson(buffer) {
	const text = buffer.replace(FENCE_HEAD_RE, "");
	const direct = parseToolCallJson(text);
	if (direct) return direct;
	const balanced = extractBalancedJson(text);
	if (balanced && balanced.end < text.length) return parseToolCallJson(balanced.json);
	return null;
}
/**
* 在捕获缓冲里找 XML 调用块的结束位置（含结束标签）。
* - 包裹式（`<tool_calls>` / `<function_calls>`）：找对应闭合标签
* - 裸 `<invoke>`：找到 `</invoke>` 后继续吞并紧随其后的 invoke 块（同一批调用）
* 返回 -1 表示尚未收全（继续等流）。
*/
function findXmlToolCallEnd(buffer) {
	const text = buffer;
	const wrapper = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES})\\b`, "i").exec(text);
	const startsWithWrapper = wrapper !== null && wrapper.index === 0;
	const isInvokeStart = (value) => new RegExp(`^\\s*<\\s*${DSML_PREFIX}(?:dsml-)?invoke\\b`, "i").test(value);
	if (startsWithWrapper) {
		const tag = wrapper[1].toLowerCase();
		const match = new RegExp(`<\\/\\s*${DSML_PREFIX}(?:dsml-)?${tag}\\s*>`, "i").exec(text);
		return match ? match.index + match[0].length : -1;
	}
	if (!isInvokeStart(text)) return -1;
	let cursor = 0;
	for (;;) {
		const slice = text.slice(cursor);
		if (!isInvokeStart(slice)) return cursor > 0 ? cursor : -1;
		const match = /<\/\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?invoke\s*>/i.exec(slice);
		if (!match) return -1;
		cursor += match.index + match[0].length;
		const rest = text.slice(cursor);
		if (isInvokeStart(rest)) continue;
		const stray = new RegExp(`^\\s*<\\/\\s*${DSML_PREFIX}(?:dsml-)?(?:${WRAPPER_NAMES})\\s*>`, "i").exec(rest);
		if (stray) return cursor + stray[0].length;
		const tail = rest.trim();
		if (tail.startsWith("<") && /^<\/?\s*[|｜]?\s*[A-Za-z]{0,14}$/.test(tail)) return -1;
		return cursor;
	}
}
/**
* 剥掉「孤立的工具调用标记残片」。
*
* ⚠️ 2026-09-12 实测泄漏（用户截图里那句 `voke> </ calls>`）：模型把**包裹开始标签写丢**，
* 只留下闭合标签，或者只留下标签的后半截。这些残片不属于回答，但会绕过捕获逻辑
* （识别器只认 `<…invoke` / `<…calls>` 这类**开始**形态）落进正文缓冲，最后被当正文吐出去。
*
* 触发路径是 `flush()`：残片通常很短（`</|DSML|calls>` 只有 16 字符），
* 小于 HOLD_BACK_CHARS 就会被一直 hold 住，流结束时无条件吐出。
*
* 三道规则，从明确到宽松：
*   1. 带 DSML 前缀的孤立闭合标签 —— `</|DSML|calls>` / `</ | DSML | invoke>`
*      （DSML 是 DeepSeek 私有的标记名，正文里不可能正常出现，剥掉零风险）
*   2. 前缀被吃光的退化形态 —— `</ calls>` / `</invoke>`
*   3. 只剩后半截的 —— 独占一行的 `voke>`（`invoke>` 掉了头）
* 正文里正常讨论 XML 时通常写在代码围栏或行内代码里，形态与这三条不同。
*/
function stripStrayToolMarkup(text) {
	if (!text) return text;
	if (!/voke\s*>|calls?\s*>|tool_calls?\s*>|function_calls?\s*>|DSML/i.test(text)) return text;
	return text.replace(new RegExp(`<\\/?\\s*(?:(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)|dsml-)(?:dsml-)?(?:${WRAPPER_NAMES}|invoke)\\s*>`, "gi"), "").replace(new RegExp(`<\\/\\s*(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?(?:dsml-)?(?:${WRAPPER_NAMES}|invoke)\\s*>`, "gi"), "").replace(/<\/\s+(?:tool_calls?|function_calls|calls|invoke)\s*>/gi, "").replace(/(^|\n)[ \t]*(?:in)?voke\s*>\s*(?=\n|$)/gi, "$1");
}
/**
* 流式工具调用过滤器。
* - 普通正文：立即透传（仅 hold back 末尾少量字符以观测跨包的调用标记）
* - 命中调用标记（JSON 或 XML 两套）：进入捕获态，收全后转成 tool-call 请求，标记本身不外泄
* - 解析失败：把捕获内容当普通正文吐出（降级但可见，绝不静默丢内容）
* - 调用后面的剩余文本继续按普通正文处理（含围栏收尾清理）
*/
var ToolCallStreamFilter = class {
	pending = "";
	capture = null;
	abandoned = null;
	knownTools;
	constructor(knownTools) {
		this.knownTools = knownTools;
	}
	push(text) {
		const out = {
			text: "",
			calls: []
		};
		if (text) {
			if (this.capture) this.capture.buffer += text;
			else this.pending += text;
		}
		this.drain(out);
		return out;
	}
	flush() {
		const out = {
			text: "",
			calls: []
		};
		if (this.capture) {
			const captured = this.capture;
			const calls = captured.mode === "xml" ? parseXmlToolCalls(captured.buffer) : parseSalvagedToolCallJson(captured.buffer);
			if (calls) out.calls.push(...calls);
			else if (looksLikeToolCallBlock(captured.mode, captured.buffer)) this.abandoned ??= {
				raw: captured.buffer,
				mode: captured.mode,
				reason: classifyFailure(captured.mode, captured.buffer)
			};
			else out.text += stripStrayToolMarkup(captured.buffer);
			this.capture = null;
		}
		out.text += stripStrayToolMarkup(this.pending);
		this.pending = "";
		if (this.abandoned) out.rejected = this.abandoned;
		return out;
	}
	drain(out) {
		for (;;) {
			if (this.capture) {
				const captured = this.capture;
				if (captured.mode === "xml") {
					const end = findXmlToolCallEnd(captured.buffer);
					if (end === -1) {
						if (captured.buffer.length > MAX_CAPTURE_CHARS) {
							if (looksLikeToolCallBlock("xml", captured.buffer)) this.abandoned ??= {
								raw: captured.buffer,
								mode: "xml",
								reason: "oversize"
							};
							else out.text += stripStrayToolMarkup(captured.buffer);
							this.capture = null;
							continue;
						}
						return;
					}
					const block = captured.buffer.slice(0, end);
					const calls = parseXmlToolCalls(block);
					if (calls) out.calls.push(...calls);
					else if (looksLikeToolCallBlock("xml", block)) this.abandoned ??= {
						raw: block,
						mode: "xml",
						reason: "unparsable"
					};
					else out.text += stripStrayToolMarkup(block);
					this.capture = null;
					this.pending = captured.buffer.slice(end).replace(FENCE_HEAD_RE, "") + this.pending;
					continue;
				}
				const balanced = extractBalancedJson(captured.buffer);
				if (!balanced) {
					if (captured.buffer.length > MAX_CAPTURE_CHARS) {
						this.abandoned ??= {
							raw: captured.buffer,
							mode: "json",
							reason: "oversize"
						};
						this.capture = null;
						continue;
					}
					return;
				}
				const calls = parseToolCallJson(balanced.json);
				if (calls) {
					out.calls.push(...calls);
					this.capture = null;
					this.pending = captured.buffer.slice(balanced.end).replace(FENCE_HEAD_RE, "") + this.pending;
					continue;
				}
				const head = captured.buffer.slice(0, balanced.end);
				if (looksLikeToolCallBlock("json", head)) this.abandoned ??= {
					raw: head,
					mode: "json",
					reason: "unparsable"
				};
				else out.text += head;
				this.capture = null;
				this.pending = captured.buffer.slice(balanced.end) + this.pending;
				continue;
			}
			const jsonMarker = MARKER_RE.exec(this.pending);
			const xmlMarker = XML_STARTER_RE.exec(this.pending);
			const jsonIndex = jsonMarker?.index ?? -1;
			const xmlIndex = xmlMarker?.index ?? -1;
			const useXml = xmlIndex !== -1 && (jsonIndex === -1 || xmlIndex < jsonIndex);
			const index = useXml ? xmlIndex : jsonIndex;
			if (index !== -1) {
				let head = this.pending.slice(0, index);
				const fence = FENCE_TAIL_RE.exec(head);
				if (fence) head = head.slice(0, fence.index);
				out.text += head;
				this.capture = {
					mode: useXml ? "xml" : "json",
					buffer: this.pending.slice(index)
				};
				this.pending = "";
				continue;
			}
			this.pending = stripStrayToolMarkup(this.pending);
			if (this.pending.length <= HOLD_BACK_CHARS) return;
			const hold = partialMarkerSuffixLength(this.pending);
			if (hold > 0) {
				out.text += this.pending.slice(0, this.pending.length - hold);
				this.pending = this.pending.slice(this.pending.length - hold);
				return;
			}
			out.text += this.pending;
			this.pending = "";
			return;
		}
	}
};
/**
* 剥离模型模仿的「系统标记」（`<ds_system>…</ds_system>` / `<system>…</system>`）。
*
* 实测（deepseek-web）：模型会在正文里吐出成串的伪系统标记，**模仿它见过的协议格式**。
* 这与「转写回声」是同一类问题，但形态是 XML 标签而不是 `[Tool Result]` 行，
* 所以单独一层处理。围栏代码块内不剥（正常回答可能讨论这些标记）。
*
* ## 标签清单（只列**有现场证据**的，不做通配）
*
* ⚠️ 刻意**不用** `<[a-z_]+>` 这种通配：用户的正常回答可能就是一段讨论这些标签的文档，
* 通配会把它们一起吃掉。每加一个名字都要有现场 + 穷搜证据。
*
* | 标签 | 现场 |
* | --- | --- |
* | `ds_system` | 2026-09-11：一条正文里 13 个 `<ds_system>Tool result for call_1a2b3c</ds_system>`，调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…） |
* | `system` | 同批现场 |
* | `ide_result_status` | 2026-09-12（会话 `15ac4c56`）：正文里冒出 `<ide_result_status>Tool ran without output or errors</ide_result_status>`。⚠️ 该串在**DSH 的 `app.asar`（0 处）、全部已装插件（0 处）、`~/.dsh` 全树（0 处）**里都搜不到，且会话日志里**只出现在模型的输出字段**（212 条 `tool/result`、用户消息、系统消息里一处都没有）→ 判定是**模型自己编的**，不是 DSH 提供的 |
*
* @returns 剥离后的文本；`stripped` = 是否剥掉了至少一个标记（用于日志/告警）。
*/
const IMITATED_MARKER_TAGS = [
	"ds_system",
	"system",
	"ide_result_status"
];
/**
* 需要「正文够长」才剥的**跨行**标记。
*
* `tool_result`（2026-09-13 现场，会话 `15ac4c56` 记录 `[1480]`）：模型把 SSH 插件一次
* 读取工具的结果**整段复述**进正文，形如
*   `<tool_result>Path: …` + 换行 + `<path>…</path>` + 换行 + `<type>file</type>` + 换行 + `<content>` …
* 它比 `ds_system` 那批更「可讨论」——用户正在开发**产出它的那个插件**，正常回答里
* 可能出现简短示例。所以要求正文 ≥ 120 字才剥：真实回声是整份文件（实测那处上千字），
* 随口举例不会有那么长。围栏代码块内同样不剥。
*/
const LONG_MARKER_TAGS = [{
	tag: "tool_result",
	minBody: 120
}];
const LONG_MARKER_ALT = LONG_MARKER_TAGS.map((entry) => entry.tag).join("|");
/** 跨行闭合形态（`[\s\S]` 而不是逐行匹配 —— 真实回声的正文是跨行的）。 */
const LONG_CLOSED_MARKER_RE = new RegExp(`<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "g");
/** 跨行未闭合形态（流被截断在标记中间）。 */
const LONG_OPEN_MARKER_RE = new RegExp(`<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*)$`, "g");
function minBodyFor(tag) {
	return LONG_MARKER_TAGS.find((entry) => entry.tag === tag)?.minBody ?? 0;
}
/**
* 代码围栏区间（成对的 ``` 或 ~~~）。
* 跨行替换没法像逐行处理那样顺手跟踪 inFence，所以先算出区间再判断命中点是否落在里面。
*/
function fencedRanges(text) {
	const marks = [];
	const re = /^[ \t]*(?:```|~~~)/gm;
	let match;
	while ((match = re.exec(text)) !== null) marks.push(match.index);
	const ranges = [];
	for (let i = 0; i + 1 < marks.length; i += 2) ranges.push([marks[i], marks[i + 1]]);
	return ranges;
}
function insideFence(index, ranges) {
	return ranges.some(([from, to]) => index >= from && index < to);
}
/** 任一伪标记的开头是否出现（快速退出用，省掉对每段正文跑逐行循环）。 */
function hasImitatedMarker(text) {
	if (IMITATED_MARKER_TAGS.some((tag) => text.includes(`<${tag}`))) return true;
	return LONG_MARKER_TAGS.some((entry) => text.includes(`<${entry.tag}`));
}
/**
* 闭合形态 `<tag …>…</tag>`：用**反向引用**要求首尾同名，
* 避免 `<a>…</b>` 这种错配被当成一对连内容一起吃掉。
*/
const CLOSED_MARKER_RE = new RegExp(`<(${IMITATED_MARKER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "g");
/** 未闭合形态：流在标记中间被截断 —— 半截标记同样是垃圾。 */
const OPEN_MARKER_RE = new RegExp(`<(${IMITATED_MARKER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`, "g");
var SystemMarkerStreamFilter = class {
	pending = "";
	captured = "";
	tag = "";
	fence = "";
	fenceSize = 0;
	limit = 1048576;
	push(text) {
		this.pending += text;
		return this.drain(false);
	}
	flush() {
		return this.drain(true);
	}
	drain(final) {
		let out = "", stripped = false;
		const names = [...IMITATED_MARKER_TAGS, ...LONG_MARKER_TAGS.map((x) => x.tag)];
		const opener = new RegExp("<(" + names.join("|") + ")\\b[^>]*>");
		while (this.pending.length) {
			const nl = this.pending.indexOf("\n");
			if (nl < 0 && !final) {
				if (this.fence === "" && !this.tag && !this.pending.includes("<") && !/^[ \t]{0,3}[`~]/.test(this.pending)) {
					out += this.pending;
					this.pending = "";
				}
				break;
			}
			let line = nl < 0 ? this.pending : this.pending.slice(0, nl + 1);
			this.pending = nl < 0 ? "" : this.pending.slice(nl + 1);
			if (!this.tag) {
				const mark = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
				if (this.fence) {
					out += line;
					if (mark && mark[1][0] === this.fence && mark[1].length >= this.fenceSize && !line.slice(mark[0].length).trim()) this.fence = "";
					continue;
				}
				if (mark) {
					this.fence = mark[1][0];
					this.fenceSize = mark[1].length;
					out += line;
					continue;
				}
			}
			while (line) {
				if (!this.tag) {
					const match = opener.exec(line);
					if (!match) {
						out += line;
						break;
					}
					out += line.slice(0, match.index);
					this.tag = match[1];
					this.captured = match[0];
					line = line.slice(match.index + match[0].length);
				}
				const close = "</" + this.tag + ">";
				const at = line.indexOf(close);
				if (at < 0) {
					this.captured += line;
					line = "";
					break;
				}
				this.captured += line.slice(0, at + close.length);
				line = line.slice(at + close.length);
				const openEnd = this.captured.indexOf(">") + 1;
				const bodySize = this.captured.length - openEnd - close.length;
				const long = LONG_MARKER_TAGS.find((x) => x.tag === this.tag);
				if (!long || bodySize >= long.minBody) stripped = true;
				else out += this.captured;
				this.captured = "";
				this.tag = "";
			}
		}
		if (this.pending.length + this.captured.length > this.limit) throw new Error("系统标记缓冲超过 1 MiB，拒绝静默截断正文");
		if (final && this.tag) {
			const long = LONG_MARKER_TAGS.find((x) => x.tag === this.tag);
			const bodySize = this.captured.length - this.captured.indexOf(">") - 1;
			if (!long || bodySize >= long.minBody) stripped = true;
			else out += this.captured;
			this.captured = "";
			this.tag = "";
		}
		return {
			text: out,
			stripped
		};
	}
};
function stripSystemMarkers(text) {
	if (!hasImitatedMarker(text)) return {
		text,
		stripped: false
	};
	const ranges = fencedRanges(text);
	let strippedLong = false;
	text = text.replace(LONG_CLOSED_MARKER_RE, (match, tag, body, offset) => {
		if (String(body).length < minBodyFor(String(tag))) return match;
		if (insideFence(offset, ranges)) return match;
		strippedLong = true;
		return "";
	}).replace(LONG_OPEN_MARKER_RE, (match, tag, body, offset) => {
		if (String(body).length < minBodyFor(String(tag))) return match;
		if (insideFence(offset, ranges)) return match;
		strippedLong = true;
		return "";
	});
	let out = "";
	let inFence = false;
	let stripped = strippedLong;
	let i = 0;
	while (i < text.length) {
		const lineEnd = text.indexOf("\n", i);
		const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd + 1);
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) inFence = !inFence;
		if (!inFence) out += line.replace(CLOSED_MARKER_RE, () => {
			stripped = true;
			return "";
		}).replace(OPEN_MARKER_RE, () => {
			stripped = true;
			return "";
		});
		else out += line;
		i = lineEnd === -1 ? text.length : lineEnd + 1;
	}
	return {
		text: out,
		stripped
	};
}
/**
* DeepSeek 网页端在**每一轮回复末尾**自动追加的免责声明（不是模型回答的一部分）。
*
* 实测（2026-09-11，27 个 DSH 会话里命中 43 处，形态唯一）：
*   `本回答由 AI 生成，内容仅供参考，请仔细甄别`
* 它会以 SSE 增量形式到达，甚至被拆成「 AI」「 生成」「，」「内容」这样的小包。
*
* 为什么必须剥掉：
*   - 它卡在两条回答中间（自动续写的缝就在它后面），用户会以为「模型怎么突然插了这句话」；
*   - 结尾是「甄别」这种汉字 → `looksMidSentence` 恒为真 → **每一轮都被误判成「句中被截」**，
*     于是无限触发自动续写（续写轮又追加一遍声明，再被判成截断……）。
*/
const WEB_DISCLAIMER = "本回答由 AI 生成，内容仅供参考，请仔细甄别";
/**
* 一次性剥离网页端免责声明（非流式）。
*
* 轮末残余必须用它再过一遍：`BoilerplateFilter` 的流式扣留只管它**收到**的文本，
* 而过滤器扣住的最后 ≤24 个字符还没经过它 —— 声明恰好 23 字，实测就整段从尾巴漏出去
* （会话 `6c0dbc47` 里它是一个只有单个 delta 的独立 text 块，跟在工具调用后面）。
*/
function stripWebDisclaimer(text) {
	if (!text.includes(WEB_DISCLAIMER)) return {
		text,
		stripped: false
	};
	return {
		text: text.split(WEB_DISCLAIMER).join(""),
		stripped: true
	};
}
/**
* 轮末收尾：把三层缓冲扣住的残余按**真实顺序**吐净，并补跑只作用于上屏前的两道清理。
*
* ⚠️ 为什么不能只把三层 flush 结果拼起来：
*   - 吐净顺序必须是流水线**反序**（越深的层扣住的文本越早）—— 否则最后几段文字前后颠倒；
*   - 浅层（过滤器）扣住的字符**从没经过**「剥声明」这一层，而声明就爱待在最后几个字符里；
*   - 同理，伪系统标记也可能整段藏在尾巴里。
* 轮末没有后续输入了，所以这里可以直接做一次性替换，不需要流式扣留。
*
* `cleanMarkers`（2026-09-13，审计 N03）：是否在**这里**用无状态的 `stripSystemMarkers`
* 补剥伪系统标记。streamImpl 现在传 `false` —— 因为它已经用有状态的
* `SystemMarkerStreamFilter` 处理残余了，两遍都跑只会重复劳动；
* 默认 `true` 保留原语义，供单测与其它调用方使用。
*/
function drainTextPipeline(filter, boilerplate, guard, cleanMarkers = true) {
	const tailGuarded = guard.flush();
	const tailBoiled = boilerplate.flush();
	const tail = filter.flush();
	const dedisclaimered = stripWebDisclaimer(tailGuarded.text + tailBoiled.text + tail.text);
	return {
		text: (cleanMarkers ? stripSystemMarkers(dedisclaimered.text) : {
			text: dedisclaimered.text,
			stripped: false
		}).text,
		echoed: tailGuarded.echoed,
		disclaimers: boilerplate.count + (dedisclaimered.stripped ? 1 : 0),
		calls: tail.calls,
		rejected: tail.rejected
	};
}
/**
* 流式剥离网页端免责声明。
*
* 逐包调用：命中即整段丢弃。
*
* ⚠️ 扣留策略必须是「**恒定扣住最后 |声明|-1 个字符**」，不能只扣「声明的前缀」：
* 声明会被 SSE 切成任意小包（实测有「 AI」「 生成」「，」「内容」这种），
* 一旦切点落在声明中间，前半截已经不是「前缀」了 —— 只扣前缀就会把它放出去，
* 后半截到齐时再也拼不回来（2026-09-11 实测漏过一次）。
* 扣 22 个字符的代价是上屏延迟 22 字，肉眼不可见。
*/
var BoilerplateFilter = class {
	pending = "";
	hits = 0;
	stripped = false;
	holdChars = 22;
	push(text) {
		this.pending += text;
		let out = "";
		for (;;) {
			const at = this.pending.indexOf(WEB_DISCLAIMER);
			if (at !== -1) {
				out += this.pending.slice(0, at);
				this.pending = this.pending.slice(at + 23);
				this.hits += 1;
				this.stripped = true;
				continue;
			}
			const hold = Math.min(this.pending.length, this.holdChars);
			out += this.pending.slice(0, this.pending.length - hold);
			this.pending = this.pending.slice(this.pending.length - hold);
			return {
				text: out,
				stripped: this.stripped
			};
		}
	}
	flush() {
		const rest = this.pending;
		this.pending = "";
		return {
			text: rest,
			stripped: this.stripped
		};
	}
	/** 本次流剥掉了几处声明（用于留痕）。 */
	get count() {
		return this.hits;
	}
};
/**
* 转写格式标记 —— 也就是 `serializePrompt` 写进 prompt 的那套行首标记。
*
* 模型会**照着 prompt 里的转写格式模仿**，把工具结果 / 系统标记当回答吐出来。
* 这与「工具调用标记泄漏」是**两个独立的泄漏源**：`ToolCallStreamFilter` 只防后者。
*
* 实测（2026-09-10，deepseek-web / deepseek-reasoner）可见正文里出现：
*   `[Tool Result for call_xxx]` + 真实工具输出 + `[status: running]`
* 以及成串的 `User: …` / `Assistant: …` 转写行。
* 2026-09-11 补：还有一种更隐蔽的形态 —— 给回声行加 `Assistant: ` 前缀
* （`Assistant: [Tool Result for call_xxx]`），必须按「行内含转写标记」判，见 ECHO_INLINE_SIGNATURES。
*/
const ECHO_SIGNATURES = [
	/^\[\s*Tool Result\b/i,
	/^\[\s*status\s*:\s*[a-z_]+\s*\]$/i,
	/^\[\s*(?:System|Assistant)\s*\]$/i
];
/** 转写轮次行：单行可能只是正文，成串出现才是回声。 */
const ECHO_TURN_RE = /^(?:User|Assistant)\s*:/;
/**
* 转写特征出现在**行内任意位置**（不要求行首）。
*
* 实测（2026-09-11 17:07，install-plugin 工作区）：模型输出的回声长这样 ——
*   `Assistant: [Tool Result for call_7b1a7d39a2e54bc0b8f1]`
*   `direct ERR fetch failed`
* 它给回声加了 `Assistant: ` 前缀，于是行首不再匹配 ECHO_SIGNATURES，
* 被当成「正文里偶尔出现的 User: 字样」放行（还顺带把后面那行也带了出来）。
* 所以只要一行里**含有**这些标记，就当回声处理。
*/
/**
* 行内转写特征 —— **拆成强弱两档**，因为两者的可信度完全不同。
*
* 弱档：模型在**正常回答里引用一次**工具结果当证据是很常见的写法。
*   实测（2026-09-16 17:35，1ceshi 工作区会话 e17f4ccf）：它正是在正文里引 `[Tool Result …]`
*   来证明 `subagent_fork` 的继承范围与文档不符 —— 旧判据"行内命中即从该行起砍到结尾"把
*   整段回答（问题项 4、5 + 结论）一起吞了，用户只看到"话说到一半就停了"。
*   ⇒ 单独出现**不足以判定**是回声：只扣住，等后文再看（见 TranscriptEchoGuard.heldKind）。
*
* 强档：`truncated]` / `Assistant truncated` / `[N chars omitted]` 是 **prompt 自己的截断占位符**，
*   正常回答几乎不会引用它们 ⇒ 仍按回声立即处理
*   （实测 2026-09-11 17:2x：会话超长后模型原样复读这些占位符）。
*/
const ECHO_INLINE_WEAK_SIGNATURES = [
	/\[\s*Tool Result\b/i,
	/\[\s*status\s*:/i,
	/\[\s*(?:System|Assistant)\s*\]/i
];
const ECHO_INLINE_STRONG_SIGNATURES = [
	/\[\s*truncated\s*\]/i,
	/assistant\s+truncated/i,
	/\[\s*\d+\s*chars?\s+omitted\s*\]/i
];
[...ECHO_INLINE_WEAK_SIGNATURES, ...ECHO_INLINE_STRONG_SIGNATURES];
/**
* 行内弱特征行被扣住后，还要看到几行**普通内容**才敢判它是正文。
*
* 取 2：真回声紧跟着的还是转写内容（行首标记 / 轮次行 / 又一处引用），两行都干净就基本不是回放。
*/
const WEAK_HOLD_LINES = 2;
/** 扣住的行最多再缓冲几行就强制放行（防止"只有空行"时无限期扣住）。 */
const MAX_HELD_TAIL = 6;
/** 光秃秃的 `Assistant:` / `User:`（冒号后没有内容）—— 模型正在起一行假转写。 */
const ECHO_BARE_TURN_RE = /^(?:User|Assistant)\s*:\s*$/;
/** 回声标记的**半截前缀**（流在行中间被截断时出现）——同样是垃圾，不能上屏。 */
const ECHO_PREFIXES = [
	"[tool result",
	"[status:",
	"[system]",
	"[assistant]"
];
/** 该行是否是某个回声标记的开头片段。 */
function looksLikeEchoPrefix(line) {
	const t = line.trim().toLowerCase();
	return t.length > 0 && ECHO_PREFIXES.some((p) => p.startsWith(t));
}
/**
* 逐行守卫：命中回声特征后，**从该行起全部丢弃**。
*
* 为什么这样设计：
*  - 回声几乎总出现在末尾（模型在「续写转写」），前面才是真回答 → 截断比整段丢弃更保内容；
*  - 围栏代码块内不判定 —— 正常回答里也可能引用这些标记（比如讨论本插件时）；
*  - 逐行缓冲、保留末尾未完成的半行 → 流式下也不会先把垃圾推给用户再吞回去。
*/
var TranscriptEchoGuard = class {
	pending = "";
	inFence = false;
	/**
	* 已扣住、尚未判定的一行（等后文决定它是回声还是正文）。
	* 两种来源：转写轮次行（`User:` / `Assistant:` 后有内容）、行内弱特征行（正文里引用了一次 `[Tool Result …]`）。
	*/
	heldLine = null;
	heldKind = null;
	/** 弱特征行之后已看到的**非空白**普通行数（够 `WEAK_HOLD_LINES` 行仍无回声 → 判为正文、放行）。 */
	heldSeen = 0;
	/**
	* 扣住期间**后续行也要缓冲**，否则它们会抢在被扣的那行之前上屏（顺序错乱）。
	* 放行时按原顺序一次性吐出；判回声时整段丢弃。
	*/
	heldTail = [];
	fired = false;
	/**
	* @returns `text` = 可以安全上屏的部分；`echoed` = 本轮是否出现过回声（那部分已被丢弃）。
	*/
	push(text) {
		if (this.fired) return {
			text: "",
			echoed: true
		};
		this.pending += text;
		let out = "";
		for (;;) {
			const nl = this.pending.indexOf("\n");
			if (nl === -1) break;
			const line = this.pending.slice(0, nl + 1);
			this.pending = this.pending.slice(nl + 1);
			const verdict = this.classify(line);
			if (verdict === "echo") {
				this.fired = true;
				this.pending = "";
				this.heldLine = null;
				this.heldKind = null;
				this.heldTail = [];
				return {
					text: out,
					echoed: true
				};
			}
			if (verdict === "turn" || verdict === "weak") {
				if (this.heldLine !== null) {
					this.fired = true;
					this.pending = "";
					this.heldLine = null;
					this.heldKind = null;
					this.heldTail = [];
					return {
						text: out,
						echoed: true
					};
				}
				this.heldLine = line;
				this.heldKind = verdict;
				this.heldSeen = 0;
				continue;
			}
			if (this.heldLine !== null) {
				this.heldTail.push(line);
				const blank = line.trim() === "";
				if ((this.heldKind === "turn" ? !blank : !blank && ++this.heldSeen >= WEAK_HOLD_LINES) || this.heldTail.length >= MAX_HELD_TAIL) {
					out += this.heldLine;
					for (const held of this.heldTail) out += held;
					this.heldLine = null;
					this.heldKind = null;
					this.heldTail = [];
				}
				continue;
			}
			out += line;
		}
		return {
			text: out,
			echoed: false
		};
	}
	flush() {
		if (this.fired) return {
			text: "",
			echoed: true
		};
		let out = "";
		if (this.heldLine !== null) {
			out += this.heldLine;
			for (const held of this.heldTail) out += held;
			this.heldLine = null;
			this.heldKind = null;
			this.heldTail = [];
		}
		const rest = this.pending;
		this.pending = "";
		if (rest && (this.classify(rest) === "echo" || looksLikeEchoPrefix(rest))) {
			this.fired = true;
			return {
				text: out,
				echoed: true
			};
		}
		return {
			text: out + rest,
			echoed: false
		};
	}
	classify(line) {
		const t = line.trim();
		if (t.startsWith("```") || t.startsWith("~~~")) {
			this.inFence = !this.inFence;
			return "fence";
		}
		if (this.inFence) return "plain";
		for (const re of ECHO_SIGNATURES) if (re.test(t)) return "echo";
		if (/^\]?\s*truncated\s*\]?\s*$/i.test(t)) return "echo";
		for (const re of ECHO_INLINE_STRONG_SIGNATURES) if (re.test(t)) return "echo";
		if (ECHO_BARE_TURN_RE.test(t)) return "echo";
		if (ECHO_TURN_RE.test(t)) {
			for (const re of ECHO_INLINE_WEAK_SIGNATURES) if (re.test(t)) return "echo";
			return "turn";
		}
		for (const re of ECHO_INLINE_WEAK_SIGNATURES) if (re.test(t)) return "weak";
		return "plain";
	}
};

//#endregion
//#region src/providers/looks-mid-sentence.ts
/**
* 句中截断启发式（从 DSH adapter.ts 原样移植 —— 判据与注释一并保留）。
*/
const MID_SENTENCE_TAIL = /* @__PURE__ */ new Set([
	"，",
	"、",
	"；",
	"：",
	",",
	";",
	":"
]);
/**
* 出现在末尾即视为「正常收尾」的标点。
*
* ⚠️ `…` 放在这里是**刻意的取舍**：省略号既可能是"话没说完"，也可能是作者有意的收束语气，
* 两种都常见。判 true 会让一句正常收尾的话被要求"接着写"（模型容易重复一遍），
* 感知上比偶发漏判更打扰，所以保守放行。真被服务端切断（无 FINISHED）时走 `cutByServer`，
* 不依赖这条判据。
*/
const COMPLETE_TAIL = /* @__PURE__ */ new Set([
	"。",
	"！",
	"？",
	"!",
	"?",
	"…",
	"）",
	")",
	"】",
	"》",
	"」",
	"』",
	"\"",
	"”",
	"’"
]);
/**
* 启发式：正文是否「在句中被截」。
* 判据（尾部最后一个非空白字符）：
*  - 是 CJK 汉字/字母/数字（没有任何标点收尾）→ 大概率被截；
*  - 是 markdown 强调标记（`**` / `__`）→ 被截在标记中间；
*  - 是逗号/顿号/分号/冒号 → 明显未完。
*  正常结束的正文几乎总以句号/问号/感叹号/右引号/右括号/代码块收尾/表格行结尾出现。
*
* ⚠️ 这是启发式，**只在"明显没写完"时才敢返回 true**：误判 true 只是白发一次续写请求，
* 误判 false 却是用户直接丢内容 —— 两种代价不同，所以判据本身要能读懂「分隔符 vs 终止符」。
*/
function looksMidSentence(text) {
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return false;
	if (trimmed.length < 40) return false;
	const last = trimmed[trimmed.length - 1];
	if (last === "*" || last === "_" || last === "#" || last === "~" || last === "`") return trimmed.endsWith("**") || trimmed.endsWith("__");
	if (MID_SENTENCE_TAIL.has(last)) return true;
	if (COMPLETE_TAIL.has(last)) return false;
	return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last);
}

//#endregion
//#region src/providers/deepseek.ts
/**
* deepseek-web provider —— 把 OpenAI chat.completions 翻译成 chat.deepseek.com 网页端对话。
*
* 与 DSH 插件 adapter.ts 的关系：消费循环（四层过滤器管线、自动续写、回声守卫、
* finish 判定）是逐行等价移植的，事件模型从 DSH 的 block-start/delta 换成了
* provider-types.ts 的统一事件（reasoning-delta / text-delta / tool-calls / usage / finish）。
* DSH 特有的概念（purpose=session-title、压缩、附件服务）剥离：
*  - purpose 一律 'chat'（续写白名单天然成立）；
*  - 图片改从 OpenAI content 里的 image_url（data URL）直接取字节上传。
*/
/** 与 DSH adapter 等价的续写/纠正指令。 */
const CONTINUE_INSTRUCTION = "继续：请从你上一条回复的结尾处无缝接着往下写——不要重复任何已输出的内容，不要加「好的」「以下是」之类的开场白，不要重新组织语言；如果上一条回复停在句子中间，就从那个断点直接把句子写完并继续。";
const TOOL_CALL_RETRY_INSTRUCTION = "你刚才把要执行的程序写进了正文文本。写在正文里的代码不会被执行 —— 这一轮因此没有发生任何工具调用。\n请把同一段程序作为工具调用重新发出：只输出一个 JSON 对象，前后不要有任何其它文字：\n{\"tool_calls\":[{\"name\":\"<工具名>\",\"arguments\":{...}}]}\n即使系统提示要求你写 TypeScript 程序来完成动作，那个程序也必须放进工具调用的 arguments 里，不能直接写在正文中 —— 只有作为工具调用发出，它才会真的被执行。";
const MODEL_SPECS = [{
	id: "deepseek-chat",
	name: "DeepSeek 网页 · 快速模式（思考关）",
	contextWindow: 1048576
}, {
	id: "deepseek-reasoner",
	name: "DeepSeek 网页 · 快速模式（思考开）",
	contextWindow: 1048576
}];
/** 旧档位别名 → 现档位（DSH 插件语义保持一致）。 */
const LEGACY_ALIASES = {
	"deepseek-pro": "deepseek-chat",
	"deepseek-expert": "deepseek-chat",
	"deepseek-vision": "deepseek-chat"
};
function resolveModel(model) {
	const requested = String(model ?? "").toLowerCase();
	const direct = MODEL_SPECS.find((spec) => spec.id === requested);
	if (direct) return {
		id: direct.id,
		thinking: direct.id === "deepseek-reasoner"
	};
	const alias = LEGACY_ALIASES[requested];
	if (alias) return {
		id: alias,
		thinking: alias === "deepseek-reasoner"
	};
	return {
		id: "deepseek-chat",
		thinking: false
	};
}
/** 图片上传缓存：按账号作用域 + TTL + 条数封顶（移植自 DSH adapter.ImageUploadCache）。 */
var ImageUploadCache = class {
	scope = "";
	entries = /* @__PURE__ */ new Map();
	maxEntries = 200;
	ttlMs = 18e5;
	useScope(token) {
		if (token !== this.scope) {
			this.scope = token;
			this.entries.clear();
		}
	}
	get(key) {
		const hit = this.entries.get(key);
		if (!hit) return void 0;
		if (Date.now() > hit.expiresAt) {
			this.entries.delete(key);
			return;
		}
		return hit.fileId;
	}
	set(key, fileId, at, scope) {
		if (scope !== this.scope) return;
		this.entries.set(key, {
			fileId,
			expiresAt: at + this.ttlMs
		});
		if (this.entries.size > this.maxEntries) {
			const oldest = [...this.entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
			if (oldest) this.entries.delete(oldest[0]);
		}
	}
	prune() {
		const now = Date.now();
		for (const [key, value] of this.entries) if (now > value.expiresAt) this.entries.delete(key);
	}
};
/** 从 OpenAI content 块里收集图片（data URL only；http(s) URL 网页端无法直取，降级为占位标记）。 */
function collectOpenAIImages(messages) {
	const images = [];
	for (const message of messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block?.type !== "image_url") continue;
			const url = String(block.image_url?.url ?? "");
			const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
			if (!match) continue;
			try {
				const data = Uint8Array.from(Buffer.from(match[2], "base64"));
				const mediaType = match[1].toLowerCase();
				images.push({
					attachmentId: `data:${mediaType}:${data.length}`,
					data,
					mediaType
				});
			} catch {}
		}
	}
	return images;
}
var DeepseekWebProvider = class {
	id = "deepseek-web";
	displayName = "DeepSeek 网页版（免费）";
	gate;
	uploadCache = new ImageUploadCache();
	sessionCleaner;
	options;
	constructor(options = {}) {
		this.options = options;
		const cfg = options.config ?? {};
		this.gate = createRequestGate({
			allowConcurrent: false,
			minIntervalMs: cfg.minRequestIntervalMs ?? 2e3,
			maxIntervalMs: cfg.maxRequestIntervalMs ?? 4e3,
			logger: options.logger
		});
		if (cfg.sessionCleanup && cfg.sessionCleanup !== "immediate") this.sessionCleaner = createSessionCleaner({ policy: { mode: cfg.sessionCleanup } });
	}
	async status() {
		const auth = readActiveAuth();
		if (!hasUsableAuth(auth)) return {
			loggedIn: false,
			detail: "尚未登录（用 `dsweb-proxy login` 或手动粘贴 token）"
		};
		return {
			loggedIn: true,
			...auth.user?.display ? { display: auth.user.display } : {},
			...auth.unverified ? { detail: "凭证未通过服务端校验" } : {}
		};
	}
	async login(options) {
		const { browserLogin } = await import("./browser-login-B8TxIbq4.mjs");
		try {
			const outcome = await browserLogin({ ...options?.headless !== void 0 ? { headless: options.headless } : {} });
			if (outcome?.auth) {
				const { commitCapturedAuth } = await Promise.resolve().then(() => account_ctx_exports);
				commitCapturedAuth(outcome.auth);
				return {
					ok: true,
					message: `登录成功（${outcome.auth.user?.display ?? "未知账号"}）`
				};
			}
			return {
				ok: false,
				message: String(outcome?.error ?? "登录未完成（窗口被关闭或超时）")
			};
		} catch (error) {
			return {
				ok: false,
				message: `登录失败：${error?.message ?? error}`
			};
		}
	}
	async logout() {
		const { clearActiveAuth } = await Promise.resolve().then(() => account_ctx_exports);
		clearActiveAuth();
		return {
			ok: true,
			message: "已退出当前账号"
		};
	}
	models() {
		return MODEL_SPECS;
	}
	async chat(request) {
		const auth = readActiveAuth();
		if (!hasUsableAuth(auth)) throw new AdapterLlmError("尚未登录 DeepSeek 网页版：先运行 `dsweb-proxy login`，或在设置里手动粘贴 userToken。", "MISSING_CREDENTIAL");
		return { stream: this.gatedChat(auth, request) };
	}
	/** 闸门外壳（与 DSH gatedStream 等价：acquire 后才真正开始，finally 必释放）。 */
	async *gatedChat(auth, request) {
		const release = await this.gate.acquire("chat", request.signal);
		try {
			yield* this.streamImpl(auth, request);
		} finally {
			release();
		}
	}
	async *streamImpl(auth, request) {
		const cfg = this.options.config ?? {};
		const logger = this.options.logger;
		const runStream = this.options.streamCompletion ?? streamWebCompletion;
		const uploadImage = this.options.uploadImage ?? uploadImageFile;
		const { id: modelId, thinking: modelThinking } = resolveModel(request.model);
		const images = collectOpenAIImages(request.messages);
		const maxRefImages = cfg.maxRefImages ?? 24;
		const overLimit = maxRefImages > 0 && images.length > maxRefImages;
		const kept = overLimit ? images.slice(-maxRefImages) : images;
		const keptKeys = new Set(kept.map((image) => image.attachmentId));
		const notices = [];
		if (overLimit) notices.push(`\n[deepseek-web] 本轮只带了最近的 ${kept.length} 张图片，更早的 ${images.length - kept.length} 张没有随请求发送。这是正常的长度控制，不是错误。
`);
		this.uploadCache.useScope(auth.token);
		this.uploadCache.prune();
		const refFileIds = [];
		const failures = [];
		for (const image of kept) {
			request.signal?.throwIfAborted();
			const cached = this.uploadCache.get(image.attachmentId);
			if (cached) {
				refFileIds.push(cached);
				continue;
			}
			try {
				const uploaded = await uploadImage(auth, {
					data: image.data,
					mediaType: image.mediaType,
					name: imageUploadName(image.name, image.mediaType)
				}, request.signal);
				this.uploadCache.set(image.attachmentId, uploaded.fileId, Date.now(), auth.token);
				refFileIds.push(uploaded.fileId);
			} catch (error) {
				if (request.signal?.aborted) throw error;
				const message = String(error?.message ?? error);
				failures.push(message);
				logger?.warn?.(`deepseek-web: 图片上传失败（已降级为纯文本）：${message}`);
			}
		}
		if (failures.length > 0) {
			const brief = failures[0].length > 120 ? `${failures[0].slice(0, 120)}…` : failures[0];
			notices.push(`\n⚠️ [deepseek-web] 有 ${failures.length} 张图片没能传给模型（${brief}），本轮回答只基于文字内容。\n`);
		}
		const uploadNotice = notices.join("");
		const system = request.messages.filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : "").join("\n");
		const chatMessages = request.messages.filter((message) => message.role !== "system");
		const tools = (request.tools ?? []).filter((tool) => tool?.type === "function" && tool.function?.name).map((tool) => ({
			name: tool.function.name,
			description: tool.function.description ?? "",
			parameters: tool.function.parameters ?? {}
		}));
		const maxChars = cfg.maxPromptChars ?? 4e5;
		let promptParts = serializePromptParts({
			system,
			messages: chatMessages,
			tools,
			maxChars,
			keptImageKeys: keptKeys
		});
		let currentPrompt = promptParts.full;
		const knownNames = new Set(tools.map((tool) => tool.name));
		let filter = new ToolCallStreamFilter(knownNames);
		let echoGuard = new TranscriptEchoGuard();
		let systemMarkerFilter = new SystemMarkerStreamFilter();
		let boilerplate = new BoilerplateFilter();
		let toolCallCount = 0;
		let finishReason;
		const usageRounds = [];
		let rejectedProtocol = "";
		let rejectedReason;
		let echoedTranscript = false;
		let textLen = 0;
		let reasoningLen = 0;
		let rounds = 0;
		let toolCallRetried = false;
		const emitCalls = function* (calls) {
			for (const call of calls) {
				toolCallCount += 1;
				yield {
					type: "tool-calls",
					calls: [call]
				};
			}
		};
		try {
			if (uploadNotice) {
				textLen += uploadNotice.length;
				this.textBuffer += uploadNotice;
				yield {
					type: "text-delta",
					text: uploadNotice
				};
			}
			for (;;) {
				let roundError;
				finishReason = void 0;
				const textLenAtRoundStart = textLen;
				const roundUsage = {
					prompt: currentPrompt,
					outputChars: 0
				};
				usageRounds.push(roundUsage);
				try {
					for await (const event of runStream(auth, {
						prompt: currentPrompt,
						promptParts: {
							head: promptParts.head,
							entries: promptParts.entries,
							maxChars
						},
						thinkingEnabled: modelThinking,
						modelType: modelId === "deepseek-reasoner" ? "default" : "default",
						refFileIds: rounds === 0 ? refFileIds : [],
						signal: request.signal,
						idleTimeoutMs: 12e4,
						onDeleteSession: cfg.deleteWebSessions === false ? void 0 : (sessionId) => {
							if (this.sessionCleaner) this.sessionCleaner.schedule(auth, sessionId);
							else scheduleDeleteSession(auth, sessionId);
						}
					})) {
						if (event.kind === "thinking" || event.kind === "text") roundUsage.outputChars += event.text.length;
						if (event.kind === "thinking") {
							reasoningLen += event.text.length;
							yield {
								type: "reasoning-delta",
								text: event.text
							};
							continue;
						}
						if (event.kind === "text") {
							const out = filter.push(event.text);
							const boiled = boilerplate.push(out.text);
							const guarded = echoGuard.push(boiled.text);
							if (guarded.echoed) echoedTranscript = true;
							const cleaned = systemMarkerFilter.push(guarded.text);
							if (cleaned.text) {
								textLen += cleaned.text.length;
								this.textBuffer += cleaned.text;
								yield {
									type: "text-delta",
									text: cleaned.text
								};
							}
							if (out.calls.length > 0) yield* emitCalls(out.calls);
							continue;
						}
						if (event.kind === "status") {
							logger?.debug?.(`deepseek-web: status=${event.value}`);
							continue;
						}
						if (event.kind === "error") {
							if (event.code === "RATE_LIMIT") throw new AdapterLlmError(event.rateLimitKind === "throttled" ? `DeepSeek 网页端对这个账号限流了（发得太频繁）。这一步会自动退避重试。` : `DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口正在生成）。这一步会自动重试。`, "RATE_LIMIT", { ...event.retryAfterMs !== void 0 ? { providerRetryAfterMs: event.retryAfterMs } : {} });
							throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, "PROVIDER_ERROR");
						}
						if (event.kind === "finish") {
							finishReason = event.reason;
							if (typeof event.totalTokens === "number" && Number.isSafeInteger(event.totalTokens) && event.totalTokens >= 0) roundUsage.total = event.totalTokens;
						}
					}
				} catch (error) {
					if (rounds > 0) {
						if (request.signal?.aborted) throw new AdapterLlmError("请求被取消", "ABORTED", { cause: error });
						roundError = error instanceof AdapterLlmError ? error : new AdapterLlmError(`自动续写失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
						logger?.warn?.(`deepseek-web: 自动续写第 ${rounds} 轮失败，保留已输出部分：${roundError.message}`);
					} else throw error;
				}
				const drained = drainTextPipeline(filter, boilerplate, echoGuard, false);
				if (drained.echoed) echoedTranscript = true;
				const markerPending = systemMarkerFilter.push(drained.text);
				const markerEnd = systemMarkerFilter.flush();
				const tailText = markerPending.text + markerEnd.text;
				if (tailText) {
					textLen += tailText.length;
					this.textBuffer += tailText;
					yield {
						type: "text-delta",
						text: tailText
					};
				}
				if (drained.calls.length > 0) yield* emitCalls(drained.calls);
				if (drained.rejected && rounds === 0) {
					rejectedProtocol = drained.rejected.raw;
					rejectedReason = drained.rejected.reason ?? "unparsable";
				}
				const roundChars = textLen - textLenAtRoundStart;
				const maxRounds = cfg.maxContinuations ?? 2;
				const cutByServer = finishReason === void 0;
				const partial = this.textBuffer;
				const eligible = roundError === void 0 && cfg.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !request.signal?.aborted && partial.length > 0 && roundChars > 0 && (looksMidSentence(partial) || cutByServer);
				const unexecutedProgram = !eligible && roundError === void 0 && cfg.autoContinue !== false && rounds < maxRounds && toolCallCount === 0 && !toolCallRetried && !request.signal?.aborted && partial.length > 0 && looksLikeUnexecutedToolProgram(partial);
				if (!eligible && !unexecutedProgram) break;
				rounds += 1;
				if (unexecutedProgram) toolCallRetried = true;
				logger?.info?.(unexecutedProgram ? `deepseek-web: 本轮把工具程序写进了正文，已要求改发工具调用（第 ${rounds}/${maxRounds} 轮）` : `deepseek-web: 回答疑似在句中被截，自动续写（第 ${rounds}/${maxRounds} 轮）`);
				promptParts = serializePromptParts({
					system,
					messages: [
						...chatMessages,
						{
							role: "assistant",
							content: [{
								type: "text",
								text: partial
							}]
						},
						{
							role: "user",
							content: [{
								type: "text",
								text: unexecutedProgram ? TOOL_CALL_RETRY_INSTRUCTION : CONTINUE_INSTRUCTION
							}]
						}
					],
					tools,
					maxChars
				});
				currentPrompt = promptParts.full;
				filter = new ToolCallStreamFilter(knownNames);
				echoGuard = new TranscriptEchoGuard();
				systemMarkerFilter = new SystemMarkerStreamFilter();
				boilerplate = new BoilerplateFilter();
			}
		} catch (error) {
			if (error instanceof AdapterLlmError) throw error;
			if (request.signal?.aborted) throw new AdapterLlmError("请求被取消", "ABORTED", { cause: error });
			throw new AdapterLlmError(`流失败：${error?.message ?? error}`, "TRANSPORT", { cause: error });
		}
		if (echoedTranscript && toolCallCount === 0 && this.textBuffer.length > 0) {
			const echoNotice = "\n\n[deepseek-web] 本轮有一部分「历史回放格式」的内容被过滤（未上屏），回答可能因此不完整。\n";
			this.textBuffer += echoNotice;
			yield {
				type: "text-delta",
				text: echoNotice
			};
		}
		let inputTokens = 0;
		let outputTokens = 0;
		for (const round of usageRounds) {
			const estimateOutput = Math.ceil(round.outputChars / 3.2);
			if (round.total !== void 0) {
				const output = Math.min(round.total, estimateOutput);
				outputTokens += output;
				inputTokens += round.total - output;
			} else {
				outputTokens += estimateOutput;
				inputTokens += estimateTokens(round.prompt);
			}
		}
		yield {
			type: "usage",
			inputTokens,
			outputTokens,
			...reasoningLen > 0 ? { reasoningTokens: Math.min(outputTokens, estimateTokens("x".repeat(reasoningLen))) } : {}
		};
		if (toolCallCount > 0) {
			yield {
				type: "finish",
				reason: "tool-calls"
			};
			return;
		}
		const hasVisibleText = this.textBuffer.length > 0;
		if (echoedTranscript && !hasVisibleText) {
			yield {
				type: "finish",
				reason: "error",
				error: {
					message: "DeepSeek 网页端把「对话转写格式」当成回答输出了（已丢弃），本次没有产生有效内容。",
					code: "EMPTY_RESPONSE",
					retryable: true
				}
			};
			return;
		}
		if (rejectedProtocol) {
			yield {
				type: "finish",
				reason: "error",
				error: {
					message: rejectedReason === "echo" ? "网页端本次输出的是一段历史内容回放（不是真要执行调用），已丢弃并自动重试；无需处理。" : rejectedReason === "unbalanced" ? "网页端本次输出被截断，调用没收全，已丢弃并自动重试；无需处理。" : "网页端本次的调用格式无法解析，已丢弃并自动重试；无需处理。",
					code: "EMPTY_RESPONSE",
					retryable: true
				}
			};
			return;
		}
		if (!hasVisibleText) {
			yield {
				type: "finish",
				reason: "error",
				error: {
					message: "DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）",
					code: "EMPTY_RESPONSE",
					retryable: true
				}
			};
			return;
		}
		yield {
			type: "finish",
			reason: "stop"
		};
	}
	/** 累计正文缓冲（续写判句中 / 回声告知都要全文）。 */
	textBuffer = "";
};

//#endregion
//#region src/registry.ts
const registry = /* @__PURE__ */ new Map();
function registerProvider(id, factory) {
	if (registry.has(id)) throw new Error(`provider "${id}" 已注册`);
	registry.set(id, factory);
}
function createProvider(id) {
	const factory = registry.get(id);
	if (!factory) throw new Error(`未知 provider "${id}"（已注册：${[...registry.keys()].join(", ")}）`);
	return factory();
}
registerProvider("deepseek-web", () => new DeepseekWebProvider());

//#endregion
//#region src/config.ts
/**
* 配置加载 —— 单一来源：`${webLoginDir()}/proxy.json`。
* DSH 插件时代的 gate.json / context-feed.json 继续沿用（共享同一状态目录），
* 这里只放反代自身的新配置（监听端口、API key 门禁、各 provider 覆盖项）。
*/
const DEFAULT_CONFIG = {
	port: 8787,
	host: "127.0.0.1"
};
function proxyConfigPath() {
	return `${webLoginDir()}/proxy.json`;
}
function readProxyConfig() {
	try {
		const raw = JSON.parse(readFileSync(proxyConfigPath(), "utf8"));
		return {
			...DEFAULT_CONFIG,
			...raw,
			deepseek: {
				...DEFAULT_CONFIG.deepseek,
				...raw?.deepseek
			}
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

//#endregion
//#region src/server/normalize.ts
function textContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
	return "";
}
function normalizeChatRequest(body, signal) {
	const messages = [];
	for (const message of body?.messages ?? []) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "system" || message.role === "developer") {
			const text = textContent(message.content);
			if (text.trim()) messages.push({
				role: "system",
				content: [{
					type: "text",
					text
				}]
			});
			continue;
		}
		if (message.role === "user") {
			const blocks = [];
			const text = textContent(message.content);
			if (text.trim()) blocks.push({
				type: "text",
				text
			});
			if (Array.isArray(message.content)) {
				for (const block of message.content) if (block?.type === "image_url") blocks.push({
					type: "text",
					text: "[image attached]"
				});
			}
			messages.push({
				role: "user",
				content: blocks
			});
			continue;
		}
		if (message.role === "assistant") {
			const blocks = [];
			const text = textContent(message.content);
			if (text.trim()) blocks.push({
				type: "text",
				text
			});
			for (const call of message.tool_calls ?? []) blocks.push({
				type: "tool-call",
				id: String(call.id ?? ""),
				name: String(call.function?.name ?? ""),
				arguments: String(call.function?.arguments ?? "{}")
			});
			messages.push({
				role: "assistant",
				content: blocks
			});
			continue;
		}
		if (message.role === "tool") {
			const body = textContent(message.content) || "(no output)";
			messages.push({
				role: "user",
				content: [{
					type: "tool-result",
					toolCallId: String(message.tool_call_id ?? ""),
					content: [{
						type: "text",
						text: body
					}]
				}]
			});
			continue;
		}
	}
	const tools = (body?.tools ?? []).filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string");
	return {
		model: String(body?.model ?? "deepseek-chat"),
		messages,
		tools,
		stream: body?.stream !== false,
		signal
	};
}

//#endregion
//#region src/server/openai-format.ts
function newChunkState(model) {
	return {
		id: `chatcmpl-${crypto.randomUUID()}`,
		created: Math.floor(Date.now() / 1e3),
		model,
		toolIndex: 0,
		emittedRole: false
	};
}
function chunkEnvelope(state, delta, finish) {
	const payload = {
		id: state.id,
		object: "chat.completion.chunk",
		created: state.created,
		model: state.model,
		choices: [{
			index: 0,
			delta,
			finish_reason: finish ?? null
		}]
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}
/** 单个事件 → 0..n 个 SSE 帧（含 [DONE] 的不发；[DONE] 由调用方在流末尾统一发）。 */
function eventToChunks(state, event) {
	const frames = [];
	switch (event.type) {
		case "reasoning-delta":
			frames.push(chunkEnvelope(state, {
				...state.emittedRole ? {} : { role: "assistant" },
				reasoning_content: event.text
			}));
			state.emittedRole = true;
			break;
		case "text-delta":
			frames.push(chunkEnvelope(state, {
				...state.emittedRole ? {} : { role: "assistant" },
				content: event.text
			}));
			state.emittedRole = true;
			break;
		case "tool-calls":
			for (const call of event.calls) {
				frames.push(chunkEnvelope(state, { tool_calls: [{
					index: state.toolIndex,
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments: call.arguments
					}
				}] }));
				state.toolIndex += 1;
				state.emittedRole = true;
			}
			break;
		case "usage": break;
		case "finish": frames.push(chunkEnvelope(state, {}, event.reason === "error" ? "stop" : event.reason === "length" ? "length" : event.reason));
	}
	return frames;
}
/** 非流式：聚合事件 → 完整 chat.completion 对象。 */
function aggregateResponse(state, events) {
	let content = "";
	let reasoning = "";
	const toolCalls = [];
	let finish = "stop";
	let usage;
	let errorEvent;
	for (const event of events) if (event.type === "text-delta") content += event.text;
	else if (event.type === "reasoning-delta") reasoning += event.text;
	else if (event.type === "tool-calls") for (const call of event.calls) toolCalls.push({
		id: call.id,
		type: "function",
		function: {
			name: call.name,
			arguments: call.arguments
		}
	});
	else if (event.type === "usage") usage = {
		prompt_tokens: event.inputTokens,
		completion_tokens: event.outputTokens,
		total_tokens: event.inputTokens + event.outputTokens
	};
	else if (event.type === "finish") {
		if (event.reason === "error") errorEvent = event.error;
		else finish = event.reason === "length" ? "length" : event.reason;
	}
	const message = {
		role: "assistant",
		content: content || null
	};
	if (reasoning) message.reasoning_content = reasoning;
	if (toolCalls.length > 0) message.tool_calls = toolCalls;
	return {
		id: state.id,
		object: "chat.completion",
		created: state.created,
		model: state.model,
		choices: [{
			index: 0,
			message,
			finish_reason: errorEvent ? "stop" : finish,
			...errorEvent ? { error: {
				message: errorEvent.message,
				code: errorEvent.code
			} } : {}
		}],
		...usage ? { usage } : {}
	};
}

//#endregion
//#region src/server/http.ts
/**
* OpenAI 兼容 HTTP 服务器（node:http，零依赖）。
*
* 路由：
*   GET  /v1/models                     → provider 模型目录（含登录状态头）
*   POST /v1/chat/completions           → 主对话（流式 SSE / 非流式 JSON）
*   GET  /admin/status                  → 登录状态（JSON）
*   POST /admin/login                   → 触发浏览器登录（CDP）
*   POST /admin/logout                  → 清当前账号
*   GET  /healthz                       → 探活
*
* 设计要点：
*  - 客户端断开（request 'close'）必须 AbortController 传递到底 —— 网页端那边的
*    临时会话才不会漏删（webapi 的 finally 依赖 signal）。
*  - 流式下每 15s 发一个 SSE comment（`: keep-alive`），防客户端/代理空闲超时；
*    长回答（>60s 网页端上限）期间 ZCode 不会判死。
*  - 错误映射：AdapterLlmError.code → OpenAI error 对象；重试语义经 `retryable`
*    传给客户端（OpenAI 协议没有标准字段，放在 error 对象上供 ZCode 读取）。
*/
const KEEP_ALIVE_MS = 15e3;
async function startServer(config = readProxyConfig()) {
	const server = createServer((req, res) => {
		route(req, res, config).catch((error) => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			try {
				res.end(JSON.stringify({ error: {
					message: String(error?.message ?? error),
					type: "internal_error"
				} }));
			} catch {}
		});
	});
	await new Promise((resolve) => server.listen(config.port, config.host, resolve));
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : config.port,
		host: config.host,
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
}
function authorize(req, config) {
	if (!config.apiKey) return true;
	return (req.headers.authorization ?? "") === `Bearer ${config.apiKey}`;
}
function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}
function errorPayload(message, code, status, retryable, retryAfterMs) {
	return { error: {
		message,
		type: code === "RATE_LIMIT" ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error",
		code,
		...retryable !== void 0 ? { retryable } : {},
		...retryAfterMs !== void 0 ? { retry_after_ms: retryAfterMs } : {}
	} };
}
async function route(req, res, config) {
	const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
	if (path === "/healthz") {
		sendJson(res, 200, { ok: true });
		return;
	}
	if (!authorize(req, config)) {
		sendJson(res, 401, errorPayload("无效的 API key（proxy.json 的 apiKey）", "UNAUTHORIZED", 401));
		return;
	}
	if (path === "/admin/status" && req.method === "GET") {
		const provider = createProvider("deepseek-web");
		sendJson(res, 200, { providers: Object.fromEntries([[provider.id, await provider.status()]]) });
		return;
	}
	if (path === "/admin/login" && req.method === "POST") {
		sendJson(res, 200, await createProvider("deepseek-web").login());
		return;
	}
	if (path === "/admin/logout" && req.method === "POST") {
		sendJson(res, 200, await createProvider("deepseek-web").logout());
		return;
	}
	if (path === "/v1/models" && req.method === "GET") {
		const provider = createProvider("deepseek-web");
		const status = await provider.status();
		sendJson(res, 200, {
			object: "list",
			data: provider.models().map((model) => ({
				id: model.id,
				object: "model",
				owned_by: provider.id,
				context_window: model.contextWindow,
				x_logged_in: status.loggedIn
			}))
		});
		return;
	}
	if (path === "/v1/chat/completions" && req.method === "POST") {
		await handleChat(req, res, config);
		return;
	}
	sendJson(res, 404, errorPayload(`未知路由 ${req.method} ${path}`, "NOT_FOUND", 404));
}
async function readBody(req, limitBytes = 67108864) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limitBytes) throw new Error("请求体超过 64MB 上限");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
async function handleChat(req, res, config) {
	const controller = new AbortController();
	const onClientGone = () => {
		if (!res.writableEnded) controller.abort(new AdapterLlmError("客户端已断开", "ABORTED"));
	};
	res.on("close", onClientGone);
	let body;
	try {
		body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
	} catch (error) {
		sendJson(res, 400, errorPayload(`请求体不是合法 JSON：${error?.message ?? error}`, "BAD_REQUEST", 400));
		return;
	}
	const normalized = normalizeChatRequest(body, controller.signal);
	const provider = createProvider("deepseek-web");
	let result;
	try {
		result = await provider.chat(normalized);
	} catch (error) {
		const code = error instanceof AdapterLlmError ? String(error.code) : "PROVIDER_ERROR";
		const status = code === "MISSING_CREDENTIAL" ? 401 : code === "RATE_LIMIT" ? 429 : 502;
		sendJson(res, status, errorPayload(String(error?.message ?? error), code, status, code !== "MISSING_CREDENTIAL", error?.providerRetryAfterMs));
		return;
	}
	if (normalized.stream) await streamResponse(res, state0(normalized.model), result.stream, controller);
	else {
		const collected = [];
		try {
			for await (const event of result.stream) collected.push(event);
		} catch (error) {
			const code = error instanceof AdapterLlmError ? String(error.code) : "PROVIDER_ERROR";
			const status = code === "MISSING_CREDENTIAL" ? 401 : code === "RATE_LIMIT" ? 429 : 502;
			sendJson(res, status, errorPayload(String(error?.message ?? error), code, status));
			return;
		}
		sendJson(res, 200, aggregateResponse(newChunkState(normalized.model), collected));
	}
}
function state0(model) {
	return newChunkState(model);
}
async function streamResponse(res, state, stream, controller) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive"
	});
	const keepAlive = setInterval(() => {
		try {
			res.write(": keep-alive\n\n");
		} catch {}
	}, KEEP_ALIVE_MS);
	keepAlive.unref?.();
	try {
		for await (const event of stream) {
			for (const frame of eventToChunks(state, event)) if (!res.write(frame)) await new Promise((resolve) => res.once("drain", resolve));
			if (controller.signal.aborted) break;
		}
		res.write("data: [DONE]\n\n");
		res.end();
	} catch (error) {
		const code = error instanceof AdapterLlmError ? String(error.code) : "PROVIDER_ERROR";
		const frame = `data: ${JSON.stringify({ error: {
			message: String(error?.message ?? error),
			code
		} })}\n\n`;
		try {
			if (!res.writableEnded) {
				res.write(frame);
				res.write("data: [DONE]\n\n");
				res.end();
			}
		} catch {}
	} finally {
		clearInterval(keepAlive);
	}
}

//#endregion
//#region src/cli.ts
/**
* dsweb-proxy CLI —— serve / login / status / logout / config。
*
* 用法：
*   dsweb-proxy serve [--port 8787] [--host 127.0.0.1]
*   dsweb-proxy login          # 拉起真实 Edge/Chrome 登录窗口（CDP 捕获凭证）
*   dsweb-proxy status
*   dsweb-proxy logout
*   dsweb-proxy token <userToken>   # 手动粘 token（非交互环境）
*/
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const item = argv[i];
		if (item.startsWith("--")) {
			const key = item.slice(2);
			args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
		}
	}
	return args;
}
async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	const provider = createProvider("deepseek-web");
	switch (command) {
		case "serve": {
			const config = { ...readProxyConfig() };
			if (args.port) config.port = Number(args.port);
			if (args.host) config.host = args.host;
			const handle = await startServer(config);
			const status = await provider.status();
			console.log(`[dsweb-proxy] http://${handle.host}:${handle.port}/v1`);
			console.log(`[dsweb-proxy] 登录状态：${status.loggedIn ? `已登录${status.display ? `（${status.display}）` : ""}` : "未登录 —— 先运行 dsweb-proxy login"}`);
			console.log("[dsweb-proxy] ZCode 接入：provider_config.json 里把 baseUrl 指到上面的 /v1，模型选 deepseek-chat / deepseek-reasoner");
			process.on("SIGINT", async () => {
				await handle.close();
				process.exit(0);
			});
			return;
		}
		case "login": {
			console.log("[dsweb-proxy] 拉起浏览器登录窗口（登录完成后窗口自动关闭）……");
			const outcome = await provider.login();
			console.log(`[dsweb-proxy] ${outcome.message}`);
			process.exit(outcome.ok ? 0 : 1);
			break;
		}
		case "status": {
			const status = await provider.status();
			console.log(JSON.stringify(status, null, 2));
			return;
		}
		case "logout": {
			const outcome = await provider.logout();
			console.log(`[dsweb-proxy] ${outcome.message}`);
			return;
		}
		case "token": {
			const token = rest[0];
			if (!token) {
				console.error("用法：dsweb-proxy token <userToken>");
				process.exit(2);
			}
			const { commitCapturedAuth } = await Promise.resolve().then(() => account_ctx_exports);
			commitCapturedAuth({ token });
			console.log("[dsweb-proxy] token 已写入当前账号（校验会在首次请求时进行）");
			return;
		}
		case "config": {
			const config = readProxyConfig();
			console.log(JSON.stringify(config, null, 2));
			console.log("\n// ZCode provider_config.json 接入片段（加进 providerRules）：");
			console.log(JSON.stringify({
				providerId: "dsweb-proxy",
				providerName: "DeepSeek Web (proxy)",
				config: {
					group: "standard-personal",
					access: {
						type: "api-key",
						apiKey: config.apiKey ?? "local"
					},
					api: {
						type: "openai-chat-completions",
						baseUrl: `http://${config.host}:${config.port}/v1`
					},
					personalModelIds: ["deepseek-chat", "deepseek-reasoner"],
					modelOrder: ["deepseek-chat", "deepseek-reasoner"]
				}
			}, null, 2));
			return;
		}
		default:
			console.error("用法：dsweb-proxy <serve|login|status|logout|token|config>\n  serve   启动 OpenAI 兼容反代（默认 127.0.0.1:8787）\n  login   浏览器窗口登录（CDP 捕获凭证）\n  status  登录状态\n  logout  退出当前账号\n  token   手动粘贴 userToken\n  config  查看配置与 ZCode 接入片段");
			process.exit(command ? 2 : 0);
	}
}
main().catch((error) => {
	console.error(`[dsweb-proxy] ${error?.stack ?? error}`);
	process.exit(1);
});

//#endregion
export { unwrapStoredToken as n, pickCookieMeta as r, DS_BASE as t };