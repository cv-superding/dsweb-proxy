/**
 * 请求闸门（request gate）—— 限制「同一账号上同时在飞的网页端请求」。
 *
 * 为什么需要它（2026-09-12 实测）：
 *  从插件日志反推每次调用的起止时间，272 轮里发现 **16 对时间重叠**，
 *  特征非常清楚：一方是主回答（数百字、6~40 秒），另一方**只有 8~17 个字、耗时 1~3 秒**
 *  —— 那是 DSH 的**会话标题生成**（`options.purpose === 'session-title'`）。
 *  也就是说，你还在等回答的时候，DSH 已经又往同一个账号发了一个短请求。
 *
 *  网页端同一账号**同时只能生成一条**，并发生成会被拒（`A message is being generated…`），
 *  更严重的是实测：双窗口并发生成不到 6 分钟就触发账号级限制（mute 1 天）。
 *  所以「并发」不是能白拿的吞吐，而是要主动规避的风险源。
 *
 * 两道约束：
 *  1. `allowConcurrent === false`（默认）：**串行**，同一时刻只放行一个调用，其余排队（FIFO）。
 *  2. `minIntervalMs`：两次调用**之间**至少间隔这么久（按上一次「结束」时间算），
 *     把请求密度压下来 —— 这是防风控真正起作用的那一项。
 */

import { webLoginDir } from './paths.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 推荐的调用间隔：**随机区间 2~4 秒**（下限 / 上限）。
 *
 * 为什么是区间而不是固定值：固定间隔的方差≈0，在统计上就是「定时器特征」；
 * 人的操作间隔是有方差的。同类项目 cuckoo-code（从未被风控）用的正是 2000~4000ms 随机区间。
 */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 2_000
export const DEFAULT_MAX_REQUEST_INTERVAL_MS = 4_000

/**
 * 长任务保护：连续跑这么多次之后，强制长休一次。0 = 关闭。
 *
 * 为什么需要它：间隔只管"两次之间空多久"，管不了"一刻不停跑了多久"。
 * 实测 2026-09-12 一个 SSH 插件开发任务，12 分钟里发了约 70 次请求（大量是只调工具、
 * 不说话的轮次），间隔设到 2~4 秒仍然全程零停顿 —— 那种形态比间隔大小更像脚本，
 * 当天该账号两次被临时限制（第二次长达 3 天）。
 */
export const DEFAULT_LONG_RUN_THRESHOLD = 15
/** 长休时长区间（1~3 分钟）。 */
export const DEFAULT_LONG_RUN_BREAK_MS: CleanupRange = { min: 60_000, max: 180_000 }
/** 长休区间的合法范围（30 秒 ~ 10 分钟）。 */
export const LONG_RUN_BREAK_BOUNDS_MS: CleanupRange = { min: 30_000, max: 600_000 }
/** 长休阈值的合法范围（0 = 关闭，上限 100 次）。 */
export const LONG_RUN_THRESHOLD_BOUNDS = { min: 0, max: 100 }

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
export const MAX_PROMPT_CHARS_BOUNDS = { min: 120_000, max: 1_500_000 } as const

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
export const DEFAULT_MAX_PROMPT_CHARS = 400_000

/** 规整 prompt 字符上限：非数 → 默认；越界 → 夹到边界。 */
export function clampMaxPromptChars(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PROMPT_CHARS
  return Math.max(MAX_PROMPT_CHARS_BOUNDS.min, Math.min(MAX_PROMPT_CHARS_BOUNDS.max, Math.round(value)))
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
export const MAX_REF_IMAGES_BOUNDS = { min: 0, max: 100 } as const
export const DEFAULT_MAX_REF_IMAGES = 24

/** 规整图片数量上限：非数 → 默认；越界 → 夹到边界。 */
export function clampMaxRefImages(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_REF_IMAGES
  return Math.max(MAX_REF_IMAGES_BOUNDS.min, Math.min(MAX_REF_IMAGES_BOUNDS.max, Math.round(value)))
}

/** 距上次请求超过这么久就算"歇过了"，连续计数归零。 */
const LONG_RUN_IDLE_RESET_MS = 120_000

/** 间隔可选的推荐档位（设置页的快捷按钮用）：[下限, 上限]。 */
export const INTERVAL_PRESETS = [
  [1_500, 2_500],
  [2_000, 4_000],
  [5_000, 9_000],
] as const
/** 设置页滑块的取值上限。 */
export const MAX_INTERVAL_MS = 30_000

// ── 会话清理的三个区间 ────────────────────────────────────────────────────
//
// 为什么这三个参数也要"上下限 + 随机"：它们原来都是**固定值**（攒 8 个 / 等 90 秒 /
// 逐个删时中间没有间隔）。固定值本身就是一种机器特征 —— 每次都攒到第 8 个就动手、
// 每次都等 90 秒、删除请求像连发。真人不会这么精确。
//
// 默认值都围绕原来的固定值取一个区间（均值≈旧值），所以行为上没有突变，
// 只是把"精确"换成了"有方差"。
/** 一个可随机取值的区间（闭区间，单位由字段决定）。 */
export interface CleanupRange {
  min: number
  max: number
}

/** 攒够几个：默认 6~10（均值 8，等于旧默认）。 */
export const DEFAULT_CLEANUP_BATCH: CleanupRange = { min: 6, max: 10 }
/** 从第一个会话入队起最多等多久：默认 60~120 秒（均值 90s，等于旧默认）。 */
export const DEFAULT_CLEANUP_DELAY_MS: CleanupRange = { min: 60_000, max: 120_000 }
/** 两次删除之间的间隔：默认 0.8~2.5 秒。
 *  新增项 —— 批量删除不被服务端接受时会退化成"逐个删"，原来那串请求中间**没有间隔**。 */
export const DEFAULT_CLEANUP_GAP_MS: CleanupRange = { min: 800, max: 2_500 }

/** 各区间允许被设置到的范围（设置页滑块也按这个画）。 */
export const CLEANUP_BATCH_BOUNDS = { min: 1, max: 50 }
export const CLEANUP_DELAY_BOUNDS_MS = { min: 5_000, max: 600_000 }
export const CLEANUP_GAP_BOUNDS_MS = { min: 0, max: 60_000 }

/**
 * 把任意输入规整成一个合法区间：非数忽略、按 bounds 夹住、**上下限颠倒时自动交换**。
 * 返回 undefined 表示"这个字段不合法、当没给"（调用方回落到默认）。
 */
export function normalizeCleanupRange(
  value: unknown,
  bounds: { min: number; max: number },
): CleanupRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { min?: unknown; max?: unknown }
  const lo = Number(raw.min)
  const hi = Number(raw.max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined
  const clamp = (n: number) => Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)))
  // 用户把两个滑块拖反了不该报错，也不该让"下限 > 上限"这种状态活下去
  return { min: clamp(Math.min(lo, hi)), max: clamp(Math.max(lo, hi)) }
}

export interface GateSettings {
  allowConcurrent: boolean
  /** 长任务保护：连续多少次请求后强制长休（0 = 关闭）。 */
  longRunThreshold: number
  /** 长休时长区间（毫秒）；未设置时用内置默认。 */
  longRunBreakMs?: CleanupRange
  /** 间隔下限（毫秒）。与上限相等时退化为固定间隔。 */
  minRequestIntervalMs: number
  /** 间隔上限（毫秒）。实际等待在 [下限, 上限] 之间**随机**取值。 */
  maxRequestIntervalMs: number
  /**
   * 临时会话清理策略。它不参与节流逻辑，只是**搭同一份设置文件与同一个设置页**存储，
   * 实际执行在 webapi.ts 的 createSessionCleaner（类型放宽为字面量，避免循环依赖）。
   */
  sessionCleanup?: 'immediate' | 'deferred' | 'keep'
  /** deferred：攒够几个（个）。实际阈值**每轮清理重新随机抽**。 */
  cleanupBatch?: CleanupRange
  /** deferred：从第一个会话入队起最多等多久（毫秒）。每轮重新随机抽。 */
  cleanupDelayMs?: CleanupRange
  /** 两次删除之间的间隔（毫秒）。每次删除前重新随机抽。 */
  cleanupGapMs?: CleanupRange
  /**
   * 每次请求发送的 prompt 字符上限。**不参与节流逻辑** —— 和 sessionCleanup 一样，
   * 只是搭同一份设置文件（gate.json）与同一个设置页存储，真正的执行方是 adapter。
   */
  maxPromptChars?: number
  /** 一次请求最多带多少张图片（`ref_file_ids` 的长度；0 = 不限制）。见 MAX_REF_IMAGES_BOUNDS。 */
  maxRefImages?: number
}

/** 节流设置文件：`${DSH_HOME || ~/.dsh}/web-login/gate.json`（插件自治，与凭证同目录）。 */
export function gateSettingsPath(): string {
  return join(webLoginDir(), 'gate.json')
}

/**
 * 读设置页保存过的值。文件不存在/损坏都返回 undefined（回落到 cordis config）。
 * 优先级：**设置页（文件）> cordis config > 内置默认** —— 设置页是用户的显式操作，
 * 不该被配置文件里的旧值盖掉。
 */
export function readGateSettings(): Partial<GateSettings> | undefined {
  try {
    const file = gateSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const out: Partial<GateSettings> = {}
    if (typeof parsed?.allowConcurrent === 'boolean') out.allowConcurrent = parsed.allowConcurrent
    if (Number.isFinite(parsed?.minRequestIntervalMs)) {
      out.minRequestIntervalMs = clampInterval(Number(parsed.minRequestIntervalMs))
    }
    if (Number.isFinite(parsed?.maxRequestIntervalMs)) {
      out.maxRequestIntervalMs = clampInterval(Number(parsed.maxRequestIntervalMs))
    }
    // 老配置（0.1.20 只存了 min）= 固定间隔语义：上限跟随下限
    if (out.minRequestIntervalMs !== undefined && out.maxRequestIntervalMs === undefined) {
      out.maxRequestIntervalMs = out.minRequestIntervalMs
    }
    const cleanup = parsed?.sessionCleanup
    if (cleanup === 'immediate' || cleanup === 'deferred' || cleanup === 'keep') {
      out.sessionCleanup = cleanup
    }
    const batch = normalizeCleanupRange(parsed?.cleanupBatch, CLEANUP_BATCH_BOUNDS)
    if (batch) out.cleanupBatch = batch
    const delay = normalizeCleanupRange(parsed?.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS)
    if (delay) out.cleanupDelayMs = delay
    const gap = normalizeCleanupRange(parsed?.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS)
    if (gap) out.cleanupGapMs = gap
    if (Number.isFinite(parsed?.longRunThreshold)) {
      const n = Math.round(Number(parsed.longRunThreshold))
      out.longRunThreshold = Math.max(
        LONG_RUN_THRESHOLD_BOUNDS.min,
        Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, n),
      )
    }
    const lrb = normalizeCleanupRange(parsed?.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS)
    if (lrb) out.longRunBreakMs = lrb
    if (Number.isFinite(parsed?.maxPromptChars)) {
      out.maxPromptChars = clampMaxPromptChars(Number(parsed.maxPromptChars))
    }
    if (Number.isFinite(parsed?.maxRefImages)) {
      out.maxRefImages = clampMaxRefImages(Number(parsed.maxRefImages))
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

export function writeGateSettings(settings: GateSettings): void {
  const file = gateSettingsPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

/** 把任意输入规整成合法间隔：非数 → 默认，负 → 0，超上限 → 上限。 */
export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_REQUEST_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(0, Math.floor(value)))
}

export interface RequestGateOptions {
  /** 允许同一账号并发（默认 false）。开启会恢复「标题与主回答同时发」的高风险行为。 */
  allowConcurrent?: boolean
  /** 两次调用之间的最小间隔（毫秒）。0 = 不限。 */
  minIntervalMs?: number
  /** 间隔上限（毫秒）。缺省且未给 minIntervalMs 时用默认上限；给了 minIntervalMs 则取同值（保持「固定间隔」老语义）。 */
  maxIntervalMs?: number
  /** 长任务保护：连续多少次请求后强制长休一次（0 = 关闭）。缺省 DEFAULT_LONG_RUN_THRESHOLD。 */
  longRunThreshold?: number
  /** 长休时长区间（毫秒）。缺省 DEFAULT_LONG_RUN_BREAK_MS。 */
  longRunBreakMs?: CleanupRange
  /** 随机源（单测注入用）。 */
  random?: () => number
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
  /** prompt 字符上限（本模块不执行，只是存下来以便落盘与回显）。 */
  maxPromptChars?: number
  /** 一次请求最多带多少张图片（同上，本模块不执行，只是存下来以便落盘与回显）。 */
  maxRefImages?: number
  /**
   * 会话清理策略（本模块不执行，同样只是存下来以便落盘与回显）。
   *
   * ⚠️ 必须**传进来**（2026-09-14 修）：设置页保存时写的是 `settings()` 的返回值，
   * 而这些字段若没初始化就永远是 `undefined` → 保存时被静默丢掉。
   * 后果是实测过的：用户只是调了下请求间隔，清理设置就被从 gate.json 里抹掉，
   * 重启后悄悄回到内置默认 —— 正是「拖了滑块却像没生效」那一类问题。
   */
  sessionCleanup?: GateSettings['sessionCleanup']
  cleanupBatch?: CleanupRange
  cleanupDelayMs?: CleanupRange
  cleanupGapMs?: CleanupRange
  /** 便于单测注入。 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RequestGate {
  /** 取得放行许可；返回的函数必须调用一次（幂等）以释放并让出队首。 */
  /** signal 可在排队/等间隔期间取消（F11）；取消时抛 AbortError 且闸门不会锁死。 */
  acquire(label?: string, signal?: AbortSignal): Promise<() => void>
  /** 当前状态（诊断/测试用）。 */
  stats(): { running: number; waiting: number; lastFinishedAt: number }
  /** 读取当前生效的节流设置。 */
  settings(): GateSettings
  /** 运行时改设置（设置页保存后调用）；返回改完后的值。 */
  configure(next: Partial<GateSettings>): GateSettings
}

export function createRequestGate(options: RequestGateOptions = {}): RequestGate {
  // 可运行时修改（设置页保存后立即生效，不必重启）
  let allowConcurrent = options.allowConcurrent === true
  let longRunThreshold = options.longRunThreshold ?? DEFAULT_LONG_RUN_THRESHOLD
  let longRunBreakMs: CleanupRange | undefined = options.longRunBreakMs
  /** 连续请求计数（长休后、或歇够了之后归零）。 */
  let consecutive = 0

  let minIntervalMs = clampInterval(
    options.minIntervalMs ?? (options.maxIntervalMs !== undefined ? options.maxIntervalMs : DEFAULT_MIN_REQUEST_INTERVAL_MS),
  )
  let maxIntervalMs = clampInterval(
    options.maxIntervalMs ?? (options.minIntervalMs !== undefined ? options.minIntervalMs : DEFAULT_MAX_REQUEST_INTERVAL_MS),
  )
  if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs
  const random = options.random ?? Math.random
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const logger = options.logger

  /** 队尾：每个调用完成后才 resolve，保证 FIFO 且「上一个没结束就不放行下一个」。 */
  let tail: Promise<void> = Promise.resolve()
  let running = 0
  let waiting = 0
  let lastFinishedAt = 0
  /** 是否已经有调用结束过 —— 首次调用不该被间隔规则拖住。 */
  let hasFinished = false

  async function acquire(label = 'call', signal?: AbortSignal): Promise<() => void> {
    let releaseMine!: () => void
    const mine = new Promise<void>((resolve) => {
      releaseMine = resolve
    })
    const prev = tail
    tail = prev.then(() => mine)

    const aborted = (): Error => {
      const error = new Error(`「${label}」在闸门等待中被取消`)
      error.name = 'AbortError'
      return error
    }
    /** 让等待可被中断：abort 时立刻 reject，不等定时器/前序请求。 */
    const waitOrAbort = (inner: Promise<unknown>): Promise<void> => {
      if (!signal) return inner.then(() => undefined)
      if (signal.aborted) return Promise.reject(aborted())
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort)
          reject(aborted())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        inner.then(
          () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          },
          (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
    }

    waiting += 1
    try {
      if (signal?.aborted) throw aborted()
      // 串行：等前面所有调用结束。并发模式跳过这一步（间隔仍然生效）。
      if (!allowConcurrent) {
        if (running > 0 || waiting > 1) {
          logger?.debug?.(`deepseek-web: 「${label}」排队等待（前面还有 ${running} 个在跑 / ${waiting - 1} 个在等）`)
        }
        await waitOrAbort(prev)
      }

    // 长任务保护：先算"是不是已经连着跑了很久"。
    // 距上次结束已经过了很久 → 说明人是歇过的，连续计数归零。
    if (hasFinished && now() - lastFinishedAt > LONG_RUN_IDLE_RESET_MS) consecutive = 0
    const breakRange = longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS
    const needsBreak = longRunThreshold > 0 && consecutive > 0 && consecutive >= longRunThreshold

    // 间隔：在 [下限, 上限] 之间**随机**取值，按「上一次结束」时刻算
    // （不是上一次开始 —— 否则长回答之后的连环请求仍然很密）。每一次的等待都不同，避免定时器特征。
    const gap = needsBreak ? Math.round(breakRange.min + random() * Math.max(0, breakRange.max - breakRange.min)) : nextGap()
    if (hasFinished && (needsBreak || maxIntervalMs > 0)) {
      const waitMs = lastFinishedAt + gap - now()
      if (needsBreak) {
        logger?.info?.(
          `deepseek-web: 已连续 ${longRunThreshold} 次请求 —— 长休 ${Math.round(gap / 1000)}s 再继续（长任务保护：连续跑比间隔小更像脚本）`,
        )
      }
      if (waitMs > 0) {
        if (!needsBreak) {
          logger?.info?.(
            `deepseek-web: 距上次请求不足 ${gap}ms（区间 ${minIntervalMs}~${maxIntervalMs}），` +
              `等 ${Math.round(waitMs)}ms 再发「${label}」（防账号级限流）`,
          )
        }
        await waitOrAbort(sleep(waitMs))
      }
    }

    // 2026-09-13 审计 N08：清计数必须放在**长休真正走完且未被取消之后**。
    // 旧写法在 sleep 之前就 `consecutive = 0`，于是「取消一次长休」等于把休息债务一笔勾销 ——
    // 下一次请求直接绕过长休（把「闸门可取消」的正确修复和长任务保护组合出了旁路）。
    if (signal?.aborted) throw aborted()
    if (needsBreak) consecutive = 0

    } catch (error) {
      // 取消（或前序出错）时必须把自己从队列里摘掉：本节点的 mine 一旦不 resolve，
      // 后面排队的请求会在 tail 上永久卡住 —— 闸门就锁死了。
      releaseMine()
      throw error
    } finally {
      waiting -= 1
    }

    running += 1
    let released = false
    return () => {
      if (released) return
      released = true
      running -= 1
      lastFinishedAt = now()
      hasFinished = true
      consecutive += 1
      releaseMine()
    }
  }

  /** 本次实际使用的间隔：区间内随机；上下限相等则固定。 */
  function nextGap(): number {
    if (maxIntervalMs <= minIntervalMs) return minIntervalMs
    return Math.round(minIntervalMs + random() * (maxIntervalMs - minIntervalMs))
  }

  /** 会话清理策略不在本模块实现，只借用设置文件存储（由宿主读取后交给 cleaner）。 */
  /** prompt 字符上限（同 cleanupMode：只是存着，执行在 adapter）。 */
  let maxPromptChars = clampMaxPromptChars(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS)
  // 图片数量上限（同 maxPromptChars：只是存着，真正的执行在 adapter 的 uploadRequestImages）。
  let maxRefImages = clampMaxRefImages(options.maxRefImages ?? DEFAULT_MAX_REF_IMAGES)
  let cleanupMode = options.sessionCleanup
  // 会话清理的三个区间（同样不参与节流逻辑）。存在这里是为了**能落盘**：
  // writeGateSettings 写的是 settings() 的返回值，不存就丢。
  // ⚠️ 因此必须**从 options 初始化**（2026-09-14 修）：否则保存设置页时，
  // `settings()` 里没有这几个字段 → 用户调个间隔就把清理设置一起冲没了。
  let cleanupBatch = normalizeCleanupRange(options.cleanupBatch, CLEANUP_BATCH_BOUNDS)
  let cleanupDelayMs = normalizeCleanupRange(options.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS)
  let cleanupGapMs = normalizeCleanupRange(options.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS)

  function settings(): GateSettings {
    return {
      allowConcurrent,
      minRequestIntervalMs: minIntervalMs,
      maxRequestIntervalMs: maxIntervalMs,
      ...(cleanupMode ? { sessionCleanup: cleanupMode } : {}),
      ...(cleanupBatch ? { cleanupBatch } : {}),
      ...(cleanupDelayMs ? { cleanupDelayMs } : {}),
      ...(cleanupGapMs ? { cleanupGapMs } : {}),
      longRunThreshold,
      ...(longRunBreakMs ? { longRunBreakMs } : {}),
      maxPromptChars,
      maxRefImages,
    }
  }

  function configure(next: Partial<GateSettings>): GateSettings {
    if (typeof next.allowConcurrent === 'boolean') allowConcurrent = next.allowConcurrent
    if (next.minRequestIntervalMs !== undefined) minIntervalMs = clampInterval(Number(next.minRequestIntervalMs))
    if (next.maxRequestIntervalMs !== undefined) maxIntervalMs = clampInterval(Number(next.maxRequestIntervalMs))
    if (next.sessionCleanup !== undefined) cleanupMode = next.sessionCleanup
    if (next.maxPromptChars !== undefined) maxPromptChars = clampMaxPromptChars(Number(next.maxPromptChars))
    if (next.maxRefImages !== undefined) maxRefImages = clampMaxRefImages(Number(next.maxRefImages))
    // 三个区间：非法的输入直接当"没给"（不报错、也不覆盖已有的有效值）
    if (next.cleanupBatch !== undefined) {
      const value = normalizeCleanupRange(next.cleanupBatch, CLEANUP_BATCH_BOUNDS)
      if (value) cleanupBatch = value
    }
    if (next.cleanupDelayMs !== undefined) {
      const value = normalizeCleanupRange(next.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS)
      if (value) cleanupDelayMs = value
    }
    if (next.cleanupGapMs !== undefined) {
      const value = normalizeCleanupRange(next.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS)
      if (value) cleanupGapMs = value
    }
    if (next.longRunThreshold !== undefined && Number.isFinite(next.longRunThreshold)) {
      longRunThreshold = Math.max(
        LONG_RUN_THRESHOLD_BOUNDS.min,
        Math.min(LONG_RUN_THRESHOLD_BOUNDS.max, Math.round(next.longRunThreshold)),
      )
    }
    if (next.longRunBreakMs !== undefined) {
      const value = normalizeCleanupRange(next.longRunBreakMs, LONG_RUN_BREAK_BOUNDS_MS)
      if (value) longRunBreakMs = value
    }
    // 设置页两个滑块可能拖出「上限 < 下限」，这里纠正（不报错，直接夹住）
    if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs
    logger?.info?.(
      `deepseek-web: 请求节流设置已更新 —— ${allowConcurrent ? '允许并发（不推荐）' : '串行'} · ` +
        `间隔 ${minIntervalMs}~${maxIntervalMs}ms（随机）` +
        (cleanupBatch ? ` · 清理阈值 ${cleanupBatch.min}~${cleanupBatch.max} 个` : '') +
        (cleanupDelayMs
          ? ` · 最长等待 ${Math.round(cleanupDelayMs.min / 1000)}~${Math.round(cleanupDelayMs.max / 1000)}s`
          : '') +
        (cleanupGapMs ? ` · 删除间隔 ${cleanupGapMs.min}~${cleanupGapMs.max}ms` : '') +
        ` · 长任务保护 ${longRunThreshold > 0 ? `每 ${longRunThreshold} 次长休 ${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).min / 1000)}~${Math.round((longRunBreakMs ?? DEFAULT_LONG_RUN_BREAK_MS).max / 1000)}s` : '关闭'}`,
    )
    return settings()
  }

  return {
    acquire,
    stats: () => ({ running, waiting, lastFinishedAt }),
    settings,
    configure,
  }
}
