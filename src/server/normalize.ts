/**
 * OpenAI 消息归一化 —— 把 chat.completions 请求的 messages/tools 转成
 * DSH protocol.ts 能直接吃的块状形态。
 *
 * 转写规则（与 DSH 插件的消息语义逐项对齐）：
 *   system            → serializePrompt 的 `system` 参数（多条合并）
 *   user(text)        → content: [{ type:'text', text }]
 *   user(image_url)   → 图片不进转写块（collectImageRefs 认 attachment 字段）；
 *                       provider 单独取 data URL 上传，转写里保留文本部分
 *   assistant         → content 文本 + tool_calls 块 [{ type:'tool-call', id, name, arguments }]
 *   tool              → content: [{ type:'tool-result', toolCallId, content:[{type:'text',text}], isError }]
 */
import type { NormalizedRequest, OpenAIMessage, OpenAITool } from '../provider-types.ts'

type NormalizedRole = 'system' | 'user' | 'assistant'

export interface NormalizeResult {
  model: string
  messages: Array<{ role: NormalizedRole; content: Array<Record<string, unknown>> }>
  tools: OpenAITool[]
  stream: boolean
  signal?: AbortSignal
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('')
  }
  return ''
}

export function normalizeChatRequest(body: any, signal?: AbortSignal): NormalizeResult {
  const messages: NormalizeResult['messages'] = []
  for (const message of (body?.messages ?? []) as OpenAIMessage[]) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || (message.role as string) === 'developer') {
      const text = textContent(message.content)
      if (text.trim()) {
        // system 消息仍走独立条目（serializePrompt 会把第一条并进固定头）
        messages.push({ role: 'system', content: [{ type: 'text', text }] })
      }
      continue
    }
    if (message.role === 'user') {
      const blocks: Array<Record<string, unknown>> = []
      const text = textContent(message.content)
      if (text.trim()) blocks.push({ type: 'text', text })
      // 图片块保留 image_url 占位（serializePrompt 的 blockImageMarks 不认它 → 不产生标记；
      // provider 的 collectOpenAIImages 会从原始请求取字节上传。这里塞一个空 attachment
      // 块没有意义 —— 转写里的图片感知由 provider 上传后的 ref_file_ids 承担。）
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'image_url') {
            // 文本占位让模型知道这里有一张图（真实字节由 ref_file_ids 附上）
            blocks.push({ type: 'text', text: '[image attached]' })
          }
        }
      }
      messages.push({ role: 'user', content: blocks })
      continue
    }
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      const text = textContent(message.content)
      if (text.trim()) blocks.push({ type: 'text', text })
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool-call',
          id: String(call.id ?? ''),
          name: String(call.function?.name ?? ''),
          arguments: String(call.function?.arguments ?? '{}'),
        })
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    if (message.role === 'tool') {
      const body = textContent(message.content) || '(no output)'
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: String(message.tool_call_id ?? ''),
            content: [{ type: 'text', text: body }],
          },
        ],
      })
      continue
    }
  }
  const tools = ((body?.tools ?? []) as OpenAITool[]).filter(
    (tool) => tool?.type === 'function' && typeof tool.function?.name === 'string',
  )
  return {
    model: String(body?.model ?? 'deepseek-chat'),
    messages,
    tools,
    stream: body?.stream !== false,
    signal,
  }
}
