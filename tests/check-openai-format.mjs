/**
 * OpenAI 格式转换单测：eventToChunks / aggregateResponse。
 */
import assert from 'node:assert/strict'
import { newChunkState, eventToChunks, aggregateResponse } from '../src/server/openai-format.ts'

let n = 0
function ok(cond, name) {
  assert.ok(cond, name)
  n += 1
}

// ── 流式：text delta ──
{
  const state = newChunkState('deepseek-chat')
  const frames = eventToChunks(state, { type: 'text-delta', text: '你好' })
  ok(frames.length === 1, 'text-delta 产一帧')
  ok(frames[0].startsWith('data: '), 'SSE 前缀')
  const parsed = JSON.parse(frames[0].slice(6))
  ok(parsed.choices[0].delta.role === 'assistant', '首 delta 带 role')
  ok(parsed.choices[0].delta.content === '你好', 'content 正确')
  ok(parsed.choices[0].finish_reason === null, '未结束')
  const frames2 = eventToChunks(state, { type: 'text-delta', text: '！' })
  ok(JSON.parse(frames2[0].slice(6)).choices[0].delta.role === undefined, '后续 delta 不重复 role')
}

// ── 流式：reasoning ──
{
  const state = newChunkState('deepseek-reasoner')
  const frames = eventToChunks(state, { type: 'reasoning-delta', text: '思考中' })
  const parsed = JSON.parse(frames[0].slice(6))
  ok(parsed.choices[0].delta.reasoning_content === '思考中', 'reasoning_content 字段')
}

// ── 流式：tool_calls 分槽 ──
{
  const state = newChunkState('deepseek-chat')
  const frames = eventToChunks(state, {
    type: 'tool-calls',
    calls: [
      { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { id: 'call_2', name: 'list_dir', arguments: '{}' },
    ],
  })
  ok(frames.length === 2, '两个调用两帧')
  const first = JSON.parse(frames[0].slice(6)).choices[0].delta.tool_calls[0]
  ok(first.index === 0 && first.id === 'call_1' && first.function.name === 'read_file', '第一槽位')
  const second = JSON.parse(frames[1].slice(6)).choices[0].delta.tool_calls[0]
  ok(second.index === 1 && second.id === 'call_2', '第二槽位递增')
}

// ── 流式：finish ──
{
  const state = newChunkState('deepseek-chat')
  const frames = eventToChunks(state, { type: 'finish', reason: 'tool-calls' })
  ok(JSON.parse(frames[0].slice(6)).choices[0].finish_reason === 'tool-calls', 'finish=tool-calls')
  const frames2 = eventToChunks(state, { type: 'finish', reason: 'error', error: { message: 'x', code: 'EMPTY_RESPONSE' } })
  ok(JSON.parse(frames2[0].slice(6)).choices[0].finish_reason === 'stop', 'error 降级为 stop（错误信息走 error 帧）')
}

// ── 非流式聚合 ──
{
  const state = newChunkState('deepseek-chat')
  const events = [
    { type: 'reasoning-delta', text: '想一下' },
    { type: 'text-delta', text: '答案：' },
    { type: 'text-delta', text: '42' },
    { type: 'tool-calls', calls: [{ id: 'c1', name: 'calc', arguments: '{"x":1}' }] },
    { type: 'usage', inputTokens: 10, outputTokens: 5 },
    { type: 'finish', reason: 'tool-calls' },
  ]
  const response = aggregateResponse(state, events)
  ok(response.object === 'chat.completion', 'object 类型')
  ok(response.choices[0].message.content === '答案：42', '正文聚合')
  ok(response.choices[0].message.reasoning_content === '想一下', '思考聚合')
  ok(response.choices[0].message.tool_calls.length === 1, '工具调用聚合')
  ok(response.choices[0].finish_reason === 'tool-calls', 'finish 原因')
  ok(response.usage.prompt_tokens === 10 && response.usage.completion_tokens === 5, 'usage')
}

console.log(`openai-format: ${n} assertions passed`)
