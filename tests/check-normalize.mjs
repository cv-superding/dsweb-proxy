/**
 * OpenAI 消息归一化单测：system/user/assistant/tool → DSH 块状形态。
 */
import assert from 'node:assert/strict'
import { normalizeChatRequest } from '../src/server/normalize.ts'

let n = 0
function ok(cond, name) {
  assert.ok(cond, name)
  n += 1
}

{
  const result = normalizeChatRequest({
    model: 'deepseek-reasoner',
    stream: false,
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '结果42' },
      { role: 'user', content: [{ type: 'text', text: '带图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] },
    ],
  })
  ok(result.model === 'deepseek-reasoner', 'model 透传')
  ok(result.stream === false, 'stream 标志')
  ok(result.messages.length === 5, '消息条数')
  ok(result.messages[0].role === 'system' && result.messages[0].content[0].text === '你是助手', 'system 条目')
  ok(result.messages[1].content[0].type === 'text', 'user 文本块')
  const assistant = result.messages[2]
  ok(assistant.content.some((b) => b.type === 'tool-call' && b.name === 'f' && b.arguments === '{"a":1}'), 'assistant tool-call 块')
  const tool = result.messages[3]
  ok(tool.role === 'user', 'tool 消息折叠成 user')
  ok(tool.content[0].type === 'tool-result' && tool.content[0].toolCallId === 'c1', 'tool-result 块')
  const withImage = result.messages[4]
  ok(withImage.content.some((b) => b.text === '[image attached]'), '图片占位标记进转写')
}

// tools 过滤：非 function 类型的丢弃
{
  const result = normalizeChatRequest({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'ok_tool', description: 'd', parameters: { type: 'object' } } },
      { type: 'web_search', function: {} },
    ],
  })
  ok(result.tools.length === 1 && result.tools[0].function.name === 'ok_tool', '只保留 function 工具')
}

// developer 角色（OpenAI 新规范）当 system 处理
{
  const result = normalizeChatRequest({
    messages: [{ role: 'developer', content: '策略' }],
  })
  ok(result.messages.length === 1 && result.messages[0].role === 'system', 'developer → system')
}

console.log(`normalize: ${n} assertions passed`)
