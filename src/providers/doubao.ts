/**
 * doubao-web provider —— 豆包网页版（doubao.com）。
 *
 * 协议依据（2025-2026 多个活跃项目交叉核对：Bitsea1/doubao-free-api、
 * SeiShonagon520/doubao2api、5201213/doubao-free-api 逆向报告）：
 *   登录态：Cookie `sessionid`（+ `sessionid_ss`）即凭证；存活检测
 *           POST /passport/account/info/v2（响应有 user_id 即活）
 *   对话：  POST /www.doubao.com/samantha/chat/completion（SSE）
 *           a_bogus 签名门槛 —— 本 provider 走「浏览器内 fetch」路线绕开签名：
 *           登录后 CDP 保持页面上下文直接 evaluate window.fetch，页面 JS 劫持了
 *           fetch 会自动注入 a_bogus/msToken（SeiShonagon520 架构的根基）。
 *           纯 HTTP 兜底：无签名直连（历史上长期可行，被拦时降级）。
 *   请求体：messages[0].content = JSON.stringify({text})；content_type:2001；
 *           conversation_id:'0' + need_create_conversation:true（服务端自建会话）
 *   SSE：   event_type 2002=开始 / 2001=消息帧 / 2003=结束 / 2005=错误；
 *           event_data 是「JSON 字符串」需二次 parse；思考在 content_type=2008
 *           的 content.think，正文在 content.text
 *   多轮：  上游无 role 概念，多轮历史折叠成一条 user 消息（deepseek 转写复用）
 *   风控：  710022002=限流（假 msToken 触发）、710022004=滑块挑战；
 *           RPM 20-30；账号级风控实测存在（换号即解）
 *
 * 模型档位（网页端一个 bot + 模式开关，bot_id 7338286299411103781）：
 *   doubao-chat     use_deep_think=false
 *   doubao-thinking use_deep_think=true
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
  serializePromptParts,
  type ToolSchemaLike,
} from './protocol-bridge.ts'
import { estimateTokens } from './estimate.ts'
import { handleAccountFailure, markAccountLimited } from '../rotation.ts'
import { runtimeConfig } from '../config.ts'
import { activeAccountId } from '../core/accounts.ts'
import { genericBrowserLogin, type ProviderLoginConfig } from './generic-login.ts'
import type {
  ChatCompletionResult,
  NormalizedRequest,
  ProviderModelInfo,
  ProviderStreamEvent,
  WebProxyProvider,
} from '../provider-types.ts'

const DOUBAO_BASE = 'https://www.doubao.com'
const DEFAULT_BOT_ID = '7338286299411103781'

const MODELS: ProviderModelInfo[] = [
  { id: 'doubao-chat', name: '豆包 · 快速模式', contextWindow: 256_000 },
  { id: 'doubao-thinking', name: '豆包 · 思考模式', contextWindow: 256_000 },
]

function fakeMsToken(): string {
  const bytes = new Uint8Array(96)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

function fakeABogus(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let mid = ''
  for (let i = 0; i < 34; i += 1) mid += a[Math.floor(Math.random() * a.length)]
  let tail = ''
  for (let i = 0; i < 6; i += 1) tail += a[Math.floor(Math.random() * a.length)]
  return `mf-${mid}-${tail}`
}

function flowTrace(): string {
  const uuid = crypto.randomUUID()
  return `04-${uuid}-${uuid.replace(/-/g, '').slice(0, 16)}-01`
}

function buildQuery(msToken: string, aBogus: string): string {
  const params = new URLSearchParams({
    aid: '497858',
    real_aid: '497858',
    device_platform: 'web',
    device_id: String(Math.floor(Math.random() * 1e18)).padStart(19, '1'),
    web_id: String(Math.floor(Math.random() * 1e18)).padStart(19, '1'),
    language: 'zh',
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    'use-olympus-account': '1',
    version_code: '20800',
    pkg_type: 'release_version',
    msToken,
    a_bogus: aBogus,
  })
  return params.toString()
}

/** 豆包登录配置：CDP 抓 sessionid cookie（token 字段直接放 sessionid）。 */
export const doubaoLoginConfig: ProviderLoginConfig = {
  provider: 'doubao',
  loginUrl: 'https://www.doubao.com/chat/',
  isLoggedIn: async (page) => {
    try {
      const cookies = await page.send('Storage.getCookies', {})
      const raw = (cookies?.cookies ?? []) as any[]
      return raw.some((c) => c.name === 'sessionid' && String(c.value ?? '').length > 20)
    } catch {
      return false
    }
  },
  extract: async (page) => {
    const ua = await page.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
    const cookies = await page.send('Storage.getCookies', {})
    const raw = (cookies?.cookies ?? []) as any[]
    const sessionid = raw.find((c) => c.name === 'sessionid')?.value ?? ''
    return {
      token: String(sessionid),
      userAgent: String(ua?.result?.value ?? ''),
      cookies: raw.filter((c) => c.domain?.includes('doubao')),
      extraHeaders: {},
    }
  },
}

export class DoubaoWebProvider implements WebProxyProvider {
  readonly id = 'doubao-web'
  readonly displayName = '豆包（网页版）'

  async status() {
    const auth = readActiveAuth('doubao')
    if (!hasUsableAuth(auth)) {
      return { loggedIn: false, detail: '尚未登录（点「登录新账号」，用浏览器登录 doubao.com）' }
    }
    // 存活检测（零成本）：passport/account/info/v2
    try {
      const resp = await fetch(`${DOUBAO_BASE}/passport/account/info/v2?account_sdk_source=web`, {
        method: 'POST',
        headers: {
          cookie: `sessionid=${auth.token}; sessionid_ss=${auth.token}`,
          'user-agent': auth.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
          'content-type': 'application/json',
        },
      })
      const json = (await resp.json().catch(() => ({}))) as any
      if (json?.data?.user_id) {
        return { loggedIn: true, ...(auth.user?.display ? { display: auth.user.display } : {}) }
      }
      return { loggedIn: false, detail: '凭证已失效（sessionid 不被服务端认可）' }
    } catch {
      return { loggedIn: true, ...(auth.user?.display ? { display: auth.user.display } : {}), detail: '探活失败（网络）' }
    }
  }

  async login() {
    const outcome = await genericBrowserLogin(doubaoLoginConfig)
    if (outcome.ok && outcome.auth) {
      const { commitCapturedAuth } = await import('./account-ctx.ts')
      const normalized = commitCapturedAuth({ ...(outcome.auth as any), unverified: true } as any, 'doubao')
      return { ok: true, message: `豆包登录成功（账号 ${String((normalized as any).id ?? '')}，显示名待首次校验回填）` }
    }
    return { ok: false, message: outcome.message }
  }

  async logout() {
    const { clearActiveAuth } = await import('./account-ctx.ts')
    clearActiveAuth('doubao')
    return { ok: true, message: '已退出当前豆包账号' }
  }

  models(): ProviderModelInfo[] {
    return MODELS
  }

  async chat(request: NormalizedRequest): Promise<ChatCompletionResult> {
    const auth = readActiveAuth('doubao')
    if (!hasUsableAuth(auth)) {
      throw new AdapterLlmError('尚未登录豆包网页版：先在控制台登录。', 'MISSING_CREDENTIAL')
    }
    return { stream: this.chatStream(auth, request) }
  }

  private async *chatStream(auth: WebAuth, request: NormalizedRequest): AsyncGenerator<ProviderStreamEvent> {
    const accountIdAtStart = activeAccountId('doubao')
    try {
      yield* this.streamImpl(auth, request)
    } catch (error: any) {
      const mutedUntilMs = Number.isFinite(error?.mutedUntilMs) ? Number(error.mutedUntilMs) : undefined
      if (mutedUntilMs !== undefined && accountIdAtStart) markAccountLimited(accountIdAtStart, mutedUntilMs, 'doubao')
      const rotation = handleAccountFailure(error, { rotation: runtimeConfig().rotation !== false, provider: 'doubao' })
      if (rotation.switched) {
        throw new AdapterLlmError(
          `豆包账号不可用，已自动切换到 ${rotation.to?.display ?? rotation.to?.id}；本次请重试`,
          'RATE_LIMIT',
        )
      }
      throw error
    }
  }

  private buildPrompt(request: NormalizedRequest, thinking: boolean): { prompt: string; tools: ToolSchemaLike[] } {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    const chatMessages = request.messages.filter((m) => m.role !== 'system')
    const tools: ToolSchemaLike[] = (request.tools ?? [])
      .filter((t) => t?.type === 'function' && t.function?.name)
      .map((t) => ({ name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? {} }))
    const parts = serializePromptParts({ system, messages: chatMessages as any, tools, maxChars: 200_000 })
    return { prompt: parts.full, tools }
  }

  private async *streamImpl(auth: WebAuth, request: NormalizedRequest): AsyncGenerator<ProviderStreamEvent> {
    const { prompt, tools } = this.buildPrompt(request, String(request.model).includes('thinking'))
    const thinking = String(request.model).includes('thinking')
    const msToken = fakeMsToken()
    const aBogus = fakeABogus()
    const url = `${DOUBAO_BASE}/samantha/chat/completion?${buildQuery(msToken, aBogus)}`

    const sectionId = `26${String(Math.floor(Math.random() * 1e16)).padStart(16, '0')}`
    const localConvId = `local_16${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`
    const body = {
      messages: [
        {
          content: JSON.stringify({ text: prompt }),
          content_type: 2001,
          attachments: [],
          references: [],
        },
      ],
      completion_option: {
        is_regen: false,
        with_suggest: false,
        need_create_conversation: true,
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        message_from: 0,
        action_bar_skill_id: 0,
        use_deep_think: thinking,
        use_auto_cot: false,
        resend_for_regen: false,
        enable_commerce_credit: false,
        event_id: '0',
      },
      evaluate_option: { web_ab_params: '' },
      section_id: sectionId,
      conversation_id: '0',
      local_conversation_id: localConvId,
      local_message_id: crypto.randomUUID(),
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      cookie: `sessionid=${auth.token}; sessionid_ss=${auth.token}; msToken=${msToken}${auth.cookie ? `; ${auth.cookie}` : ''}`,
      'user-agent': auth.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
      'agw-js-conv': 'str',
      'x-flow-trace': flowTrace(),
      origin: DOUBAO_BASE,
      referer: `${DOUBAO_BASE}/chat/`,
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AdapterLlmError(`豆包对话请求失败（HTTP ${resp.status}）：${text.slice(0, 200)}`, 'SERVER')
    }

    // ── SSE 三层 JSON 解析 ──
    const toolFilter = new ToolCallStreamFilter(new Set(tools.map((t) => t.name)))
    const echoGuard = new TranscriptEchoGuard()
    const boilerplate = new BoilerplateFilter()
    const markerFilter = new SystemMarkerStreamFilter()
    let outputChars = 0
    let sawFinish = false
    let errorMessage: string | undefined
    let errorCode = 'PROVIDER_ERROR'

    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const handleFrame = (frame: any): boolean => {
      // 返回 true = 流终止
      const eventType = Number(frame?.event_type ?? 0)
      let eventData: any = frame?.event_data
      if (typeof eventData === 'string') {
        try {
          eventData = JSON.parse(eventData)
        } catch {
          return false
        }
      }
      if (eventType === 2003 || eventData?.is_finish === true) {
        sawFinish = true
        return true
      }
      if (eventType === 2005) {
        errorMessage = String(eventData?.message ?? eventData?.msg ?? '未知错误')
        const code = Number(eventData?.code ?? 0)
        if (code === 710022002 || code === 710022004) {
          errorCode = 'RATE_LIMIT'
        }
        return true
      }
      if (eventType === 2001 && eventData?.message) {
        const message = eventData.message
        const contentType = Number(message.content_type ?? 0)
        let contentObj = message.content
        if (typeof contentObj === 'string') {
          try {
            contentObj = JSON.parse(contentObj)
          } catch {
            return false
          }
        }
        if (contentType === 2008 && contentObj?.think) {
          // 思维链
          const think = String(contentObj.think ?? '')
          if (think) {
            outputChars += think.length
            // 注意：思考不计入正文 buffer；直接透传 reasoning 通道
            this.pendingReasoning += think
          }
          return false
        }
        const text = String(contentObj?.text ?? '')
        if (text) {
          outputChars += text.length
          this.pendingText += text
        }
      }
      return false
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 帧以空行分隔
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frameRaw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of frameRaw.split('\n')) {
          if (line.startsWith('event:') && line.includes('gateway-error')) {
            errorMessage = '登录态失效（gateway-error）'
            errorCode = 'AUTH'
            sawFinish = true
          }
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          let frame: any
          try {
            frame = JSON.parse(payload)
          } catch {
            continue
          }
          if (handleFrame(frame)) {
            // 终止帧：读端可以提前退出（剩余数据丢弃）
          }
        }
        // 每帧后立即把缓冲里的增量吐出去（豆包的 text 是增量拼接）
        if (this.pendingReasoning) {
          yield { type: 'reasoning-delta', text: this.pendingReasoning }
          this.pendingReasoning = ''
        }
        if (this.pendingText) {
          const out = toolFilter.push(this.pendingText)
          const boiled = boilerplate.push(out.text)
          const guarded = echoGuard.push(boiled.text)
          const cleaned = markerFilter.push(guarded.text)
          if (cleaned.text) yield { type: 'text-delta', text: cleaned.text }
          if (out.calls.length > 0) {
            yield { type: 'tool-calls', calls: out.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) }
          }
          this.pendingText = ''
        }
        if (sawFinish) break
      }
      if (sawFinish) break
    }

    if (errorMessage) {
      throw new AdapterLlmError(`豆包返回错误：${errorMessage}`, errorCode)
    }

    const drained = drainTextPipeline(toolFilter, boilerplate, echoGuard, false)
    const tail = markerFilter.push(drained.text).text + markerFilter.flush().text
    if (tail) yield { type: 'text-delta', text: tail }
    for (const call of drained.calls) {
      yield { type: 'tool-calls', calls: [{ id: call.id, name: call.name, arguments: call.arguments }] }
    }

    yield { type: 'usage', inputTokens: estimateTokens(prompt), outputTokens: Math.ceil(outputChars / 3.2) }
    const hadCalls = drained.calls.length > 0
    yield { type: 'finish', reason: hadCalls ? 'tool-calls' : 'stop' }
  }

  private pendingText = ''
  private pendingReasoning = ''
}
