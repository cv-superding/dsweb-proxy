/**
 * qwen-web provider —— chat.qwen.ai 国际版网页端。
 *
 * 协议依据（2026-09 活跃开源项目源码逐行核对：Rfym21/Qwen2API 等）：
 *   登录态：localStorage `token`（JWT），上游请求以 Cookie `token=<JWT>` 发送
 *   建会话：POST /api/v2/chats/new   {chat_type:'t2t', models:[id], ...} → data.id
 *   对话：  POST /api/v2/chat/completions?chat_id=<id>  （上游仅流式）
 *   请求体：version 2.1 / incremental_output:true / messages[0].feature_config.
 *           output_schema:'phase'（必需，缺了不返回 delta.phase）
 *   SSE：   标准 data: 帧的 OpenAI chunk 风格；思考/正文由 delta.phase 分流
 *           （'think'/'thinking_summary' vs 'answer'）；usage 用 DashScope 命名
 *   坑：    上游会对同一请求开多路候选回答（response_index 0/1 交错 → 复读），
 *           必须锁 response_index === '0'（或首个出现的 index）
 *   风控：  请求体近 128KiB 触发 WAF captcha（RGV587_ERROR）；data.code==='RateLimited'
 *           是日配额耗尽；无原生 tools → 工具调用走 deepseek 同款提示词协议
 *
 * 登录捕获：CDP 拉起真实浏览器（generic-login），读 localStorage token + cookie。
 */
import { AdapterLlmError } from '../core/auth.ts'
import type { WebAuth } from '../core/auth.ts'
import { readActiveAuth } from './account-ctx.ts'
import { hasUsableAuth } from '../core/auth.ts'
import {
  ToolCallStreamFilter,
  BoilerplateFilter,
  TranscriptEchoGuard,
  SystemMarkerStreamFilter,
  drainTextPipeline,
  looksLikeUnexecutedToolProgram,
  serializePromptParts,
  type ToolSchemaLike,
} from './protocol-bridge.ts'
import { looksMidSentence } from './looks-mid-sentence.ts'
import { estimateTokens } from './estimate.ts'
import { handleAccountFailure, markAccountLimited } from '../rotation.ts'
import { runtimeConfig } from '../config.ts'
import { activeAccountId } from '../core/accounts.ts'
import { genericBrowserLogin, defaultProfileDir, type ProviderLoginConfig } from './generic-login.ts'
import type {
  ChatCompletionResult,
  NormalizedRequest,
  ProviderModelInfo,
  ProviderStreamEvent,
  WebProxyProvider,
} from '../provider-types.ts'

const QWEN_BASE = 'https://chat.qwen.ai'

/** 默认模型目录（动态拉取失败时的兜底；拉取成功后缓存 10 分钟）。 */
const FALLBACK_MODELS: ProviderModelInfo[] = [
  { id: 'qwen3-max', name: 'Qwen3 Max（网页）', contextWindow: 262_144 },
  { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus（网页）', contextWindow: 262_144 },
  { id: 'qwen3-235b-a22b', name: 'Qwen3 235B A22B（网页）', contextWindow: 131_072 },
]

let modelCache: { at: number; models: ProviderModelInfo[] } | undefined

async function fetchWebModels(token: string): Promise<ProviderModelInfo[] | undefined> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models
  try {
    const resp = await fetch(`${QWEN_BASE}/api/models`, {
      headers: { cookie: `token=${token}` },
    })
    if (!resp.ok) return undefined
    const json = (await resp.json()) as any
    const list = Array.isArray(json?.data) ? json.data : []
    const models = list
      .filter((m: any) => typeof m?.id === 'string')
      .map((m: any) => ({ id: m.id, name: String(m?.name ?? m.id), contextWindow: 262_144 }))
    if (models.length > 0) {
      modelCache = { at: Date.now(), models }
      return models
    }
  } catch {}
  return undefined
}

/** 千问登录配置：CDP 读 localStorage token + cookie。 */
export const qwenLoginConfig: ProviderLoginConfig = {
  provider: 'qwen',
  loginUrl: 'https://chat.qwen.ai/',
  isLoggedIn: async (page) => {
    const value = await page.send('Runtime.evaluate', {
      expression: "String(localStorage.getItem('token') || '')",
      returnByValue: true,
    })
    const token = String(value?.result?.value ?? '')
    return token.length > 20 && token.startsWith('ey')
  },
  extract: async (page) => {
    const value = await page.send('Runtime.evaluate', {
      expression: "String(localStorage.getItem('token') || '')",
      returnByValue: true,
    })
    const token = String(value?.result?.value ?? '')
    const ua = await page.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
    const cookies = await page.send('Storage.getCookies', {})
    return {
      token,
      userAgent: String(ua?.result?.value ?? ''),
      cookies: (cookies?.cookies ?? []) as any,
      extraHeaders: {},
    }
  },
}

export class QwenWebProvider implements WebProxyProvider {
  readonly id = 'qwen-web'
  readonly displayName = '通义千问（网页版）'

  async status() {
    const auth = readActiveAuth('qwen')
    if (!hasUsableAuth(auth)) {
      return { loggedIn: false, detail: '尚未登录（点「登录新账号」或粘贴 token）' }
    }
    return { loggedIn: true, ...(auth.user?.display ? { display: auth.user.display } : {}) }
  }

  async login() {
    const outcome = await genericBrowserLogin(qwenLoginConfig)
    if (outcome.ok && outcome.auth) {
      const { commitCapturedAuth } = await import('./account-ctx.ts')
      // 校验身份（拿显示名）
      let display: string | undefined
      try {
        const resp = await fetch(`${QWEN_BASE}/api/v1/auths/`, {
          headers: { cookie: `token=${(outcome.auth as any).token}` },
        })
        if (resp.ok) {
          const user = (await resp.json()) as any
          display = String(user?.name ?? user?.email ?? '') || undefined
        }
      } catch {}
      const normalized = commitCapturedAuth(
        {
          ...(outcome.auth as any),
          ...(display ? { user: { display } } : {}),
          unverified: false,
        } as any,
        'qwen',
      )
      return { ok: true, message: `千问登录成功（${display ?? String((normalized as any).id ?? '')}）` }
    }
    return { ok: false, message: outcome.message }
  }

  async logout() {
    const { clearActiveAuth } = await import('./account-ctx.ts')
    clearActiveAuth('qwen')
    return { ok: true, message: '已退出当前千问账号' }
  }

  models(): ProviderModelInfo[] {
    const auth = readActiveAuth('qwen')
    if (hasUsableAuth(auth)) {
      // 有凭证就尝试同步刷新（失败回落缓存/兜底表）
      void fetchWebModels(auth.token).catch(() => undefined)
      return modelCache?.models ?? FALLBACK_MODELS
    }
    return FALLBACK_MODELS
  }

  async chat(request: NormalizedRequest): Promise<ChatCompletionResult> {
    const auth = readActiveAuth('qwen')
    if (!hasUsableAuth(auth)) {
      throw new AdapterLlmError('尚未登录千问网页版：先在控制台登录。', 'MISSING_CREDENTIAL')
    }
    return { stream: this.chatStream(auth, request) }
  }

  private async *chatStream(auth: WebAuth, request: NormalizedRequest): AsyncGenerator<ProviderStreamEvent> {
    const accountIdAtStart = activeAccountId('qwen')
    try {
      yield* this.streamImpl(auth, request)
    } catch (error: any) {
      const mutedUntilMs = Number.isFinite(error?.mutedUntilMs) ? Number(error.mutedUntilMs) : undefined
      if (mutedUntilMs !== undefined && accountIdAtStart) markAccountLimited(accountIdAtStart, mutedUntilMs, 'qwen')
      const rotation = handleAccountFailure(error, { rotation: runtimeConfig().rotation !== false, provider: 'qwen' })
      if (rotation.switched) {
        // 轮转成功：抛可重试错误，让客户端重发（下一次请求走新账号）
        throw new AdapterLlmError(
          `千问账号不可用，已自动切换到 ${rotation.to?.display ?? rotation.to?.id}；本次请重试`,
          'RATE_LIMIT',
        )
      }
      throw error
    }
  }

  private async *streamImpl(auth: WebAuth, request: NormalizedRequest): AsyncGenerator<ProviderStreamEvent> {
    const token = auth.token
    const cookie = auth.cookie || `token=${token}`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      cookie,
      'user-agent': auth.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      accept: 'text/event-stream',
      origin: QWEN_BASE,
    }

    // 模型解析：请求的 id 原样透传（网页端模型目录动态）；未识别 → qwen3-max
    const modelId = String(request.model ?? 'qwen3-max').startsWith('qwen')
      ? String(request.model)
      : 'qwen3-max'

    // ── 序列化：千问上游无原生多轮 → 复用 deepseek 的转写序列化（历史折叠进 content）──
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    const chatMessages = request.messages.filter((m) => m.role !== 'system')
    const tools: ToolSchemaLike[] = (request.tools ?? [])
      .filter((t) => t?.type === 'function' && t.function?.name)
      .map((t) => ({ name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? {} }))
    const promptParts = serializePromptParts({
      system,
      messages: chatMessages as any,
      tools,
      maxChars: 300_000,
    })
    const prompt = promptParts.full

    // ── 建会话 ──
    const newChatResp = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chatId: '',
        models: [modelId],
        project_id: '',
        timestamp: Math.floor(Date.now() / 1000),
        chat_type: 't2t',
        chat_mode: 'normal',
      }),
      signal: request.signal,
    })
    if (!newChatResp.ok) {
      throw new AdapterLlmError(`千问建会话失败（HTTP ${newChatResp.status}）`, 'SERVER')
    }
    const newChat = (await newChatResp.json()) as any
    const chatId = String(newChat?.data?.id ?? '')
    if (!chatId) throw new AdapterLlmError('千问建会话失败（无 chat id）', 'SERVER')

    // ── 对话（仅流式）──
    const fid = crypto.randomUUID()
    const completionResp = await fetch(`${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
      method: 'POST',
      headers: { ...headers, referer: `${QWEN_BASE}/c/${chatId}` },
      body: JSON.stringify({
        stream: true,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chatId,
        chat_mode: 'normal',
        model: modelId,
        parent_id: null,
        parentId: null,
        messages: [
          {
            id: null,
            fid,
            parentId: null,
            childrenIds: [],
            role: 'user',
            content: prompt,
            user_action: 'chat',
            files: [],
            timestamp: Math.floor(Date.now() / 1000),
            models: [modelId],
            model: '',
            chat_type: 't2t',
            feature_config: {
              output_schema: 'phase',
              thinking_enabled: false,
              research_mode: 'normal',
              auto_thinking: false,
              thinking_mode: 'Auto',
              thinking_format: 'summary',
              auto_search: false,
            },
            extra: { meta: { subChatType: 't2t' } },
            sub_chat_type: 't2t',
          },
        ],
        timestamp: Math.floor(Date.now() / 1000),
      }),
      signal: request.signal,
    })
    if (!completionResp.ok) {
      const text = await completionResp.text().catch(() => '')
      if (text.includes('RGV587_ERROR') || text.includes('captcha')) {
        throw new AdapterLlmError('千问 WAF 挑战（请求体过大或 IP 风控）：缩短输入或稍后重试', 'RATE_LIMIT')
      }
      throw new AdapterLlmError(`千问对话请求失败（HTTP ${completionResp.status}）：${text.slice(0, 200)}`, 'SERVER')
    }

    // ── SSE 解析：OpenAI chunk 风格 + phase 分流 + 候选回答锁定 ──
    const toolFilter = new ToolCallStreamFilter(new Set(tools.map((t) => t.name)))
    const echoGuard = new TranscriptEchoGuard()
    const boilerplate = new BoilerplateFilter()
    const markerFilter = new SystemMarkerStreamFilter()
    let firstIndex: string | null = null
    let outputChars = 0
    let inputTokens = 0
    let outputTokens = 0
    let sawFinish = false

    const reader = completionResp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const lines: string[] = []
    const drain = (): string[] => {
      const out: string[] = []
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        out.push(buffer.slice(0, idx).replace(/\r$/, ''))
        buffer = buffer.slice(idx + 1)
      }
      return out
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      lines.push(...drain())
      for (const line of lines.splice(0)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') {
          sawFinish = sawFinish || payload === '[DONE]'
          continue
        }
        let frame: any
        try {
          frame = JSON.parse(payload)
        } catch {
          continue
        }
        // WAF / 业务错误帧（HTTP 200 包 JSON）
        if (frame?.code === 'RateLimited') {
          throw new AdapterLlmError('千问网页版今日配额已耗尽（RateLimited）', 'RATE_LIMIT')
        }
        if (frame?.code === 'RGV587_ERROR' || String(frame?.detail ?? '').includes('captcha')) {
          throw new AdapterLlmError('千问 WAF 挑战：请稍后重试或更换出口 IP', 'RATE_LIMIT')
        }
        if (frame?.error) {
          throw new AdapterLlmError(`千问返回错误：${JSON.stringify(frame.error).slice(0, 200)}`, 'PROVIDER_ERROR')
        }
        // 多路候选锁定：只认第一次出现的 response_index
        const responseIndex = frame?.choices?.[0] ? String(frame.choices[0].index ?? '0') : null
        if (responseIndex !== null) {
          if (firstIndex === null) firstIndex = responseIndex
          if (responseIndex !== firstIndex) continue
        }
        const delta = frame?.choices?.[0]?.delta
        if (!delta) continue
        const phase = String(delta.phase ?? 'answer')
        const text = String(delta.content ?? '')
        if (!text) {
          if (frame?.usage) {
            inputTokens = Number(frame.usage.input_tokens ?? frame.usage.prompt_tokens ?? inputTokens) || inputTokens
            outputTokens = Number(frame.usage.output_tokens ?? frame.usage.completion_tokens ?? outputTokens) || outputTokens
          }
          continue
        }
        if (phase === 'answer') {
          outputChars += text.length
          const out = toolFilter.push(text)
          const boiled = boilerplate.push(out.text)
          const guarded = echoGuard.push(boiled.text)
          const cleaned = markerFilter.push(guarded.text)
          if (cleaned.text) yield { type: 'text-delta', text: cleaned.text }
          if (out.calls.length > 0) {
            yield { type: 'tool-calls', calls: out.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) }
          }
        } else {
          // think / thinking_summary 都走思考通道
          yield { type: 'reasoning-delta', text }
        }
      }
    }

    // ── 收尾（与 deepseek provider 管线一致）──
    const drained = drainTextPipeline(toolFilter, boilerplate, echoGuard, false)
    const tail = markerFilter.push(drained.text).text + markerFilter.flush().text
    if (tail) yield { type: 'text-delta', text: tail }
    for (const call of drained.calls) {
      yield { type: 'tool-calls', calls: [{ id: call.id, name: call.name, arguments: call.arguments }] }
    }

    yield {
      type: 'usage',
      inputTokens: inputTokens || estimateTokens(prompt),
      outputTokens: outputTokens || Math.ceil(outputChars / 3.2),
    }

    const hadCalls = drained.calls.length > 0
    yield { type: 'finish', reason: hadCalls ? 'tool-calls' : 'stop' }
    void sawFinish
  }
}

// 供登录流程展示 profile 路径（CLI/控制台用）
export { defaultProfileDir }
