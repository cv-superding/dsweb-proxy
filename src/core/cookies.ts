/**
 * cookie 过期信息的采集与解读。
 *
 * ## 为什么值得做
 *
 * 插件存下来的凭证里只有 `name=value` 串，**过期时间一直被丢掉** —— 于是"登录态会不会
 * 因为长期不用而失效"这件事在界面上完全没有可观察的线索。
 *
 * 实测（2026-09-12，只读、零额度）：DeepSeek 的只读端点**不返回 set-cookie**，
 * token 也不轮换，所以**没有任何"续期"手段可做**；能做的只有**把过期时间采下来**，
 * 让"不确定"缩小一格 —— 至少能回答"这些 cookie 里哪些本来就是会话级"。
 *
 * 顺带一个实测结论（决定"看什么"）：真正鉴权用的是 **`token`**，不是 cookie ——
 * 只发 token 不带 cookie 能通过，只发 cookie 不带 token 直接被拒（40002 Missing Token）。
 * 所以 cookie 的过期时间**不是**登录态寿命的上界；它只告诉我们浏览器侧会先丢哪些。
 *
 * ## 两种来源形状不同，都要认
 *
 * | 来源 | 字段 | 会话级的表示 |
 * | --- | --- | --- |
 * | CDP `Storage.getCookies`（真实 Edge/Chrome） | `expires` | `-1` |
 * | Electron `session.cookies.get()`（插件自开窗口） | `expirationDate` | 字段缺失 |
 *
 * 两者都以 **秒** 为单位（Unix epoch），本模块统一换算成**毫秒**。
 */

export interface CookieMeta {
  /** cookie 名。 */
  name: string
  /** 所属域（原样保留，便于排查域匹配问题）。 */
  domain: string
  /** 会话级：浏览器关闭即失效（服务端会话另有寿命，不受它约束）。 */
  session: boolean
  /** 持久级 cookie 的到期时间（**毫秒** epoch）；会话级或未知 → 不出现该字段。 */
  expiresAt?: number
}

/**
 * 归一化一个 cookie 的过期形态。两种来源的字段名不同，这里统一。
 *
 * 判定顺序：显式 `session === true` 优先；否则看 `expires` / `expirationDate`。
 * 缺失、非数、`<= 0` **一律当会话级** —— CDP 对会话级给的就是 `-1`，
 * 而"0"在 Unix epoch 里也毫无意义，当成有效时间会算出 1970 年。
 */
export function readCookieExpiry(raw: any): { session: boolean; expiresAt?: number } {
  if (!raw || typeof raw !== 'object') return { session: true }
  if (raw.session === true) return { session: true }
  const seconds = Number(raw.expires ?? raw.expirationDate)
  if (!Number.isFinite(seconds) || seconds <= 0) return { session: true }
  return { session: false, expiresAt: Math.round(seconds * 1000) }
}

/**
 * 从任意来源的 cookie 数组里挑出目标域的，转成 `CookieMeta`。
 *
 * ⚠️ `filter` 由调用方给出、且**必须与该处拼 cookie 头的过滤条件逐字一致**：
 * 这些元信息要描述的正是"请求里实际带上的那批 cookie"。两条捕获路径原本的过滤条件
 * 不同（真实浏览器那条用 `deepseek`，Electron 那条用 `deepseek.com`），
 * 这里刻意不强行统一 —— 统一就等于改了请求头内容，而那个改动是没法靠单测兜住的。
 */
export function pickCookieMeta(
  cookies: readonly any[],
  filter: (domain: unknown) => boolean,
): CookieMeta[] {
  const out: CookieMeta[] = []
  for (const raw of cookies ?? []) {
    const name = typeof raw?.name === 'string' ? raw.name : ''
    if (!name) continue
    const domain = String(raw?.domain ?? '')
    if (!filter(domain)) continue
    const { session, expiresAt } = readCookieExpiry(raw)
    out.push({ name, domain, session, ...(expiresAt !== undefined ? { expiresAt } : {}) })
  }
  return out
}

/**
 * 规整"已经归一化过"的 `CookieMeta` 数组（从磁盘读账号记录时用）。
 * 形状不对的条目直接丢掉，不抛错 —— 一份坏记录不该让整个账号库读不出来。
 */
export function normalizeCookieMetaList(raw: unknown): CookieMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CookieMeta[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const name = typeof (item as any).name === 'string' ? (item as any).name : ''
    if (!name) continue
    const expiresRaw = Number((item as any).expiresAt)
    const hasExpiry = Number.isFinite(expiresRaw) && expiresRaw > 0
    const session = (item as any).session === true || !hasExpiry
    out.push({
      name,
      domain: typeof (item as any).domain === 'string' ? (item as any).domain : '',
      session,
      ...(session ? {} : { expiresAt: Math.round(expiresRaw) }),
    })
  }
  return out.length > 0 ? out : undefined
}

export interface CookieLifeSummary {
  total: number
  sessionCount: number
  persistentCount: number
  /** 持久级里**最晚**到期的那个 —— 用来回答"浏览器侧还能撑多久"。 */
  latest?: { name: string; expiresAt: number; daysLeft: number }
}

/**
 * 汇总结论。**没有记录时返回 `undefined`**（而不是全 0 的对象）——
 * 调用方要区分"没采到过期信息"（老记录 / 手动粘 token）和"采到了、全是会话级"，
 * 这两种情况的界面文案完全不同。
 */
export function summarizeCookieLife(
  metas: readonly CookieMeta[] | undefined,
  now: number = Date.now(),
): CookieLifeSummary | undefined {
  const list = metas ?? []
  if (list.length === 0) return undefined
  const persistent = list.filter((item) => !item.session && Number.isFinite(item.expiresAt))
  let latest: CookieLifeSummary['latest']
  for (const item of persistent) {
    const expiresAt = item.expiresAt as number
    if (!latest || expiresAt > latest.expiresAt) {
      latest = { name: item.name, expiresAt, daysLeft: (expiresAt - now) / 86_400_000 }
    }
  }
  return {
    total: list.length,
    sessionCount: list.length - persistent.length,
    persistentCount: persistent.length,
    ...(latest ? { latest } : {}),
  }
}

/** 剩余时间的口语化写法。 */
export function describeRemaining(daysLeft: number): string {
  if (daysLeft <= 0) return '已过期'
  if (daysLeft >= 1) return `还剩 ${Math.floor(daysLeft)} 天`
  const hours = Math.max(1, Math.round(daysLeft * 24))
  return `还剩 ${hours} 小时`
}

/**
 * 一句话说清 cookie 的寿命构成（界面直接展示）。
 *
 * 三种情况分开写，因为它们的含义完全不同：
 *  - 没记录 → 老记录 / 手动粘 token，下次重新登录会补上；
 *  - 全是会话级 → 浏览器侧本来就没有到期时间，看它撑多久没意义；
 *  - 有持久级 → 给出最晚那个的剩余时间（**只是浏览器侧的上界，不是登录态寿命**）。
 */
export function describeCookieLife(
  summary: CookieLifeSummary | undefined,
  now: number = Date.now(),
): string {
  if (!summary) return '⚠️ 未记录（重新登录后会补上）'
  const parts = [`${summary.total} 项`]
  parts.push(summary.sessionCount > 0 ? `${summary.sessionCount} 会话级` : '无会话级')
  if (summary.persistentCount > 0) parts.push(`${summary.persistentCount} 持久级`)
  if (summary.latest) {
    // 注意：`summary.latest.daysLeft` 是按生成这份 summary 的时刻算的。
    // 调用方若隔了很久才展示，传 `now` 进来重算即可。
    const daysLeft = (summary.latest.expiresAt - now) / 86_400_000
    parts.push(`${summary.latest.name} ${describeRemaining(daysLeft)}`)
  }
  return parts.join(' · ')
}
