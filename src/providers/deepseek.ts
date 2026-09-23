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
import { estimateTokens } from './estimate.ts'
import type { WebAuth } from '../core/auth.ts'
import { AdapterLlmError, hasUsableAuth } from '../core/auth.ts'
import {
  DEFAULT_MAX_PROMPT_CHARS,
  DEFAULT_MAX_REF_IMAGES,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_MAX_REQUEST_INTERVAL_MS,
  createRequestGate,
  type RequestGate,
} from '../core/gate.ts'
import { readActiveAuth } from './account-ctx.ts'
import {
  createSessionCleaner,
  scheduleDeleteSession,
  streamWebCompletion,
  uploadImageFile,
} from '../core/webapi.ts'
import {
  ToolCallStreamFilter,
  SystemMarkerStreamFilter,
  BoilerplateFilter,
  TranscriptEchoGuard,
  drainTextPipeline,
  looksLikeUnexecutedToolProgram,
  looksMidSentence,
  serializePromptParts,
  collectImageRefs,
  imageUploadName,
  type ToolSchemaLike,
} from './protocol-bridge.ts'
import { handleAccountFailure, markAccountLimited } from '../rotation.ts'
import { runtimeConfig } from '../config.ts'
import { activeAccountId } from '../core/accounts.ts'

/** provider id → 账号库分区名（deepseek 沿用旧目录，零迁移）。 */
const ACCOUNT_DIR = 'deepseek'
import type {
  ChatCompletionResult,
  NormalizedRequest,
  ProviderModelInfo,
  ProviderStreamEvent,
  WebProxyProvider,
} from '../provider-types.ts'
import { errorFinish } from '../provider-types.ts'

/** 与 DSH adapter 等价的续写/纠正指令。 */
const CONTINUE_INSTRUCTION =
  '继续：请从你上一条回复的结尾处无缝接着往下写——不要重复任何已输出的内容，' +
  '不要加「好的」「以下是」之类的开场白，不要重新组织语言；' +
  '如果上一条回复停在句子中间，就从那个断点直接把句子写完并继续。'

const TOOL_CALL_RETRY_INSTRUCTION =
  '你刚才把要执行的程序写进了正文文本。写在正文里的代码不会被执行 —— 这一轮因此没有发生任何工具调用。\n' +
  '请把同一段程序作为工具调用重新发出：只输出一个 JSON 对象，前后不要有任何其它文字：\n' +
  '{"tool_calls":[{"name":"<工具名>","arguments":{...}}]}\n' +
  '即使系统提示要求你写 TypeScript 程序来完成动作，那个程序也必须放进工具调用的 arguments 里，' +
  '不能直接写在正文中 —— 只有作为工具调用发出，它才会真的被执行。'

const MODEL_SPECS: ProviderModelInfo[] = [
  { id: 'deepseek-chat', name: 'DeepSeek 网页 · 快速模式（思考关）', contextWindow: 1_048_576 },
  { id: 'deepseek-reasoner', name: 'DeepSeek 网页 · 快速模式（思考开）', contextWindow: 1_048_576 },
]

/** 旧档位别名 → 现档位（DSH 插件语义保持一致）。 */
const LEGACY_ALIASES: Record<string, string> = {
  'deepseek-pro': 'deepseek-chat',
  'deepseek-expert': 'deepseek-chat',
  'deepseek-vision': 'deepseek-chat',
}

function resolveModel(model: string): { id: string; thinking: boolean } {
  const requested = String(model ?? '').toLowerCase()
  const direct = MODEL_SPECS.find((spec) => spec.id === requested)
  if (direct) return { id: direct.id, thinking: direct.id === 'deepseek-reasoner' }
  const alias = LEGACY_ALIASES[requested]
  if (alias) return { id: alias, thinking: alias === 'deepseek-reasoner' }
  // 未识别的模型一律回落到快速模式-思考关（与 DSH resolveSpec 的兜底一致）
  return { id: 'deepseek-chat', thinking: false }
}

/** 图片上传缓存：按账号作用域 + TTL + 条数封顶（移植自 DSH adapter.ImageUploadCache）。 */
class ImageUploadCache {
  private scope = ''
  private entries = new Map<string, { fileId: string; expiresAt: number }>()
  private readonly maxEntries = 200
  private readonly ttlMs = 30 * 60_000

  useScope(token: string): void {
    if (token !== this.scope) {
      this.scope = token
      this.entries.clear()
    }
  }

  get(key: string): string | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return hit.fileId
  }

  set(key: string, fileId: string, at: number, scope: string): void {
    if (scope !== this.scope) return
    this.entries.set(key, { fileId, expiresAt: at + this.ttlMs })
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) this.entries.delete(oldest[0])
    }
  }

  prune(): void {
    const now = Date.now()
    for (const [key, value] of this.entries) {
      if (now > value.expiresAt) this.entries.delete(key)
    }
  }
}

/** OpenAI 消息里的图片引用（data URL 解码后）。 */
interface DecodedImage {
  attachmentId: string
  data: Uint8Array
  mediaType: string
  name?: string
}

/** 从 OpenAI content 块里收集图片（data URL only；http(s) URL 网页端无法直取，降级为占位标记）。 */
function collectOpenAIImages(messages: NormalizedRequest['messages']): DecodedImage[] {
  const images: DecodedImage[] = []
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'image_url') continue
      const url = String((block as any).image_url?.url ?? '')
      const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url)
      if (!match) continue
      try {
        const data = Uint8Array.from(Buffer.from(match[2], 'base64'))
        const mediaType = match[1].toLowerCase()
        // attachmentId 按内容寻址（与 DSH 插件同语义：同一张图去重靠它）
        images.push({ attachmentId: `data:${mediaType}:${data.length}`, data, mediaType })
      } catch {
        /* 坏 data URL 跳过 */
      }
    }
  }
  return images
}

export interface DeepseekProviderOptions {
  /** 注入假流（离线测试）；缺省用真实 streamWebCompletion。 */
  streamCompletion?: (auth: WebAuth, params: any) => AsyncGenerator<any>
  /** 注入假上传（离线测试）。 */
  uploadImage?: typeof uploadImageFile
  /** 覆盖配置（server 启动时传入 proxy.json 的 deepseek 段）。 */
  config?: {
    minRequestIntervalMs?: number
    maxRequestIntervalMs?: number
    maxPromptChars?: number
    maxRefImages?: number
    autoContinue?: boolean
    maxContinuations?: number
    deleteWebSessions?: boolean
    sessionCleanup?: 'immediate' | 'deferred' | 'keep'
  }
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
}

export class DeepseekWebProvider implements WebProxyProvider {
  readonly id = 'deepseek-web'
  readonly displayName = 'DeepSeek 网页版（免费）'

  private gate: RequestGate
  private uploadCache = new ImageUploadCache()
  private sessionCleaner: ReturnType<typeof createSessionCleaner> | undefined
  private options: DeepseekProviderOptions
  /** 遇限流/封号自动切号（proxy.json rotation，默认开）。 */
  private rotationEnabled = true

  constructor(options: DeepseekProviderOptions = {}) {
    this.options = options
    this.rotationEnabled = (options.config as any)?.rotation !== false
    const cfg = options.config ?? {}
    this.gate = createRequestGate({
      allowConcurrent: false,
      minIntervalMs: cfg.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
      // 期望区间上限：gate 的 createRequestGate 只有 minIntervalMs 一个参数时退化为固定间隔；
      // 与 DSH 等价的随机区间由 gate.ts 内部 readGateSettings 兜底 —— 这里显式传上下限。
      maxIntervalMs: cfg.maxRequestIntervalMs ?? DEFAULT_MAX_REQUEST_INTERVAL_MS,
      logger: options.logger,
    } as any)
    if (cfg.sessionCleanup && cfg.sessionCleanup !== 'immediate') {
      this.sessionCleaner = createSessionCleaner({ policy: { mode: cfg.sessionCleanup } })
    }
  }

  async status() {
    const auth = readActiveAuth(ACCOUNT_DIR)
    if (!hasUsableAuth(auth)) {
      return { loggedIn: false, detail: '尚未登录（用 `dsweb-proxy login` 或手动粘贴 token）' }
    }
    return {
      loggedIn: true,
      ...(auth.user?.display ? { display: auth.user.display } : {}),
      ...(auth.unverified ? { detail: '凭证未通过服务端校验' } : {}),
    }
  }

  async login(options?: { headless?: boolean }) {
    const { browserLogin } = await import('../core/browser-login.ts')
    try {
      const outcome = await browserLogin({
        ...(options?.headless !== undefined ? { headless: options.headless } : {}),
      } as any)
      if (outcome?.auth) {
        const { commitCapturedAuth } = await import('./account-ctx.ts')
        commitCapturedAuth(outcome.auth as any, ACCOUNT_DIR)
        return { ok: true, message: `登录成功（${(outcome.auth as any).user?.display ?? '未知账号'}）` }
      }
      return { ok: false, message: String((outcome as any)?.error ?? '登录未完成（窗口被关闭或超时）') }
    } catch (error: any) {
      return { ok: false, message: `登录失败：${error?.message ?? error}` }
    }
  }

  async logout() {
    const { clearActiveAuth } = await import('./account-ctx.ts')
    clearActiveAuth(ACCOUNT_DIR)
    return { ok: true, message: '已退出当前账号' }
  }

  models(): ProviderModelInfo[] {
    return MODEL_SPECS
  }

  async chat(request: NormalizedRequest): Promise<ChatCompletionResult> {
    const auth = readActiveAuth(ACCOUNT_DIR)
    if (!hasUsableAuth(auth)) {
      throw new AdapterLlmError(
        '尚未登录 DeepSeek 网页版：先运行 `dsweb-proxy login`，或在设置里手动粘贴 userToken。',
        'MISSING_CREDENTIAL',
      )
    }
    const stream = this.gatedChat(auth, request)
    return { stream }
  }

  /** 闸门外壳（与 DSH gatedStream 等价：acquire 后才真正开始，finally 必释放）。 */
  private async *gatedChat(auth: WebAuth, request: NormalizedRequest): AsyncGenerator<ProviderStreamEvent> {
    const release = await this.gate.acquire('chat', request.signal)
    const accountIdAtStart = activeAccountId(ACCOUNT_DIR)
    try {
      yield* this.streamImpl(auth, request)
    } catch (error: any) {
      // 账号级死亡（限流封号 / 登录态失效）：落库限制时间，按开关轮转到下一个账号。
      // 轮转成功 → 对外报可重试错误（新账号承担下一次请求）；没号可切 → 原样抛出真实错误。
      const mutedUntilMs = Number.isFinite(error?.mutedUntilMs) ? Number(error.mutedUntilMs) : undefined
      if (mutedUntilMs !== undefined && accountIdAtStart) markAccountLimited(accountIdAtStart, mutedUntilMs, ACCOUNT_DIR, 'muted')
      // 轮转开关以**磁盘当前值**为准（控制台改完下一次失败就生效，不必重启 sidecar）。
      const rotation = handleAccountFailure(error, {
        rotation: this.rotationEnabled && runtimeConfig().rotation !== false,
        provider: ACCOUNT_DIR,
      })
      if (rotation.switched) {
        this.options.logger?.info?.(
          `deepseek-web: 当前账号不可用（${error?.code ?? '未知错误'}），已自动切换到 ${rotation.to?.display ?? rotation.to?.id}`,
        )
      }
      throw error
    } finally {
      release()
    }
  }

  private async *streamImpl(auth: WebAuth, request: NormalizedRequest): AsyncGenerator<ProviderStreamEvent> {
    const cfg = this.options.config ?? {}
    const logger = this.options.logger
    const runStream = this.options.streamCompletion ?? streamWebCompletion
    const uploadImage = this.options.uploadImage ?? uploadImageFile
    const { id: modelId, thinking: modelThinking } = resolveModel(request.model)

    // ── 图片：OpenAI image_url(data:) → 上传网页端 → ref_file_ids ──
    const images = collectOpenAIImages(request.messages)
    const maxRefImages = cfg.maxRefImages ?? DEFAULT_MAX_REF_IMAGES
    const overLimit = maxRefImages > 0 && images.length > maxRefImages
    const kept = overLimit ? images.slice(-maxRefImages) : images
    const keptKeys = new Set(kept.map((image) => image.attachmentId))
    const notices: string[] = []
    if (overLimit) {
      notices.push(
        `\n[deepseek-web] 本轮只带了最近的 ${kept.length} 张图片，更早的 ${images.length - kept.length} 张没有随请求发送。` +
          '这是正常的长度控制，不是错误。\n',
      )
    }

    this.uploadCache.useScope(auth.token)
    this.uploadCache.prune()
    const refFileIds: string[] = []
    const failures: string[] = []
    for (const image of kept) {
      request.signal?.throwIfAborted()
      const cached = this.uploadCache.get(image.attachmentId)
      if (cached) {
        refFileIds.push(cached)
        continue
      }
      try {
        const uploaded = await uploadImage(
          auth,
          { data: image.data, mediaType: image.mediaType, name: imageUploadName(image.name, image.mediaType) },
          request.signal,
        )
        this.uploadCache.set(image.attachmentId, uploaded.fileId, Date.now(), auth.token)
        refFileIds.push(uploaded.fileId)
      } catch (error: any) {
        if (request.signal?.aborted) throw error
        const message = String(error?.message ?? error)
        failures.push(message)
        logger?.warn?.(`deepseek-web: 图片上传失败（已降级为纯文本）：${message}`)
      }
    }
    if (failures.length > 0) {
      const brief = failures[0].length > 120 ? `${failures[0].slice(0, 120)}…` : failures[0]
      notices.push(`\n⚠️ [deepseek-web] 有 ${failures.length} 张图片没能传给模型（${brief}），本轮回答只基于文字内容。\n`)
    }
    const uploadNotice = notices.join('')

    // ── 序列化：OpenAI messages → 网页端单段 prompt ──
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    const chatMessages = request.messages.filter((message) => message.role !== 'system')
    const tools: ToolSchemaLike[] = (request.tools ?? [])
      .filter((tool) => tool?.type === 'function' && tool.function?.name)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? {},
      }))
    const maxChars = cfg.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
    let promptParts = serializePromptParts({
      system,
      messages: chatMessages as any,
      tools,
      maxChars,
      keptImageKeys: keptKeys,
    })
    let currentPrompt = promptParts.full

    const knownNames = new Set(tools.map((tool) => tool.name))
    let filter = new ToolCallStreamFilter(knownNames)
    let echoGuard = new TranscriptEchoGuard()
    let systemMarkerFilter = new SystemMarkerStreamFilter()
    let boilerplate = new BoilerplateFilter()

    let toolCallCount = 0
    let finishReason: string | undefined
    const usageRounds: { prompt: string; outputChars: number; total?: number }[] = []
    let rejectedProtocol = ''
    let rejectedReason: 'unbalanced' | 'unparsable' | 'oversize' | 'echo' | undefined
    let echoedTranscript = false
    let textLen = 0
    let reasoningLen = 0
    let rounds = 0
    let toolCallRetried = false

    const emitCalls = function* (
      calls: readonly { id: string; name: string; arguments: string }[],
    ): Generator<ProviderStreamEvent> {
      for (const call of calls) {
        toolCallCount += 1
        yield { type: 'tool-calls', calls: [call] }
      }
    }

    try {
      if (uploadNotice) {
        textLen += uploadNotice.length
        this.textBuffer += uploadNotice
        yield { type: 'text-delta', text: uploadNotice }
      }
      let toolProgramRetried = false
      for (;;) {
        let roundError: AdapterLlmError | undefined
        finishReason = undefined
        const textLenAtRoundStart = textLen
        const roundUsage: { prompt: string; outputChars: number; total?: number } = { prompt: currentPrompt, outputChars: 0 }
        usageRounds.push(roundUsage)
        try {
          for await (const event of runStream(auth, {
            prompt: currentPrompt,
            promptParts: { head: promptParts.head, entries: promptParts.entries, maxChars },
            thinkingEnabled: modelThinking,
            modelType: modelId === 'deepseek-reasoner' ? 'default' : 'default',
            refFileIds: rounds === 0 ? refFileIds : [],
            signal: request.signal,
            idleTimeoutMs: 120_000,
            onDeleteSession:
              cfg.deleteWebSessions === false
                ? undefined
                : (sessionId: string) => {
                    if (this.sessionCleaner) this.sessionCleaner.schedule(auth, sessionId)
                    else scheduleDeleteSession(auth, sessionId)
                  },
          } as any)) {
            if (event.kind === 'thinking' || event.kind === 'text') roundUsage.outputChars += event.text.length
            if (event.kind === 'thinking') {
              reasoningLen += event.text.length
              yield { type: 'reasoning-delta', text: event.text }
              continue
            }
            if (event.kind === 'text') {
              const out = filter.push(event.text)
              const boiled = boilerplate.push(out.text)
              const guarded = echoGuard.push(boiled.text)
              if (guarded.echoed) echoedTranscript = true
              const cleaned = systemMarkerFilter.push(guarded.text)
              if (cleaned.text) {
                textLen += cleaned.text.length
                this.textBuffer += cleaned.text
                yield { type: 'text-delta', text: cleaned.text }
              }
              if (out.calls.length > 0) yield* emitCalls(out.calls)
              continue
            }
            if (event.kind === 'status') {
              logger?.debug?.(`deepseek-web: status=${event.value}`)
              continue
            }
            if (event.kind === 'error') {
              if (event.code === 'RATE_LIMIT') {
                // muted（账号封禁）单独成类：带解除时间抛出，gatedChat 的 catch 才能落库 + 切号。
                // 误归成"窗口并发"会让轮转永远不触发（用户实测现象）。
                const mutedUntil = (event as any).mutedUntilMs
                if (event.rateLimitKind === 'muted' || Number.isFinite(mutedUntil)) {
                  throw new AdapterLlmError(
                    Number.isFinite(mutedUntil)
                      ? `DeepSeek 网页端已临时限制本账号（user is muted）：预计 ${new Date(mutedUntil).toLocaleString('zh-CN', { hour12: false })} 解除，将自动切换账号。`
                      : `DeepSeek 网页端已临时限制本账号（user is muted），未给出解除时间。`,
                    'RATE_LIMIT',
                    {
                      ...(Number.isFinite(mutedUntil) ? { providerRetryAfterMs: Math.max(0, mutedUntil - Date.now()) } : {}),
                      ...(Number.isFinite(mutedUntil) ? { mutedUntilMs: mutedUntil } : {}),
                    },
                  )
                }
                throw new AdapterLlmError(
                  event.rateLimitKind === 'throttled'
                    ? `DeepSeek 网页端对这个账号限流了（发得太频繁）。这一步会自动退避重试。`
                    : `DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口正在生成）。这一步会自动重试。`,
                  'RATE_LIMIT',
                  {
                    ...(event.retryAfterMs !== undefined ? { providerRetryAfterMs: event.retryAfterMs } : {}),
                  },
                )
              }
              throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, 'PROVIDER_ERROR')
            }
            if (event.kind === 'finish') {
              finishReason = event.reason
              if (typeof event.totalTokens === 'number' && Number.isSafeInteger(event.totalTokens) && event.totalTokens >= 0) {
                roundUsage.total = event.totalTokens
              }
            }
          }
        } catch (error: any) {
          // 账号级死亡（封号/登录失效）不分轮次：立即向上抛给 gatedChat 走轮转，
          // 否则"续写轮"的失败会被 roundError 吞掉 → 永远不切号。
          const deadNow =
            Number.isFinite(error?.mutedUntilMs) ||
            /AUTH|40003|MISSING_CREDENTIAL/i.test(String(error?.code ?? ''))
          if (rounds > 0 && !deadNow) {
            if (request.signal?.aborted) throw new AdapterLlmError('请求被取消', 'ABORTED', { cause: error })
            roundError =
              error instanceof AdapterLlmError
                ? error
                : new AdapterLlmError(`自动续写失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
            logger?.warn?.(`deepseek-web: 自动续写第 ${rounds} 轮失败，保留已输出部分：${roundError.message}`)
          } else {
            throw error
          }
        }

        // ── 轮次收尾：吐净三层缓冲（与 DSH drainTextPipeline 语义一致）──
        const drained = drainTextPipeline(filter, boilerplate, echoGuard, false)
        if (drained.echoed) echoedTranscript = true
        const markerPending = systemMarkerFilter.push(drained.text)
        const markerEnd = systemMarkerFilter.flush()
        const tailText = markerPending.text + markerEnd.text
        if (tailText) {
          textLen += tailText.length
          this.textBuffer += tailText
          yield { type: 'text-delta', text: tailText }
        }
        if (drained.calls.length > 0) yield* emitCalls(drained.calls)
        if (drained.rejected && rounds === 0) {
          rejectedProtocol = drained.rejected.raw
          rejectedReason = drained.rejected.reason ?? 'unparsable'
        }

        // ── 自动续写判定（与 DSH adapter 等价）──
        const roundChars = textLen - textLenAtRoundStart
        const maxRounds = cfg.maxContinuations ?? 2
        const cutByServer = finishReason === undefined
        // 累计正文缓冲（续写判句中 / 回声告知都要全文）
        const partial = this.textBuffer
        const eligible =
          roundError === undefined &&
          cfg.autoContinue !== false &&
          rounds < maxRounds &&
          toolCallCount === 0 &&
          !request.signal?.aborted &&
          partial.length > 0 &&
          roundChars > 0 &&
          (looksMidSentence(partial) || cutByServer)
        const unexecutedProgram =
          !eligible &&
          roundError === undefined &&
          cfg.autoContinue !== false &&
          rounds < maxRounds &&
          toolCallCount === 0 &&
          !toolCallRetried &&
          !request.signal?.aborted &&
          partial.length > 0 &&
          looksLikeUnexecutedToolProgram(partial)
        if (!eligible && !unexecutedProgram) break
        rounds += 1
        if (unexecutedProgram) {
          toolCallRetried = true
          toolProgramRetried = true
        }
        logger?.info?.(
          unexecutedProgram
            ? `deepseek-web: 本轮把工具程序写进了正文，已要求改发工具调用（第 ${rounds}/${maxRounds} 轮）`
            : `deepseek-web: 回答疑似在句中被截，自动续写（第 ${rounds}/${maxRounds} 轮）`,
        )
        void toolProgramRetried
        promptParts = serializePromptParts({
          system,
          messages: [
            ...(chatMessages as any[]),
            { role: 'assistant', content: [{ type: 'text', text: partial }] },
            { role: 'user', content: [{ type: 'text', text: unexecutedProgram ? TOOL_CALL_RETRY_INSTRUCTION : CONTINUE_INSTRUCTION }] },
          ],
          tools,
          maxChars,
        })
        currentPrompt = promptParts.full
        filter = new ToolCallStreamFilter(knownNames)
        echoGuard = new TranscriptEchoGuard()
        systemMarkerFilter = new SystemMarkerStreamFilter()
        boilerplate = new BoilerplateFilter()
      }
    } catch (error: any) {
      if (error instanceof AdapterLlmError) throw error
      if (request.signal?.aborted) throw new AdapterLlmError('请求被取消', 'ABORTED', { cause: error })
      throw new AdapterLlmError(`流失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }

    // 回声告知（与 DSH 等价）
    if (echoedTranscript && toolCallCount === 0 && this.textBuffer.length > 0) {
      const echoNotice = '\n\n[deepseek-web] 本轮有一部分「历史回放格式」的内容被过滤（未上屏），回答可能因此不完整。\n'
      this.textBuffer += echoNotice
      yield { type: 'text-delta', text: echoNotice }
    }

    // usage 估算（与 DSH 等价）
    let inputTokens = 0
    let outputTokens = 0
    for (const round of usageRounds) {
      const estimateOutput = Math.ceil(round.outputChars / 3.2)
      if (round.total !== undefined) {
        const output = Math.min(round.total, estimateOutput)
        outputTokens += output
        inputTokens += round.total - output
      } else {
        outputTokens += estimateOutput
        inputTokens += estimateTokens(round.prompt)
      }
    }
    yield {
      type: 'usage',
      inputTokens,
      outputTokens,
      ...(reasoningLen > 0 ? { reasoningTokens: Math.min(outputTokens, estimateTokens('x'.repeat(reasoningLen))) } : {}),
    }

    if (toolCallCount > 0) {
      yield { type: 'finish', reason: 'tool-calls' }
      return
    }
    const hasVisibleText = this.textBuffer.length > 0
    if (echoedTranscript && !hasVisibleText) {
      yield {
        type: 'finish',
        reason: 'error',
        error: {
          message: 'DeepSeek 网页端把「对话转写格式」当成回答输出了（已丢弃），本次没有产生有效内容。',
          code: 'EMPTY_RESPONSE',
          retryable: true,
        },
      }
      return
    }
    if (rejectedProtocol) {
      const reasonText =
        rejectedReason === 'echo'
          ? '网页端本次输出的是一段历史内容回放（不是真要执行调用），已丢弃并自动重试；无需处理。'
          : rejectedReason === 'unbalanced'
            ? '网页端本次输出被截断，调用没收全，已丢弃并自动重试；无需处理。'
            : '网页端本次的调用格式无法解析，已丢弃并自动重试；无需处理。'
      yield {
        type: 'finish',
        reason: 'error',
        error: { message: reasonText, code: 'EMPTY_RESPONSE', retryable: true },
      }
      return
    }
    if (!hasVisibleText) {
      yield {
        type: 'finish',
        reason: 'error',
        error: {
          message: 'DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）',
          code: 'EMPTY_RESPONSE',
          retryable: true,
        },
      }
      return
    }
    yield { type: 'finish', reason: 'stop' }
  }

  /** 累计正文缓冲（续写判句中 / 回声告知都要全文）。 */
  private textBuffer = ''
}
