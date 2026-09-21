/**
 * 上下文投喂方式 —— 每轮到底给网页端发什么。
 *
 * 两种模式（2026-09-14 加，用户可切换）：
 *
 *   full    每轮重发全量 prompt（默认）。
 *           webapi 每次 completion 都发 `parent_message_id: null`，每条消息都是会话里的
 *           根消息、没有父链 —— 服务端按消息树回溯上下文时回溯到空，**拿不到任何历史**。
 *           所以历史必须由我们自己每轮重发。DSH 的适配器契约本来就是无状态的
 *           （每轮把完整 messages 交给我们），这个模式最稳、行为和 0.1.61 及以前完全一致。
 *
 *   chained 链式投喂：只发**增量**，并把 `parent_message_id` 指向上一轮 assistant 的
 *           message_id，让服务端自己按链维护上下文。
 *           依据（读参考实现 + 抓真实帧，不是推理）：浏览器就是这么干的 ——
 *           参考实现里的 `nextParentMessageId = history?.parentMessageId ?? finalAssistantMessageId`
 *           `interceptor/request-augmentation.ts` 里 `isFirstMessage = parent_message_id === null`
 *           ⇒ 只有会话第一条的 parent 是 null，之后每轮都把上一条消息 id 当 parent 发上去。
 *           本轮 assistant 的 id 来自 SSE 首帧 `event: ready`
 *           （`{"request_message_id":1,"response_message_id":2,...}`，实测样本见
 *           `.workbuddy/tmp/shortq-r1-2026-09-14T04-17-41.sse`）。
 *
 * ⚠️ chained 的代价（必须知道，所以默认不开）：
 *   模型能看到的工具协议、系统提示、历史，全都在**链首那条消息**里；一旦服务端侧
 *   把早期上下文丢掉（长会话/超窗），模型就没有协议可依 —— 可能直接不按 JSON 发工具调用。
 *   本模块的对策是"能省则省、一有不确定就退回全量"：见 decideFeed 的判据。
 *
 * 本文件是**纯逻辑 + 一点设置读写**，不依赖 webapi，方便直接测（tests/check-context-feed.mjs）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

export type ContextMode = 'full' | 'chained'

/** 默认每轮重发全量 —— 与 0.1.61 及以前的行为一致，不改动既有用户。 */
export const DEFAULT_CONTEXT_MODE: ContextMode = 'full'

export function normalizeContextMode(value: unknown): ContextMode | undefined {
  return value === 'full' || value === 'chained' ? value : undefined
}

/** 设置页展示用（纯文本，别写 markdown 星号）。 */
export const CONTEXT_MODE_HINT =
  '链式投喂：之后每轮只发新增内容，并把上一条回答挂到父消息上，让服务端自己维护上下文 —— ' +
  '请求体小得多、也更像真人连续对话。代价是工具协议只存在于链首那条消息里，' +
  '一旦服务端把早期上下文丢掉，模型可能不按约定格式发工具调用；本插件遇到任何不确定会自动退回全量重发。' +
  '每轮全量：最稳，行为和以前完全一致（网页端会看到每条消息都带着完整提示词）。'

/** 链式投喂的链状态。只在「正在复用的那个会话」上有意义，会话轮换/失败即作废。 */
export interface ChainState {
  /** 链首发出去的固定头（系统 + 协议指令 + 工具目录）。头部变了就不能续链。 */
  head: string
  /** 已经发出去的历史条目（**完整**条目，不做过滤）——下一轮用它算增量。 */
  entries: readonly string[]
  /** 上一轮 assistant 的 message_id，作为下一轮的 `parent_message_id`。 */
  parentId: number
  /** 链所属的网页端会话。 */
  sessionId: string
  /** 链所属账号（凭证摘要）。切号后键不同，不能续链。 */
  accountKey: string
}

export type FeedReason =
  | 'chained' // 发了增量
  | 'mode-full' // 配置就是全量
  | 'no-parts' // 调用方没给结构化 prompt，算不出增量
  | 'no-chain' // 还没有链（本轮要当链首）
  | 'new-session' // 本轮是新会话（复用的旧链不适用）
  | 'session-changed'
  | 'account-changed'
  | 'head-changed' // 系统提示/工具目录变了 —— 链首那份已经过期
  | 'not-appended' // 历史不是严格追加（被压缩/改写/回退）
  | 'empty-delta' // 没有新增内容（例如同一步的重试）
  | 'delta-too-long' // 增量本身超出预算，不值得为它冒险

export interface FeedInput {
  mode: ContextMode
  /** 本轮结构化 prompt 的三段：head = 固定头，entries = 历史条目，full = 今天那份字符串。 */
  head?: string
  entries?: readonly string[]
  full: string
  /** 本轮用的网页端会话，以及它是不是复用来的。 */
  sessionId: string
  accountKey: string
  reused: boolean
  /** 当前链（没有则 undefined）。 */
  chain?: ChainState
  /** serializePrompt 用的预算，用来给增量设一个上限。 */
  maxChars?: number
}

export interface FeedDecision {
  /** 真正写进请求体的 prompt。 */
  prompt: string
  /** 真正写进请求体的 `parent_message_id`。 */
  parentMessageId: number | null
  /**
   * 本轮结束后（流正常跑完且拿到了 assistant message_id）应该建立/沿用的链。
   * `undefined` = 不建链（全量模式）。
   */
  next: Omit<ChainState, 'parentId'> | undefined
  /** 为什么这么决定 —— 只用于日志，排障时能一眼看出为什么没走上链式。 */
  reason: FeedReason
}

/** 严格前缀：prev 是 next 的前缀（含相等时不算"追加"）。 */
function isStrictPrefix(prev: readonly string[], next: readonly string[]): boolean {
  if (next.length <= prev.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i] !== next[i]) return false
  }
  return true
}

/**
 * 决定本轮发什么。**纯函数**：不读文件、不看时间、不改全局状态。
 *
 * 判据宁可保守：只要能续链就发增量，任何一处不确定都退回"全量 + parent=null"
 * （退回去只是多花点 token，和以前行为一致；错续链则会让模型上下文错位，代价大得多）。
 */
export function decideFeed(input: FeedInput): FeedDecision {
  const full = input.full
  if (input.mode !== 'chained') return { prompt: full, parentMessageId: null, next: undefined, reason: 'mode-full' }

  const head = input.head
  const entries = input.entries
  if (typeof head !== 'string' || !Array.isArray(entries)) {
    return { prompt: full, parentMessageId: null, next: undefined, reason: 'no-parts' }
  }

  const restart = (reason: FeedReason): FeedDecision => ({
    prompt: full,
    parentMessageId: null,
    next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
    reason,
  })

  if (!input.reused) return restart('new-session')
  const chain = input.chain
  if (!chain) return restart('no-chain')
  if (chain.sessionId !== input.sessionId) return restart('session-changed')
  if (chain.accountKey !== input.accountKey) return restart('account-changed')
  if (chain.head !== head) return restart('head-changed')
  if (!isStrictPrefix(chain.entries, entries)) return restart('not-appended')

  const delta = entries.slice(chain.entries.length).join('\n\n')
  if (delta.trim().length === 0) return restart('empty-delta')
  const cap = input.maxChars
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && delta.length > cap) {
    return restart('delta-too-long')
  }
  return {
    prompt: delta,
    parentMessageId: chain.parentId,
    next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
    reason: 'chained',
  }
}

// ── 设置：当前模式 + 落盘（照 transport.ts 那套）────────────────────────────

let currentMode: ContextMode = DEFAULT_CONTEXT_MODE

/** 取当前生效的模式（即时生效，无需重启）。 */
export function currentContextMode(): ContextMode {
  return currentMode
}

/** 设置当前模式（设置页保存时立刻生效，无需重启）。 */
export function applyContextMode(mode: ContextMode): ContextMode {
  currentMode = mode
  return currentMode
}

/** 只给测试用：还原默认。 */
export function resetContextMode(): void {
  currentMode = DEFAULT_CONTEXT_MODE
}

export function contextModeSettingsPath(): string {
  return join(webLoginDir(), 'context-feed.json')
}

export function readContextModeSetting(): ContextMode | undefined {
  try {
    const file = contextModeSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return normalizeContextMode(parsed?.contextMode)
  } catch {
    return undefined
  }
}

export function writeContextModeSetting(mode: ContextMode): void {
  const file = contextModeSettingsPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ contextMode: mode }, null, 2) + '\n', 'utf8')
}
