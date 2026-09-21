/**
 * 账号轮转器 —— 遇限流 / 封号 / 凭证失效时自动切到下一个可用账号。
 *
 * 策略（与 DSH 插件的保守哲学一致）：
 *  - 轮转只发生在「当前账号明确不可用」时：账号级限制（user is muted，带解除时间）、
 *    登录态失效（40003/AUTH）。**普通频控（RATE_LIMIT/throttled）不切号** ——
 *    换号继续轰对服务端是更强的多开特征，退避重试才是正解。
 *  - 候选顺序：库里其它账号按「未受限优先 + 上次使用最早」排序（LRU）。
 *  - 全部不可用时不动指针：下一次请求仍走当前账号并报真实错误
 *    （让调用方看到"全部被限"而不是轮转到第一个账号假装正常）。
 *  - 开关：proxy.json 的 `rotation: true|false`（默认 true）。
 */
import { listAccounts, setActiveAccount, activeAccountId, updateAccount } from './core/accounts.ts'
import type { AccountRecord } from './core/accounts.ts'
import type { AdapterLlmError } from './core/auth.ts'

/** 判断错误是否属于「这个账号已不可用，应该换号」。 */
export function isAccountDeadError(error: unknown): { dead: boolean; mutedUntilMs?: number } {
  const code = String((error as any)?.code ?? '')
  const message = String((error as any)?.message ?? '')
  const mutedUntilMs = (error as any)?.mutedUntilMs

  // 账号级限制（封号/禁言）：错误里带解除时间
  if (Number.isFinite(mutedUntilMs) || code === 'ACCOUNT_MUTED') {
    return { dead: true, ...(Number.isFinite(mutedUntilMs) ? { mutedUntilMs: Number(mutedUntilMs) } : {}) }
  }
  // 登录态失效：换号有意义（当前凭证坏了）
  if (code === 'AUTH' || /40003|Authorization Failed|MISSING_CREDENTIAL/i.test(`${code} ${message}`)) {
    return { dead: true }
  }
  return { dead: false }
}

/** 把受限信息落到账号记录上（界面据此显示倒计时）。 */
export function markAccountLimited(accountId: string, mutedUntilMs: number, provider: string = 'deepseek'): void {
  try {
    updateAccount(accountId, {
      limit: { untilMs: mutedUntilMs, observedAt: new Date().toISOString() },
    } as any, provider)
  } catch {}
}

/** 清除账号的受限标记（解除时间已过时调用）。 */
export function clearAccountLimit(accountId: string, provider: string = 'deepseek'): void {
  try {
    updateAccount(accountId, { limit: undefined } as any, provider)
  } catch {}
}

export interface RotationResult {
  /** 是否切换了账号。 */
  switched: boolean
  /** 切换后的账号（switched=true 时有值）。 */
  to?: { id: string; display: string }
  /** 没切的原因（switched=false 时有值）。 */
  reason?: 'disabled' | 'no-dead-error' | 'no-available-account'
}

/**
 * 尝试轮转：从库里找一个「现在可用」的其它账号切过去。
 * 每次调用前先清除所有已过期的 limit 标记。
 */
export function rotateToNextAccount(provider: string = 'deepseek'): RotationResult {
  const now = Date.now()
  const accounts = listAccounts(provider) as AccountRecord[]
  // 先把过期限制清掉（库层面自愈）
  for (const account of accounts) {
    if (account.limit && account.limit.untilMs <= now) clearAccountLimit(account.id, provider)
  }
  const currentId = activeAccountId(provider)
  const candidates = (listAccounts(provider) as AccountRecord[]).filter(
    (account) => account.id !== currentId && !(account.limit && account.limit.untilMs > Date.now()),
  )
  if (candidates.length === 0) return { switched: false, reason: 'no-available-account' }
  // LRU：capturedAt 最早的先用（最久没用过的号风控画像最干净）
  candidates.sort((a, b) => String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? '')))
  const next = candidates[0]
  setActiveAccount(next.id, provider)
  return {
    switched: true,
    to: {
      id: next.id,
      display: next.user?.display ?? next.label ?? next.id,
    },
  }
}

/**
 * 请求失败后由 provider 调用的统一入口：
 * 判死 → 落库限制 → （开关开着时）轮转。
 */
export function handleAccountFailure(error: AdapterLlmError, options: { rotation: boolean; provider?: string }): RotationResult {
  const provider = options.provider ?? 'deepseek'
  const verdict = isAccountDeadError(error)
  if (!verdict.dead) return { switched: false, reason: 'no-dead-error' }
  const currentId = activeAccountId()
  if (currentId && verdict.mutedUntilMs) markAccountLimited(currentId, verdict.mutedUntilMs, provider)
  if (!options.rotation) return { switched: false, reason: 'disabled' }
  return rotateToNextAccount(provider)
}
