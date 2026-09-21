/**
 * provider 管线离线测试：注入假 SSE 流（含工具调用标记、句中截断→自动续写），
 * 验证 DSH 协议管线在反代形态下行为等价。
 */
import assert from 'node:assert/strict'
import { DeepseekWebProvider } from '../src/providers/deepseek.ts'
import { serializePromptParts } from '../src/providers/protocol-bridge.ts'

let n = 0
function ok(cond, name) {
  assert.ok(cond, name)
  n += 1
}

const fakeAuth = {
  token: 'test-token',
  cookie: 'a=b',
  userAgent: 'test-ua',
  user: { display: ' tester' },
}

/** 假网页端流：第一轮吐正文+截断，第二轮（续写）吐剩余部分。 */
function makeFakeStream(script) {
  return async function* (auth, params) {
    const round = script.rounds[script.callIndex] ?? script.rounds[script.rounds.length - 1]
    script.callIndex += 1
    script.lastParams = params
    for (const item of round) yield item
  }
}

// ── 纯文本对话（无工具）：一轮完成 ──
{
  const script = { callIndex: 0, rounds: [[
    { kind: 'text', text: '你好，' },
    { kind: 'text', text: '世界！' },
    { kind: 'finish', reason: 'FINISHED' },
  ]] }
  const provider = new DeepseekWebProvider({
    streamCompletion: makeFakeStream(script),
    config: { autoContinue: true, maxContinuations: 2 },
  })
  const { stream } = await provider.chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: '打个招呼' }] }],
  })
  const events = []
  for await (const event of stream) events.push(event)
  const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')
  ok(text.includes('你好，世界！'), `正文完整（实际：${JSON.stringify(text)}）`)
  const finish = events.find((e) => e.type === 'finish')
  ok(finish?.reason === 'stop', `finish=stop（实际：${finish?.reason}）`)
  ok(script.callIndex === 1, `只发了一轮（实际 ${script.callIndex}）`)
  const usage = events.find((e) => e.type === 'usage')
  ok(usage && usage.outputTokens > 0, 'usage 有产出')
}

// ── 工具调用：模型吐 {"tool_calls":[...]} → 管线接住转 tool-calls 事件 ──
{
  const script = { callIndex: 0, rounds: [[
    { kind: 'text', text: '我来读取文件。\n{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}' },
    { kind: 'finish', reason: 'FINISHED' },
  ]] }
  const provider = new DeepseekWebProvider({
    streamCompletion: makeFakeStream(script),
    config: { autoContinue: true },
  })
  const { stream } = await provider.chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: '读文件' }] }],
    tools: [{ type: 'function', function: { name: 'read_file', description: '读', parameters: { type: 'object' } } }],
  })
  const events = []
  for await (const event of stream) events.push(event)
  const calls = events.filter((e) => e.type === 'tool-calls').flatMap((e) => e.calls)
  ok(calls.length === 1, `工具调用接住（实际 ${calls.length}）`)
  if (calls.length === 1) {
    ok(calls[0].name === 'read_file', `工具名（实际 ${calls[0].name}）`)
    ok(JSON.parse(calls[0].arguments).path === 'a.txt', '参数 JSON 正确')
  }
  const finish = events.find((e) => e.type === 'finish')
  ok(finish?.reason === 'tool-calls', `finish=tool-calls（实际：${finish?.reason}）`)
}

// ── 自动续写：第一轮句中截断（有 FINISHED 但以逗号收尾）→ 第二轮接上 ──
{
  const script = { callIndex: 0, rounds: [
    [
      { kind: 'text', text: '第一段讲完了故事的开端、人物与背景设定，也交代了主角一行人此行的目的与沿途将要面对的重重考验，' },
      { kind: 'finish', reason: 'FINISHED' },
    ],
    [
      { kind: 'text', text: '然后是第二段。' },
      { kind: 'finish', reason: 'FINISHED' },
    ],
  ] }
  const provider = new DeepseekWebProvider({
    streamCompletion: makeFakeStream(script),
    config: { autoContinue: true, maxContinuations: 2 },
  })
  const { stream } = await provider.chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: '讲个长故事' }] }],
  })
  const events = []
  for await (const event of stream) events.push(event)
  const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')
  ok(text.includes('主角一行人此行的目的与沿途将要面对的重重考验，'), '第一轮内容在')
  ok(text.includes('然后是第二段。'), '续写内容在')
  ok(script.callIndex === 2, `触发续写共两轮（实际 ${script.callIndex}）`)
  // 续写轮 prompt 必须带上一轮的 assistant 输出 + 继续指令
  const lastPrompt = script.lastParams?.prompt ?? ''
  ok(lastPrompt.includes('主角一行人此行的目的与沿途将要面对的重重考验，'), '续写 prompt 含上轮输出')
}

// ── 序列化含工具目录与历史 ──
{
  const parts = serializePromptParts({
    system: '你是助手',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
    tools: [{ name: 't1', description: 'tool one', parameters: { type: 'object' } }],
    maxChars: 120_000,
  })
  ok(parts.full.includes('你是助手'), 'system 在头部')
  ok(parts.full.includes('### t1'), '工具目录在头部')
  ok(parts.full.includes('User: hi'), 'user 转写')
  ok(parts.full.includes('Assistant: hello'), 'assistant 转写')
}

// ── 未登录 → MISSING_CREDENTIAL ──
process.env.DSWEB_PROXY_HOME = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') + '.tmp-home-' + Date.now()
{
  const provider = new DeepseekWebProvider({ streamCompletion: async function* () {} })
  let threw
  try {
    await provider.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
  } catch (error) {
    threw = error
  }
  ok(threw && String(threw.code) === 'MISSING_CREDENTIAL', `未登录报 MISSING_CREDENTIAL（实际 ${threw?.code}）`)
}

console.log(`provider-fake-stream: ${n} assertions passed`)
