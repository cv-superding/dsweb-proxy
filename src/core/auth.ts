/**
 * dsh-deepseek-web-login — 凭证存储与结构化错误。
 *
 * 登录凭证来自 chat.deepseek.com 网页端（浏览器窗口捕获或手动粘贴）：
 * Bearer token + cookie + 反爬指纹头（x-hif-*）+ PoW WASM 地址。
 *
 * 存储已从「单个文件」升级成「**账号库**」（见 accounts.ts）：本文件只保留
 * 类型 + 存取门面 —— `readAuth()` 取当前生效的账号、`writeAuth()` 写入并设为当前、
 * `clearAuth()` 移除当前账号。这样适配器、登录流程、诊断等**所有调用点一行都不用改**。
 *
 * 位置：`${DSH_HOME || ~/.dsh}/web-login/accounts/<id>.json`（插件自治，
 * 不进 settings/credentials 缝合口，避免敏感凭据落入通用配置面）。
 */
import { existsSync } from 'node:fs'
import type { CookieMeta } from './cookies.ts'
import {
  activeAccount,
  clearActiveAccount,
  readAccount,
  removeAccount,
  setActiveAccount,
  updateAccount,
  upsertAccount,
} from './accounts.ts'
import { resolveProxyHome } from './paths.ts'

// resolveDshHome 搬去了 paths.ts（那是为了避开 auth 与 accounts 的 import 环）。
// 这里原样再导出：外部既有代码（transport.ts / net-diagnostics.ts）不用改。
export { resolveProxyHome as resolveDshHome }

/** 一份已捕获的网页端登录凭证。 */
export interface WebAuth {
  /** chat.deepseek.com 的 Bearer token（网页端 localStorage userToken）。 */
  token: string
  /** deepseek.com 域 cookie 串（name=value; ...）。 */
  cookie: string
  /** 反爬指纹头（捕获自浏览器请求；缺省为空串）。 */
  hifDliq: string
  hifLeim: string
  /** PoW 求解器 WASM 地址（来自页面资源；缺省用已知默认）。 */
  wasmUrl: string
  /** 登录会话的浏览器 UA（补齐请求指纹）。 */
  userAgent: string
  /**
   * 浏览器真实请求头快照（accept-language / x-client-version 等，随网页端版本走）。
   * 复用它可让插件请求与网页端保持一致，避免硬编码版本号随 DeepSeek 升级失效。
   */
  extraHeaders?: Record<string, string>
  /** 捕获时间（ISO）。 */
  capturedAt: string
  /** 是否未经服务端校验（fail-open 落盘的凭证）。 */
  unverified?: boolean
  /** 已掩码的账号展示信息（可选）。 */
  user?: { id?: string; display?: string }
  /**
   * 捕获时顺手记下的 cookie 过期构成（可选）。
   *
   * 用途只有一个：把"登录态到底还能撑多久"从**完全不可观察**变成**至少能看一半**。
   * ⚠️ 别把它当登录态寿命来读 —— 实测真正鉴权用的是 `token`：
   * 只发 token 不带 cookie 能通过，只发 cookie 不带 token 直接被拒。
   * 所以这里面最晚的到期时间**只是浏览器侧的上界**，不是凭证失效时间。
   *
   * 老记录 / 手动粘 token 的账号没有这个字段（界面会说明"未记录"）。
   */
  cookieMeta?: CookieMeta[]
}

/** 当前生效的登录凭证（没有选择账号 → undefined）。 */
export function readAuth(provider: string = 'deepseek'): WebAuth | undefined {
  return activeAccount(provider)
}

/**
 * 写入/更新凭证。
 *
 * 语义：**写进去的那个就是接下来要用的那个** —— 所有调用点（浏览器捕获、
 * 手动粘 token、登录流程回填账号信息）表达的都是这个意思，所以这里顺带把它设为当前账号。
 * 同一个账号重复写入会**更新原记录**（按 serverId / token 去重，见 accounts.upsertAccount）。
 */
export function writeAuth(auth: WebAuth, provider: string = 'deepseek'): void {
  const record = upsertAccount(auth, {}, provider)
  setActiveAccount(record.id, provider)
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
export function withVerifiedIdentity(
  auth: WebAuth,
  user: { id?: string; display?: string } | undefined,
): WebAuth & { serverId?: string } {
  const display = typeof user?.display === 'string' && user.display ? user.display : undefined
  const serverId = typeof user?.id === 'string' && user.id ? user.id : undefined
  return {
    ...auth,
    unverified: undefined,
    ...(display || serverId ? { user: { ...auth.user, ...(display ? { display } : {}), ...(serverId ? { id: serverId } : {}) } } : {}),
    ...(serverId ? { serverId } : {}),
  }
}

/**
 * 已经在库里的记录：用**可信校验**的结果刷新它的元信息与身份键。
 *
 * 与 `withVerifiedIdentity` 的分工：那个用于「凭证还没落库/正在落库」，
 * 这个用于「记录已经在库里」（例如 `/status` 的迟到校验、探活）。
 * 两者都**不切换当前账号**、**不会新建记录** —— 审计 F05/N02 与 F04 是同一条纪律。
 *
 * 返回是否真的更新了（记录不存在、或 token 已变 → 什么都不做）。
 */
export function refreshVerifiedIdentity(
  id: string,
  token: string,
  user: { id?: string; display?: string } | undefined,
): boolean {
  const record = readAccount(id)
  if (!record || record.token !== token) return false
  const display = typeof user?.display === 'string' && user.display ? user.display : undefined
  const serverId = typeof user?.id === 'string' && user.id ? user.id : undefined
  updateAccount(id, {
    ...(display || serverId
      ? { user: { ...record.user, ...(display ? { display } : {}), ...(serverId ? { id: serverId } : {}) } }
      : {}),
    ...(serverId ? { serverId } : {}),
    unverified: undefined,
    lastVerifiedAt: new Date().toISOString(),
    lastVerifyError: undefined,
  })
  return true
}

/**
 * 退出登录：把当前账号从库里**移除**（并清掉当前指针）。
 *
 * 库里还有其它账号时**刻意不自动切换**：自动换号会让人以为"我只是登出了，
 * 怎么又用上另一个号了"。界面会提示"账号库里还有 N 个，点「切换」即可使用"，
 * 由人明确选择。
 */
export function clearAuth(provider: string = 'deepseek'): void {
  const active = activeAccount(provider)
  if (active) removeAccount(active.id, provider)
  clearActiveAccount(provider)
}

export function hasUsableAuth(auth: WebAuth | undefined): auth is WebAuth {
  return !!auth && typeof auth.token === 'string' && auth.token.length > 8
}

/**
 * 解包页面读回的 token（兼容裸字符串与 AppKit 包装 JSON）。
 *
 * ⚠️ 两个必须守住的边界（都是实测形态）：
 *  - 未登录时网页端返回的是 `{"value":null,"__version":"0"}` → 必须得到**空串**，
 *    绝不能把字符串 "null" 当 token（否则会拿垃圾 token 去请求，报 40003 让人一头雾水）。
 *  - 旧版本网页端存的是裸 token 字符串 → 原样返回。
 */
export function unwrapStoredToken(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed?.value === 'string' ? parsed.value.trim() : ''
    } catch {
      return ''
    }
  }
  // 兜底：字面量 "null"/"undefined" 一律视为空
  return text === 'null' || text === 'undefined' ? '' : text
}

/** 掩码账号标识（保留可辨识部分，足以确认「是哪个号」而不泄露全量）。 */
export function maskIdentifier(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  // 幂等：网页端返回的 `user.display` **本身就是屏蔽过的**（形如 `192******27`、
  // `lidi*********+mn1@gmail.com`），记录里存的就是它。若在这里再屏蔽一次，会把
  // 「能区分两个号」的那截尾巴抹掉 —— 实测两个 Gmail 账号都变成 `lid***@gmail.com`，
  // 看着像同一个号，恰好违背本函数「保留可辨识部分」的目的。真账号标识里不会有连续三星号。
  if (value.includes('***')) return value
  const at = value.indexOf('@')
  if (at > 0) {
    const local = value.slice(0, at)
    const keep = Math.min(3, Math.max(1, local.length - 1))
    return `${local.slice(0, keep)}***${value.slice(at)}`
  }
  if (/^\d{6,}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`
  if (value.length <= 4) return `${value[0]}***`
  return `${value.slice(0, 3)}***${value.slice(-2)}`
}

/**
 * 适配器边界错误。自带 `failure` 与 `code` 自有数据属性 ——
 * LlmRuntime.normalizeLlmFailure 通过自有属性（而非 instanceof）读取结构化
 * 失败信息，因此跨模块边界的自包含打包也能携带 code/status/retryAfter。
 */
export class AdapterLlmError extends Error {
  readonly failure: { message: string; code: string; status?: number; providerRetryAfterMs?: number }
  readonly code: string
  /**
   * 账号级限制的**解除时间**（毫秒时间戳），仅在 `user is muted` 时有值。
   *
   * 为什么要单独带一个字段：`providerRetryAfterMs` 是相对值（给重试策略用的），
   * 而"记下这个账号被限到什么时候"需要绝对值。让调用方去解析错误文案里的时间是不可靠的。
   */
  readonly mutedUntilMs?: number

  constructor(
    message: string,
    code: string,
    options: { status?: number; providerRetryAfterMs?: number; mutedUntilMs?: number; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    if (options.mutedUntilMs !== undefined) this.mutedUntilMs = options.mutedUntilMs
    this.failure = {
      message,
      code,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}),
    }
    // 原型链上设置 cause（Node 22 支持 options.cause，但为稳妥手动挂）
    if (options.cause !== undefined) (this as any).cause = options.cause
  }
}

/** 把 HTTP 状态映射为稳定错误码（对齐 dsh-llm 默认可重试码表：SERVER/RATE_LIMIT/TIMEOUT/TRANSPORT）。 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 402) return 'QUOTA'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER_ERROR'
}

/** 解析 Retry-After（秒数或 HTTP-date），返回毫秒。 */
export function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Math.max(1000, Number(text) * 1000)
  const parsed = Date.parse(text)
  if (!Number.isNaN(parsed)) return Math.max(1000, parsed - Date.now())
  return undefined
}

export function existsFile(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}
