/**
 * 「登录新账号（添加）」的**添加模式** + 「重新登录某个账号」的**原地更新意图**。
 *
 * ── 为什么需要"添加模式" ──
 * 所有捕获路径最后都会走 `writeAuth()`，而它的语义是"写入并**设为当前**"。但"往账号库里
 * 再加一个账号"的语义是**入库、但不打扰当前正在用的那个号** —— 这两件事必须分开，
 * 否则用户每加一个账号，正在用的号就被顶掉了（添加完还得手动切回来）。
 *
 * 所以：点「登录新账号」→ `beginAddAccount()` → 下一次捕获走 `commitCapturedAuth()`，
 * 它只 `upsertAccount()`（入库），不 `setActiveAccount()`（不切换）。
 *
 * 两个安全约束：
 *  1. **一次有效**：无论成功失败，`commitCapturedAuth()` 都会消费掉这个标志，
 *     绝不让它泄漏到后面某个无关的捕获上去。
 *  2. **有期限**：登录窗口可能被用户丢在那儿不管，所以超过 TTL 自动失效
 *     （否则十分钟后你随手粘个 token，会莫名其妙变成"只入库不切换"）。
 *
 * ── 为什么又加了"重新登录意图"（2026-09-15，用户实测反馈）──
 * 用户点「重新登录这个账号」后重新登录成功，结果**库里多出一条同名账号**，旧那条还挂着
 * 「需要重新登录」。根因有两层：
 *   ① 旧实现里 `/login/relogin` **完全没用到传进来的 id**，只调了 `beginAddAccount()`
 *      —— 那只是"别切换当前账号"，并不保证更新**同一条记录**；
 *   ② 捕获时只有 token/cookie、**没有身份信息**，`upsertAccount` 的 serverId 去重无从下手，
 *      而重新登录必然换新 token（旧的 token 匹配不上）⇒ 只能新增一条；
 *      身份是**捕获之后**校验才拿到的，那时已经晚了一步。
 * 所以现在：明确记住"这次捕获要原地更新哪条记录"，并按 id 落库（`patch.id` 优先于一切去重），
 * 顺带清掉旧的失败标记 —— 否则那条记录会一直显示「需要重新登录」（"重登了还报错"就是这么来的）。
 *
 * ⚠️ 注意：`/status` 里那次"补全账号展示信息"的写回**不走这里**（见 index.ts 的注释）——
 * 那是对**当前账号**的元数据刷新，不是新捕获，让它消费掉这些意图会是个 bug。
 */
import { activeAccountId, listAccounts, readAccount, setActiveAccount, updateAccount, upsertAccount } from './accounts.ts'
import type { AccountRecord } from './accounts.ts'
import { writeAuth, type WebAuth } from './auth.ts'

/** 添加模式的有效期：够用户走完一次登录窗口，又不至于久到误伤后续操作。 */
export const ADD_MODE_TTL_MS = 15 * 60_000

let startedAt: number | null = null

/** 进入添加模式（点「登录新账号」时调用）。 */
export function beginAddAccount(now: number = Date.now()): void {
  startedAt = now
}

/** 当前是否处于添加模式（超时即失效并自行清除）。 */
export function addModeActive(now: number = Date.now()): boolean {
  if (startedAt === null) return false
  if (now - startedAt > ADD_MODE_TTL_MS) {
    startedAt = null
    return false
  }
  return true
}

/** 退出添加模式（捕获完成 / 用户又点了退出或切换 —— 那些是明确的"改当前账号"动作）。 */
export function endAddAccount(): void {
  startedAt = null
}

// ── 「重新登录某个账号」的原地更新意图 ──────────────────────────────────────

/**
 * 重新登录意图的有效期。比添加模式长得多：用户可能开着登录窗口去吃个饭再回来
 * （用户实测就是拖了 34 分钟 —— 按 15 分钟算的话意图早就失效了，
 * 于是捕获走了"写入并设为当前"，既多出一条记录又顶掉了当前账号）。
 */
export const RELOGIN_TTL_MS = 60 * 60_000

let reloginTarget: { id: string; at: number } | null = null

/** 进入"重新登录"意图（点某个账号那行的「重新登录」时调用）。 */
export function beginRelogin(id: string, now: number = Date.now()): void {
  reloginTarget = { id, at: now }
}

/** 退出意图（捕获完成时消费；用户又去点别的动作时也可以显式清掉）。 */
export function endRelogin(): void {
  reloginTarget = null
}

/** 取当前待生效的重新登录目标（超时即失效并自行清除）。 */
export function pendingReloginTarget(now: number = Date.now()): string | undefined {
  if (!reloginTarget) return undefined
  if (now - reloginTarget.at > RELOGIN_TTL_MS) {
    reloginTarget = null
    return undefined
  }
  return reloginTarget.id
}

/** 只给测试用：清空两个意图。 */
export function resetAccountIntents(): void {
  startedAt = null
  reloginTarget = null
}

/**
 * 这次捕获的凭证是不是"就是那条记录对应的账号"。
 *
 * 捕获本身只拿到 token/cookie，**没有身份**；认不出身份时按"就是它"处理 ——
 * 因为意图是用户刚刚在本机点出来的（且只有 TTL 内有效），
 * 而"认得出、但明显是另一个号"时才必须放行成新增，免得把别人的记录覆盖掉。
 */
function sameAccount(existing: AccountRecord, auth: WebAuth): boolean {
  const incoming = auth as Partial<AccountRecord>
  const incomingId = incoming.serverId ?? incoming.user?.id
  const knownId = existing.serverId ?? existing.user?.id
  if (!incomingId || !knownId) return true
  return incomingId === knownId
}

export interface CommitResult {
  /**
   * `add` = 只入库不切换；`relogin` = **原地更新指定那条记录**（也不切换）；
   * `switch` = 写入并设为当前（默认语义）。
   */
  mode: 'add' | 'switch' | 'relogin'
  /** 仅 add 模式：这次捕获的账号是不是**新**的（false = 库里本来就有）。 */
  created?: boolean
  /**
   * 这次凭证落到了哪条记录上。调用方拿到它就能把"校验回来的身份信息"补写回去 ——
   * 否则新加的账号在列表里只能显示内部 id（`acc_xxxxxxxx`），要等下一次探活才有名字。
   */
  recordId?: string
}

/**
 * 捕获到凭证后的统一落库动作。
 *
 * 默认（非添加模式）：`writeAuth()` —— 写入并设为当前，行为与以前完全一致。
 * 添加模式：`upsertAccount()` —— 只入库；当前账号**原样不动**。
 */
export function commitCapturedAuth(auth: WebAuth, now: number = Date.now()): CommitResult {
  // ① 重新登录意图优先：把新凭证写回**那一条**记录（按 id 落库，不走 serverId/token 去重 ——
  //    重登必然换 token，靠 token 匹配只会新增一条）。不切换当前账号。
  const target = pendingReloginTarget(now)
  if (target) {
    try {
      const existing = readAccount(target)
      if (existing && sameAccount(existing, auth)) {
        const record = upsertAccount(auth, { id: target })
        // ⚠️ 必须显式清掉旧的失败标记：旧凭证的失败结论对新凭证不成立，
        //    留着它那条记录会一直显示「需要重新登录」（用户实测："重登了怎么还报错"）。
        //    这里用 updateAccount 而不是 upsertAccount —— 后者的 carried 逻辑用 `??`，传 undefined 清不掉。
        //    真有问题的话，30 分钟内的探活会重新把它标红。
        updateAccount(target, { lastVerifyError: undefined })
        return { mode: 'relogin', created: false, recordId: record.id }
      }
      // 认得出"这是另一个号"（或那条记录已被移除）→ 放行成普通捕获，别覆盖别人的记录
    } finally {
      endRelogin()
    }
  }
  if (!addModeActive(now)) {
    writeAuth(auth)
    const active = activeAccountId()
    return { mode: 'switch', ...(active ? { recordId: active } : {}) }
  }
  const before = new Set(listAccounts().map((item) => item.id))
  const hadActive = activeAccountId() !== undefined
  // F08：添加模式必须**总是**被消费掉。旧写法把 endAddAccount() 放在 upsertAccount 之后，
  // 一旦落库/切号抛错，模式就一直挂着 —— 于是下一次提交（哪怕是登录另一个号）
  // 会被当成"添加"处理，与模块注释承诺的"只消费一次"相反。
  try {
    const record = upsertAccount(auth)
    // 边界：库里本来一个当前账号都没有（比如刚才退出过又直接点「登录新账号」）——
    // 这时没人会被"打扰"，不设当前反而会留下"库里有账号却没选中"的状态。
    // 这不违反"添加不自动切换"：那条规则针对的是**别顶掉正在用的号**。
    if (!hadActive) setActiveAccount(record.id)
    return { mode: 'add', created: !before.has(record.id), recordId: record.id }
  } finally {
    endAddAccount()
  }
}
