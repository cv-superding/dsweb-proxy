/**
 * Provider 抽象 —— 多厂商反代的核心接口。
 *
 * 设计约束（与 DSH 插件的教训一致）：
 *  - 每个厂商只负责「OpenAI 协议 ⇄ 本厂商网页端」这一段翻译；
 *  - HTTP 服务、鉴权、配置加载是 server 层的事，provider 不碰；
 *  - 流式产出统一走 WebStreamEvent（thinking/text/finish/error），server 层负责
 *    把它转成 OpenAI 的 chunk 序列。这样新增豆包/千问/ChatGPT 时只需实现本接口。
 */

/** OpenAI chat.completions 请求里的消息（服务端已做过归一化）。 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  /** assistant 消息上的工具调用（历史回放用）。 */
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  /** tool 角色消息的工具调用 id。 */
  tool_call_id?: string
  name?: string
}

/** OpenAI tools 参数（function 定义）。 */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** 归一化后的完成请求（块状 content —— DSH protocol 的原生形态）。 */
export interface NormalizedRequest {
  /** 归一化后的模型 id（provider 自己再解析档位）。 */
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: Array<Record<string, unknown>> }>
  tools?: OpenAITool[]
  /** 客户端断开/取消信号。 */
  signal?: AbortSignal
}

/**
 * 一次完成的产出流：provider 把厂商事件翻译成统一的内部事件序列。
 * server 层再把这些事件转成 OpenAI 的 SSE chunk（或聚合为非流式响应）。
 */
export type ProviderStreamEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-calls'; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      reasoningTokens?: number
    }
  | {
      type: 'finish'
      reason: 'stop' | 'tool-calls' | 'length' | 'error'
      /** error 时的可重试错误信息（server 据此决定 HTTP 状态码与重试语义）。 */
      error?: { message: string; code: string; retryAfterMs?: number; retryable?: boolean }
    }

export interface ChatCompletionResult {
  stream: AsyncGenerator<ProviderStreamEvent>
}

/** provider 元信息（/v1/models 与 server 日志用）。 */
export interface ProviderModelInfo {
  id: string
  name: string
  contextWindow: number
}

export interface WebProxyProvider {
  /** provider 标识（URL 路径与日志用，如 'deepseek-web'）。 */
  readonly id: string
  readonly displayName: string
  /** 登录状态摘要（/v1/models 旁路与 /admin/status 用）。 */
  status(): Promise<{
    loggedIn: boolean
    display?: string
    detail?: string
  }>
  /** 触发浏览器登录（CDP 捕获）。实现方自己管窗口生命周期。 */
  login(options?: { headless?: boolean }): Promise<{ ok: boolean; message: string }>
  /** 清除登录态。 */
  logout(): Promise<{ ok: boolean; message: string }>
  models(): ProviderModelInfo[]
  chat(request: NormalizedRequest): Promise<ChatCompletionResult>
}

/** 结构化错误（AdapterLlmError 的结构子集 —— 接口层不直接依赖 core 内部类型）。 */
export interface ProxyLlmError extends Error {
  code?: string
  providerRetryAfterMs?: number
}

/** 工具函数：AdapterLlmError → ProviderStreamEvent.finish(error)。 */
export function errorFinish(error: ProxyLlmError): ProviderStreamEvent {
  const code = String((error as any).code ?? 'PROVIDER_ERROR')
  const retryable = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].includes(code)
  return {
    type: 'finish',
    reason: 'error',
    error: {
      message: error.message,
      code,
      ...(Number.isFinite((error as any).providerRetryAfterMs)
        ? { retryAfterMs: (error as any).providerRetryAfterMs }
        : {}),
      retryable,
    },
  }
}
