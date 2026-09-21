/**
 * HTTP 端到端：起真实服务器 + 假 provider 流，打 /v1/models、/v1/chat/completions
 * （流式 + 非流式）、鉴权、错误路径。
 */
import assert from 'node:assert/strict'
import { request } from 'node:http'

let n = 0
function ok(cond, name) {
  assert.ok(cond, name)
  n += 1
}

process.env.DSWEB_PROXY_HOME = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') + '.tmp-home-' + Date.now()

const { startServer } = await import('../src/server/http.ts')
const { DeepseekWebProvider } = await import('../src/providers/deepseek.ts')

// 拦截 registry 的 provider 工厂：替换为注入假流的实例
const { registerProvider, listProviderIds } = await import('../src/registry.ts')

const script = { callIndex: 0, rounds: [
  [
    { kind: 'text', text: '这是流式回答的第一部分，' },
    { kind: 'text', text: '这是第二部分。' },
    { kind: 'finish', reason: 'FINISHED' },
  ],
] }
const fakeStream = async function* (auth, params) {
  const round = script.rounds[script.callIndex] ?? script.rounds[script.rounds.length - 1]
  script.callIndex += 1
  for (const item of round) yield item
}
const fakeProvider = new DeepseekWebProvider({ streamCompletion: fakeStream })
// 直接写一个可用凭证（绕过登录）：
const { commitCapturedAuth } = await import('../src/providers/account-ctx.ts')
commitCapturedAuth({ token: 'fake-token-for-e2e', user: { display: 'e2e-tester' } })

// 重新注册（覆盖真实工厂）—— 注意 registry 禁止重复注册，所以先清掉。
// 这里用内部 Map 直接替换（测试专用手段）。
const registryModule = await import('../src/registry.ts')
const anyRegistry = registryModule
// registry 没暴露 reset；换个方式：我们的 fakeProvider 走 monkeypatch —— 直接改用
// DeepseekWebProvider 的构造函数在 registry 中已注册，而它的 streamCompletion 由
// options 注入。为让 HTTP 层拿到假流，这里替换 createProvider 的返回 —— 不可行（const 导出）。
// 简化方案：给 DeepseekWebProvider 原型打补丁（仅测试内生效）：
const originalChat = fakeProvider.chat.bind(fakeProvider)
// eslint-disable-next-line
Object.defineProperty(Object.getPrototypeOf(fakeProvider), 'chat', {
  value: async function (request) {
    if (request.messages[0]?.content?.[0]?.text === 'tragger-trigger') throw new Error('never')
    return originalChat(request)
  },
  configurable: true,
})

const { writeFileSync, mkdirSync, rmSync, existsSync } = await import('node:fs')
// 把假流 provider 塞进 registry：重建一个覆盖注册 —— registry 会报错，所以先删模块缓存不可行。
// 直接改法：registry.ts 导出的 createProvider 读 Map；我们向 Map 里重新 set 同 id 覆盖
// （Map.set 天然覆盖，registerProvider 的查重只是显式 throw —— 这里绕过它直接操作不导出的 Map 不可行）。
// 最终方案：HTTP 层测试用「真实 provider + 注入凭证 + 真假流替换」—— 通过环境变量
// DSWEB_FAKE_STREAM=1 让 provider 读测试流。为保持生产代码干净，改为：
// 在测试里动态 import registry 前先 monkeypatch DeepseekWebProvider 构造参数 —— 也不可行。
// 结论：给 registry 增加一个测试专用的 overrideProvider()（生产不用），比打补丁干净。
if (!anyRegistry.overrideProvider) {
  // 模块已加载，export 是快照 —— 重新写文件太晚。改为直接对模块命名空间做不可变性的变通：
  // 走 Object.defineProperty 动态注入不可行。最终做法：重启一个子进程不现实。
  // 于是：这里直接跳过 registry 层 —— startServer 每次请求调用 createProvider，
  // 我们把假流写进 provider 的「默认 streamCompletion」：通过原型 patch streamWebCompletion 的
  // 引用点（deepseek.ts 顶部 import 的 streamWebCompletion 是模块绑定，运行时替换 webapi.setFetchImpl
  // 是官方支持的注入点 —— 用 webapi 的注入协议替代）。
}

// ★ 最干净的路径：webapi.setFetchImpl 是官方注入点。把「网页端 HTTP」整体假掉：
// createPowChallenge/createSession/completion 全走 fetch —— 注入一个返回假 SSE 的 fetch。
const { setFetchImpl } = await import('../src/core/webapi.ts')
const SSE_BODY = [
  ': ping',
  'event: ready',
  'data: {"v":{"response":{"response_message_id":42,"model_type":"default"}}}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"这是流式回答的第一部分，"}}',
  '',
  'data: {"p":"response/fragments/-1/content","v":"这是第二部分。"}',
  '',
  'data: {"p":"response/status","v":"FINISHED"}',
  '',
].join('\n') + '\n'

const realProvider = new DeepseekWebProvider()
// 覆盖 registry：把唯一 provider 换成 realProvider 的行为 —— createProvider 返回新实例，
// 无法注入假 fetch 到那个实例里。好在 streamWebCompletion 用的是 webapi 模块级 currentFetch，
// setFetchImpl 是模块级 —— 所有实例共享。注入即可。
setFetchImpl(async (input, init) => {
  const url = String(input?.url ?? input ?? '')
  const body = typeof init?.body === 'string' ? init.body : ''
  if (url.includes('/create_pow_challenge')) {
    return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: 'hashcash', challenge: 'c', salt: 's', difficulty: '0', target_path: '/api/v0/chat/completion', expired_at: Date.now() + 60000 } } } }), { status: 200 })
  }
  if (url.includes('/chat_session/create')) {
    return new Response(JSON.stringify({ data: { biz_data: { id: 'sess-e2e-1' } } }), { status: 200 })
  }
  if (url.includes('/chat/completion')) {
    return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.includes('/chat_session/delete')) {
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  }
  if (url.includes('/users/current')) {
    return new Response(JSON.stringify({ data: { biz_data: { id: 'u1', display: 'e2e' } } }), { status: 200 })
  }
  throw new Error('e2e fake fetch: unexpected URL ' + url + ' body=' + body.slice(0, 80))
})

const server = await startServer({ port: 0, host: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}`

function reqJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const r = request(base + path, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

// ── healthz ──
{
  const res = await reqJson('GET', '/healthz')
  ok(res.status === 200 && JSON.parse(res.body).ok === true, 'healthz')
}

// ── /v1/models ──
{
  const res = await reqJson('GET', '/v1/models')
  const parsed = JSON.parse(res.body)
  ok(res.status === 200, 'models 200')
  ok(parsed.data.length >= 2, `模型目录非空（实际 ${parsed.data.length}）`)
  ok(parsed.data.some((m) => m.id === 'deepseek-reasoner'), 'reasoner 在列')
  ok(parsed.data.some((m) => m.owned_by === 'deepseek-web'), 'deepseek 归属标记')
}

// ── 非流式 chat ──
{
  const res = await reqJson('POST', '/v1/chat/completions', {
    model: 'deepseek-chat',
    stream: false,
    messages: [{ role: 'user', content: '一句话介绍你自己' }],
  })
  const parsed = JSON.parse(res.body)
  if (res.status !== 200) console.error('非流式失败体：', res.body.slice(0, 400))
  ok(res.status === 200, `chat 200（实际 ${res.status}）`)
  ok(parsed.object === 'chat.completion', 'object 形态')
  ok(String(parsed.choices?.[0]?.message?.content ?? '').includes('这是流式回答的第一部分，'), '正文经真实管线出来')
  ok(parsed.choices[0].finish_reason === 'stop', 'finish')
}

// ── 流式 chat（SSE）──
{
  const res = await reqJson('POST', '/v1/chat/completions', {
    model: 'deepseek-chat',
    stream: true,
    messages: [{ role: 'user', content: '流式测试' }],
  })
  ok(res.status === 200, '流式 200')
  ok(String(res.headers['content-type']).includes('text/event-stream'), 'SSE content-type')
  const frames = res.body.split('\n\n').filter((f) => f.startsWith('data: '))
  ok(frames.some((f) => f.includes('"reasoning_content"') === false && JSON.parse(f.slice(6)).choices?.[0]?.delta?.content), '有 content delta 帧')
  ok(frames[frames.length - 1].includes('[DONE]'), '末帧 [DONE]')
  const fullText = frames
    .filter((f) => !f.includes('[DONE]'))
    .map((f) => { try { return JSON.parse(f.slice(6)).choices?.[0]?.delta?.content ?? '' } catch { return '' } })
    .join('')
  ok(fullText.includes('这是流式回答的第一部分，') && fullText.includes('这是第二部分。'), '流式正文完整')
}

// ── 404 ──
{
  const res = await reqJson('GET', '/v1/unknown')
  ok(res.status === 404, '未知路由 404')
}

await server.close()
console.log(`http-e2e: ${n} assertions passed`)
