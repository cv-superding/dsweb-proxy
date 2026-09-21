/**
 * OpenAI 响应构造 —— provider 内部事件 → OpenAI chunk（流式）或完整响应（非流式）。
 *
 * 流式形态（ZCode/主流客户端都按这个消费）：
 *   role chunk → content deltas（text）→ reasoning deltas（reasoning_content，DeepSeek 官方
 *   API 的扩展字段，ZCode 兼容）→ tool_calls delta（按 index 分槽）→ finish chunk → [DONE]
 */
import type { ProviderStreamEvent } from '../provider-types.ts'

export interface ChunkState {
  id: string
  created: number
  model: string
  /** tool_calls 的流式槽位：name 首包发一次，arguments 增量追加。 */
  toolIndex: number
  emittedRole: boolean
}

export function newChunkState(model: string): ChunkState {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    toolIndex: 0,
    emittedRole: false,
  }
}

export function chunkEnvelope(state: ChunkState, delta: Record<string, unknown>, finish?: string | null): string {
  const payload = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finish ?? null,
      },
    ],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 单个事件 → 0..n 个 SSE 帧（含 [DONE] 的不发；[DONE] 由调用方在流末尾统一发）。 */
export function eventToChunks(state: ChunkState, event: ProviderStreamEvent): string[] {
  const frames: string[] = []
  switch (event.type) {
    case 'reasoning-delta': {
      frames.push(
        chunkEnvelope(state, {
          ...(state.emittedRole ? {} : { role: 'assistant' }),
          reasoning_content: event.text,
        }),
      )
      state.emittedRole = true
      break
    }
    case 'text-delta': {
      frames.push(
        chunkEnvelope(state, {
          ...(state.emittedRole ? {} : { role: 'assistant' }),
          content: event.text,
        }),
      )
      state.emittedRole = true
      break
    }
    case 'tool-calls': {
      for (const call of event.calls) {
        frames.push(
          chunkEnvelope(state, {
            tool_calls: [
              {
                index: state.toolIndex,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          }),
        )
        state.toolIndex += 1
        state.emittedRole = true
      }
      break
    }
    case 'usage':
      // usage 由 finish 帧统一携带（stream_options.include_usage 语义）
      break
    case 'finish':
      frames.push(
        chunkEnvelope(
          state,
          {},
          event.reason === 'error' ? 'stop' : event.reason === 'length' ? 'length' : event.reason,
        ),
      )
      break
  }
  return frames
}

/** 非流式：聚合事件 → 完整 chat.completion 对象。 */
export function aggregateResponse(state: ChunkState, events: ProviderStreamEvent[]): Record<string, unknown> {
  let content = ''
  let reasoning = ''
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  let finish: string = 'stop'
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined
  let errorEvent: Extract<ProviderStreamEvent, { type: 'finish' }>['error']
  for (const event of events) {
    if (event.type === 'text-delta') content += event.text
    else if (event.type === 'reasoning-delta') reasoning += event.text
    else if (event.type === 'tool-calls') {
      for (const call of event.calls) {
        toolCalls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })
      }
    } else if (event.type === 'usage') {
      usage = {
        prompt_tokens: event.inputTokens,
        completion_tokens: event.outputTokens,
        total_tokens: event.inputTokens + event.outputTokens,
      }
    } else if (event.type === 'finish') {
      if (event.reason === 'error') errorEvent = event.error
      else finish = event.reason === 'length' ? 'length' : event.reason
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: content || null }
  if (reasoning) (message as any).reasoning_content = reasoning
  if (toolCalls.length > 0) (message as any).tool_calls = toolCalls
  return {
    id: state.id,
    object: 'chat.completion',
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: errorEvent ? 'stop' : finish,
        ...(errorEvent ? { error: { message: errorEvent.message, code: errorEvent.code } } : {}),
      },
    ],
    ...(usage ? { usage } : {}),
  }
}
