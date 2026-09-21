/**
 * 「欠删除的会话」日志 —— 让插件在**进程退出之后**仍能认出并回收网页端会话。
 *
 * ## 背景（2026-09-14 排查，有实测数据）
 *
 * 复用槽（`webapi.ts` 的 `reuseSlot`）与「待删队列」都只活在进程内存里。宿主一退出
 * —— 尤其是被强杀 —— 两者静默消失，于是**正在复用的那个会话永远不会被删**，
 * 网页端侧栏就堆出一批标题 = DSH 会话主题的对话。
 *
 * 实测：09-12 起累计启动 DSH 58 次（40/33/20/5），残留会话量级与启动次数相符；
 * 且残留标题与 `~/.dsh/sessions/<id>/` 里的 `session/title` 记录**一一对应**，
 * 证明这些会话确实是本插件建的（不是用户自己的聊天）。
 *
 * ## 做法
 *
 * 把「**还欠一次删除**」的会话按账号落盘：进入复用槽时记一条、进入待删队列时记一条，
 * **确认删掉之后才移除**。于是文件始终等于"服务端可能还留着、我们打算删"的集合：
 *
 *   - 正常退出：teardown 退役槽 + flush，删成功的会各自把记录摘掉；文件自然变空；
 *   - 被强杀：记录原样留着 → **下次启动扫尾**，按账号排进清理器补删；
 *   - 删失败：记录留着，下次启动再试（不会"记录没了、会话还在"）。
 *
 * 为什么记账号：网页端删除必须用**会话所属账号**的凭证 —— 拿 A 的凭证去删 B 的会话，
 * 轻则被服务端拒绝，重则 resp.ok 时被当成全部成功（见 CHANGELOG 的 F07）。
 *
 * 为什么不会越攒越多：一次模型调用最多让池子里多一个会话（20 轮复用），
 * 而这里只记"还没删掉的"，稳态就是 0~1 条。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { webLoginDir } from './paths.ts'

/** 文件格式版本。以后改结构时用它决定要不要兼容读。 */
export const JOURNAL_VERSION = 1

/** 一条「还欠一次删除」的网页端会话。 */
export interface JournalEntry {
  /** 会话所属账号 —— 删除时必须用它的凭证。 */
  accountId: string
  sessionId: string
  /** 记录时的进程号：用来判断"写这条的进程是不是还活着"。 */
  pid: number
  /** 记录时间（毫秒），仅用于诊断输出。 */
  at: number
  /** `slot` = 正在复用（还没排队）；`queued` = 已排进待删队列。纯诊断用。 */
  state: 'slot' | 'queued'
}

/** `~/.dsh/web-login/sessions-in-use.json`（与 gate.json / 账号库同目录）。 */
export function sessionJournalPath(): string {
  return join(webLoginDir(), 'sessions-in-use.json')
}

function sanitizeEntry(raw: any): JournalEntry | undefined {
  const accountId = typeof raw?.accountId === 'string' ? raw.accountId.trim() : ''
  const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim() : ''
  if (!accountId || !sessionId) return undefined
  return {
    accountId,
    sessionId,
    pid: Number.isFinite(raw?.pid) ? Math.floor(raw.pid) : 0,
    at: Number.isFinite(raw?.at) ? Math.floor(raw.at) : 0,
    state: raw?.state === 'queued' ? 'queued' : 'slot',
  }
}

/**
 * 读日志。文件不存在 / 损坏 / 结构不对一律当作**空**（绝不因此让插件启动失败）；
 * 单条坏记录被丢掉，其余照常可用。
 */
export function readJournal(file: string = sessionJournalPath()): JournalEntry[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const raw = Array.isArray(parsed) ? parsed : parsed?.entries
    if (!Array.isArray(raw)) return []
    const out: JournalEntry[] = []
    for (const item of raw) {
      const entry = sanitizeEntry(item)
      if (entry) out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

/** 原子写：先写同目录临时文件再 rename，避免中途被杀留下半截 JSON。 */
export function writeJournal(entries: readonly JournalEntry[], file: string = sessionJournalPath()): void {
  const dir = dirname(file)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {}
  const payload = `${JSON.stringify({ version: JOURNAL_VERSION, entries }, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, file)
    } catch {
      // rename 失败：退一步直接写目标文件
      writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 })
      try {
        unlinkSync(tmp)
      } catch {}
    }
  } catch {
    /* 写不进去不影响主流程 */
  }
}

/** 记一条（同一 sessionId 覆盖）。 */
export function upsertJournalEntry(
  entry: Omit<JournalEntry, 'pid' | 'at' | 'state'> & Partial<Pick<JournalEntry, 'pid' | 'at' | 'state'>>,
  file: string = sessionJournalPath(),
): void {
  const next: JournalEntry = {
    accountId: entry.accountId,
    sessionId: entry.sessionId,
    pid: entry.pid ?? process.pid,
    at: entry.at ?? Date.now(),
    state: entry.state ?? 'slot',
  }
  const entries = readJournal(file).filter((item) => item.sessionId !== next.sessionId)
  entries.push(next)
  writeJournal(entries, file)
}

/** 确认删掉 → 摘掉这条。 */
export function removeJournalEntry(sessionId: string, file: string = sessionJournalPath()): void {
  const entries = readJournal(file)
  const kept = entries.filter((item) => item.sessionId !== sessionId)
  if (kept.length === entries.length) return // 没有这条就别白写一次盘
  writeJournal(kept, file)
}

/** 进程是否还活着（判断"写记录的那个进程走了没有"）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    // EPERM = 进程存在但没权限发信号 ⇒ 仍然算活着
    return error?.code === 'EPERM'
  }
}

export interface SweepOptions {
  /** 当前进程号（自己写的记录当然不动）。 */
  ownPid: number
  /** 进程存活判断，默认 `isProcessAlive`。 */
  isAlive?: (pid: number) => boolean
  /** 这个账号还在不在账号库里（不在就没凭证可删）。 */
  accountExists: (accountId: string) => boolean
  /** 用户是否允许删网页端会话（`deleteWebSessions !== false`）。 */
  deleteEnabled: boolean
  /** 清理模式；`keep` = 用户明确要求不删。 */
  mode: 'immediate' | 'deferred' | 'keep'
}

export interface SweepPlan {
  /** 该补删的（进程已不在 + 账号还在 + 用户允许删）。 */
  toDelete: JournalEntry[]
  /** 删不掉的（账号已从账号库移除）——只能放弃，否则会永远躺在文件里。 */
  dropped: JournalEntry[]
  /** 保留的（进程还活着，或用户不允许删）。 */
  kept: JournalEntry[]
}

/**
 * 纯决策：每一条记录该怎么办。**不碰磁盘、不发请求**，可离线测。
 *
 * 判定顺序有意如此：
 *   ① 进程还活着 → 保留（多实例共用同一个 DSH_HOME 时，别删另一个实例正在用的会话）；
 *   ② 用户不允许删（`keep` / `deleteWebSessions: false`）→ 保留，等以后允许了再扫；
 *   ③ 账号已被移除 → 放弃（没凭证，留着也删不掉）；
 *   ④ 其余 → 补删。
 */
export function planStartupSweep(entries: readonly JournalEntry[], options: SweepOptions): SweepPlan {
  const isAlive = options.isAlive ?? isProcessAlive
  const plan: SweepPlan = { toDelete: [], dropped: [], kept: [] }
  for (const entry of entries) {
    if (entry.pid === options.ownPid || isAlive(entry.pid)) {
      plan.kept.push(entry)
      continue
    }
    if (!options.deleteEnabled || options.mode === 'keep') {
      plan.kept.push(entry)
      continue
    }
    if (!options.accountExists(entry.accountId)) {
      plan.dropped.push(entry)
      continue
    }
    plan.toDelete.push(entry)
  }
  return plan
}

export interface SweepResult {
  scheduled: number
  dropped: number
  kept: number
}

/**
 * 启动扫尾：读日志 → 决策 → 对每条该补删的调用 `onSweep`（由调用方排进清理器，
 * 那里才有账号凭证与节流）。
 *
 * **不在这里清记录**：记录要留到"确认删掉"（`removeJournalEntry` 由删除回执触发）。
 * 这样即使本次删除失败、或者进程又在中途被杀，下次启动还能再补。
 * 唯一会立刻移除的是 `dropped`（账号没了，永远删不掉）。
 */
export function runStartupSweep(
  options: SweepOptions & {
    onSweep: (entry: JournalEntry) => void
    file?: string
    log?: (message: string) => void
  },
): SweepResult {
  const file = options.file ?? sessionJournalPath()
  const entries = readJournal(file)
  if (entries.length === 0) return { scheduled: 0, dropped: 0, kept: 0 }

  const plan = planStartupSweep(entries, options)
  let scheduled = 0
  for (const entry of plan.toDelete) {
    try {
      options.onSweep(entry)
      scheduled += 1
    } catch {
      plan.kept.push(entry) // 排不进去 → 留到下次启动再试
    }
  }
  if (plan.dropped.length > 0) writeJournal(plan.kept, file)

  if (scheduled > 0) {
    options.log?.(`deepseek-web: 上次退出遗留了 ${scheduled} 个临时会话，已交给清理器补删`)
  }
  if (plan.dropped.length > 0) {
    options.log?.(
      `deepseek-web: ${plan.dropped.length} 个遗留会话的账号已不在账号库里，无法回收（已从记录移除）`,
    )
  }
  return { scheduled, dropped: plan.dropped.length, kept: plan.kept.length }
}
