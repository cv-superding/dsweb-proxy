/**
 * 账号上下文 —— provider 与账号库之间的薄封装。
 * readAuth/writeAuth/clearAuth 的别名层：让 provider 只依赖这一个小接口，
 * 将来加「多 provider 各自独立账号库」时只改这里。
 */
import type { WebAuth } from '../core/auth.ts'
import { readAuth, writeAuth, clearAuth, withVerifiedIdentity } from '../core/auth.ts'

/** 当前生效的登录凭证（没有 → undefined）。 */
export function readActiveAuth(provider: string = 'deepseek'): WebAuth | undefined {
  return readAuth(provider)
}

/** 捕获/校验成功后落库并切为当前账号。 */
export function commitCapturedAuth(
  auth: WebAuth & { serverId?: string; user?: { id?: string; display?: string } },
  provider: string = 'deepseek',
): WebAuth {
  const normalized = withVerifiedIdentity(auth, auth.user)
  writeAuth(normalized, provider)
  return normalized
}

/** 清除当前账号凭证（不动浏览器分区的登录态 —— 那是 login 命令的事）。 */
export function clearActiveAuth(provider: string = 'deepseek'): void {
  clearAuth(provider)
}
