/**
 * OpenAI 兼容 HTTP 服务器（node:http，零依赖）。
 *
 * 路由：
 *   GET  /v1/models                     → provider 模型目录（含登录状态头）
 *   POST /v1/chat/completions           → 主对话（流式 SSE / 非流式 JSON）
 *   GET  /admin/status                  → 登录状态（JSON）
 *   POST /admin/login                   → 触发浏览器登录（CDP）
 *   POST /admin/logout                  → 清当前账号
 *   GET  /healthz                       → 探活
 *
 * 设计要点：
 *  - 客户端断开（request 'close'）必须 AbortController 传递到底 —— 网页端那边的
 *    临时会话才不会漏删（webapi 的 finally 依赖 signal）。
 *  - 流式下每 15s 发一个 SSE comment（`: keep-alive`），防客户端/代理空闲超时；
 *    长回答（>60s 网页端上限）期间 ZCode 不会判死。
 *  - 错误映射：AdapterLlmError.code → OpenAI error 对象；重试语义经 `retryable`
 *    传给客户端（OpenAI 协议没有标准字段，放在 error 对象上供 ZCode 读取）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AdapterLlmError } from '../core/auth.ts'
import { listProviderIds, createProvider } from '../registry.ts'
import {
  readProxyConfig,
  writeProxyConfig,
  runtimeConfig,
  invalidateRuntimeConfig,
  DEFAULT_PORT,
  type ProxyConfig,
} from '../config.ts'
import { normalizeChatRequest } from './normalize.ts'
import { newChunkState, eventToChunks, aggregateResponse } from './openai-format.ts'
import type { ProviderStreamEvent } from '../provider-types.ts'

const KEEP_ALIVE_MS = 15_000

/**
 * CORS 头 —— Tauri 窗口的页面源是 tauri://localhost，它向 127.0.0.1:8787 的 fetch
 * 是**跨域**请求：没有这组头，WebView2 会把响应拦在浏览器侧（UI 显示"服务未响应"，
 * 而服务端日志一切正常 —— curl 测不出来，因为 curl 不执行 CORS 检查，实测 19:40）。
 * 本服务只监听本机，允许任意源是合理的。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
}

function applyCors(res: ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value)
}

export interface ServerHandle {
  port: number
  host: string
  close(): Promise<void>
}

export async function startServer(config: ProxyConfig = readProxyConfig()): Promise<ServerHandle> {
  const server = createServer((req, res) => {
    applyCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    void route(req, res, config).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      try {
        res.end(JSON.stringify({ error: { message: String(error?.message ?? error), type: 'internal_error' } }))
      } catch {}
    })
  })

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : config.port
  const handle: ServerHandle = {
    port: boundPort,
    host: config.host,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
  return handle
}

function authorize(req: IncomingMessage, config: ProxyConfig): boolean {
  if (!config.apiKey) return true
  const header = req.headers.authorization ?? ''
  return header === `Bearer ${config.apiKey}`
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function errorPayload(message: string, code: string, status: number, retryable?: boolean, retryAfterMs?: number) {
  return {
    error: {
      message,
      type: code === 'RATE_LIMIT' ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
      ...(retryable !== undefined ? { retryable } : {}),
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    },
  }
}

async function route(req: IncomingMessage, res: ServerResponse, config: ProxyConfig): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  // apiKey 以**磁盘上的当前值**为准（控制台改完立即生效，不用重启 sidecar）。
  const live = runtimeConfig()

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true, enabled: live.enabled !== false, port: config.port })
    return
  }
  // apiKey 门禁只保护 /v1/*（给外部客户端用）。/admin/* 是控制台自己的管理面：
  // 要求它带 key 会把用户锁在门外（实测 apiKey 一设，账号库/状态全 401 → 界面显示"没了"）。
  // 管理面仍限制**仅本机**访问，配合 host=127.0.0.1 的双重约束。
  const isAdmin = path.startsWith('/admin/')
  if (!isAdmin && !authorize(req, live)) {
    sendJson(res, 401, errorPayload('无效的 API key（控制台「服务设置」里配置）', 'UNAUTHORIZED', 401))
    return
  }
  if (isAdmin) {
    const remote = req.socket.remoteAddress ?? ''
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!local) {
      sendJson(res, 403, errorPayload('管理面仅限本机访问', 'FORBIDDEN', 403))
      return
    }
  }

  // ── 管理面 ──
  if (path === '/admin/status' && req.method === 'GET') {
    const entries = await Promise.all(
      listProviderIds().map(async (id) => [id, await createProvider(id).status()]),
    )
    sendJson(res, 200, { providers: Object.fromEntries(entries) })
    return
  }
  if (path === '/admin/login' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek-web'
    const provider = createProvider(providerId)
    sendJson(res, 200, await provider.login())
    return
  }
  if (path === '/admin/login' && req.method === 'GET') {
    sendJson(res, 405, errorPayload('登录接口需要 POST（UI 应自动使用 POST；看到此错误说明前端版本过旧，请重启应用）', 'METHOD_NOT_ALLOWED', 405))
    return
  }
  if (path === '/admin/logout' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek-web'
    const provider = createProvider(providerId)
    sendJson(res, 200, await provider.logout())
    return
  }
  // ── 账号库 ──
  if (path === '/admin/accounts' && req.method === 'GET') {
    const { listAccounts, activeAccountId } = await import('../core/accounts.ts')
    const providerId = url.searchParams.get('provider') ?? 'deepseek'
    const now = Date.now()
    const accounts = (listAccounts(providerId) as any[]).map((account) => ({
      id: account.id,
      display: account.user?.display ?? account.label ?? account.id,
      label: account.label ?? null,
      groupId: account.groupId ?? null,
      capturedAt: account.capturedAt ?? null,
      lastVerifiedAt: account.lastVerifiedAt,
      // 受限状态：带解除时间戳（客户端算倒计时）；已过期的在列表读取时直接当无限制
      limit:
        account.limit && account.limit.untilMs > now
          ? {
              untilMs: account.limit.untilMs,
              remainingMs: account.limit.untilMs - now,
              // 原因：muted=封号（user is muted）/ throttled=频控 / auth=登录态失效
              reason: (account.limit as any).reason ?? 'muted',
            }
          : null,
      active: account.id === activeAccountId(providerId),
    }))
    sendJson(res, 200, { accounts })
    return
  }
  if (path === '/admin/accounts/switch' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { setActiveAccount } = await import('../core/accounts.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    const okSwitch = typeof body.id === 'string' && setActiveAccount(String(body.id), providerId)
    sendJson(res, okSwitch ? 200 : 400, okSwitch ? { ok: true } : { ok: false, message: '账号不存在' })
    return
  }
  if (path === '/admin/accounts/remove' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { removeAccount } = await import('../core/accounts.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    const removed = typeof body.id === 'string' && removeAccount(String(body.id), providerId)
    sendJson(res, removed ? 200 : 400, removed ? { ok: true } : { ok: false, message: '账号不存在' })
    return
  }
  if (path === '/admin/accounts/verify' && req.method === 'POST') {
    // 校验全部：串行探活（零额度），刷新登录态 + 清除已恢复的失败标记
    const { listAccounts } = await import('../core/accounts.ts')
    const { validateAuth } = await import('../core/webapi.ts')
    const providerId = url.searchParams.get('provider') ?? 'deepseek'
    const results: Array<{ id: string; ok: boolean; mutedUntilMs?: number }> = []
    for (const account of listAccounts(providerId) as any[]) {
      try {
        const verdict = await validateAuth(account)
        results.push({ id: account.id, ok: verdict.ok === true })
      } catch (error: any) {
        const until = Number(error?.mutedUntilMs)
        results.push({ id: account.id, ok: false, ...(Number.isFinite(until) ? { mutedUntilMs: until } : {}) })
      }
    }
    sendJson(res, 200, { results })
    return
  }

  // ── 服务设置（端口 / API key / 启用开关 / 轮转）──
  if (path === '/admin/config' && req.method === 'GET') {
    const current = runtimeConfig()
    sendJson(res, 200, {
      ...current,
      // apiKey 回显掩码：控制台只需要知道「有没有设」，不需要拿到明文。
      apiKey: current.apiKey ? `****${String(current.apiKey).slice(-4)}` : '',
      apiKeySet: Boolean(current.apiKey),
      runningPort: config.port,
      runningHost: config.host,
      defaultPort: DEFAULT_PORT,
    })
    return
  }
  if (path === '/admin/config' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const next: ProxyConfig = { ...runtimeConfig() }
    let needsRestart = false
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled
    if (typeof body.rotation === 'boolean') next.rotation = body.rotation
    if (typeof body.apiKey === 'string') {
      const key = body.apiKey.trim()
      // 空串 = 清除门禁；掩码值 = 用户没改动，保持原样。
      // ⚠️ 含 '*' 的一律拒绝：掩码被误编辑后（如 '****111'）绝不能当真 key 存进去——
      // 实测曾把 '1111' 截成 '111'，用户看到的是"保存后 key 变了"。
      if (key === '') {
        delete next.apiKey
      } else if (key.includes('*')) {
        // 视为「未修改」，保留磁盘原值（不报错，避免打断用户操作）
      } else {
        next.apiKey = key
      }
    }
    if (body.port !== undefined) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        sendJson(res, 400, errorPayload('端口必须是 1024~65535 之间的整数', 'BAD_REQUEST', 400))
        return
      }
      if (port !== config.port) needsRestart = true
      next.port = port
    }
    if (typeof body.host === 'string' && body.host.trim()) {
      const host = body.host.trim()
      if (host !== config.host) needsRestart = true
      next.host = host
    }
    writeProxyConfig(next)
    invalidateRuntimeConfig()
    sendJson(res, 200, { ok: true, needsRestart, config: { ...next, apiKey: next.apiKey ? '****' : '' } })
    return
  }

  // ── 账号分组 ──
  if (path === '/admin/groups' && req.method === 'GET') {
    const { listAccounts, activeAccountId } = await import('../core/accounts.ts')
    const { readGroups, partitionByGroup } = await import('../core/account-groups.ts')
    const providerId = url.searchParams.get('provider') ?? 'deepseek'
    const groups = readGroups(providerId)
    const accounts = listAccounts(providerId) as any[]
    const sections = partitionByGroup(
      accounts.map((account) => ({
        id: account.id,
        groupId: account.groupId,
        display: account.user?.display ?? account.label ?? account.id,
        label: account.label,
        active: account.id === activeAccountId(providerId),
      })),
      groups,
      activeAccountId(providerId),
    )
    sendJson(res, 200, { groups, sections })
    return
  }
  if (path === '/admin/groups/create' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { readGroups, writeGroups, createGroup } = await import('../core/account-groups.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    const result = createGroup(readGroups(providerId), body.name)
    if (result.error) {
      sendJson(res, 400, { ok: false, message: result.error })
      return
    }
    writeGroups(result.list, providerId)
    sendJson(res, 200, { ok: true, group: result.group })
    return
  }
  if (path === '/admin/groups/rename' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { readGroups, writeGroups, renameGroup } = await import('../core/account-groups.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    const result = renameGroup(readGroups(providerId), String(body.id ?? ''), body.name)
    if (result.error) {
      sendJson(res, 400, { ok: false, message: result.error })
      return
    }
    writeGroups(result.list, providerId)
    sendJson(res, 200, { ok: true })
    return
  }
  if (path === '/admin/groups/remove' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { readGroups, writeGroups, removeGroup } = await import('../core/account-groups.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    // 只删组定义 —— 账号记录里的 groupId 变悬挂指针，一律落回「未分组」，**账号一个不删**。
    writeGroups(removeGroup(readGroups(providerId), String(body.id ?? '')), providerId)
    sendJson(res, 200, { ok: true })
    return
  }
  if (path === '/admin/accounts/group' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { updateAccount } = await import('../core/accounts.ts')
    const { readGroups } = await import('../core/account-groups.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    const groupId = typeof body.groupId === 'string' ? body.groupId : ''
    // 指向不存在的组 = 等同于「移出分组」（不留悬挂指针，界面立刻正确）
    const known = readGroups(providerId).some((group) => group.id === groupId)
    const updated = updateAccount(String(body.id ?? ''), { groupId: known ? groupId : undefined } as any, providerId)
    sendJson(res, updated ? 200 : 400, updated ? { ok: true } : { ok: false, message: '账号不存在' })
    return
  }
  if (path === '/admin/accounts/label' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const { updateAccount } = await import('../core/accounts.ts')
    const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'deepseek'
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) : ''
    const updated = updateAccount(String(body.id ?? ''), { label: label || undefined } as any, providerId)
    sendJson(res, updated ? 200 : 400, updated ? { ok: true } : { ok: false, message: '账号不存在' })
    return
  }

  // ── OpenAI 兼容面 ──
  if (path === '/v1/models' && req.method === 'GET') {
    const data = []
    for (const id of listProviderIds()) {
      const provider = createProvider(id)
      const status = await provider.status()
      for (const model of provider.models()) {
        data.push({
          id: model.id,
          object: 'model',
          owned_by: id,
          context_window: model.contextWindow,
          x_logged_in: status.loggedIn,
        })
      }
    }
    sendJson(res, 200, { object: 'list', data })
    return
  }
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    await handleChat(req, res, config)
    return
  }

  sendJson(res, 404, errorPayload(`未知路由 ${req.method} ${path}`, 'NOT_FOUND', 404))
}

async function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new Error('请求体超过 64MB 上限')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** 按请求模型名路由到 provider：qwen* → qwen-web，doubao* → doubao-web，其余 deepseek。 */
function resolveProviderId(model: string): string {
  const m = String(model ?? '').toLowerCase()
  if (m.startsWith('qwen')) return 'qwen-web'
  if (m.startsWith('doubao')) return 'doubao-web'
  return 'deepseek-web'
}

async function handleChat(req: IncomingMessage, res: ServerResponse, config: ProxyConfig): Promise<void> {
  const controller = new AbortController()
  // ⚠️ 客户端断开的正确信号是 **res 的 close 且响应未写完** —— req 的 close 在
  // 「请求体读完」时也会触发（Node 语义），误用会把正常请求中途取消（实测：非流式
  // 首测 502「在闸门等待中被取消」就是这个原因）。
  const onClientGone = () => {
    if (!res.writableEnded) controller.abort(new AdapterLlmError('客户端已断开', 'ABORTED'))
  }
  res.on('close', onClientGone)

  let body: any
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch (error: any) {
    sendJson(res, 400, errorPayload(`请求体不是合法 JSON：${error?.message ?? error}`, 'BAD_REQUEST', 400))
    return
  }

  const normalized = normalizeChatRequest(body, controller.signal)
  const provider = createProvider(
    typeof body?.x_provider === 'string' ? body.x_provider : resolveProviderId(normalized.model),
  )
  let result
  try {
    result = await provider.chat(normalized)
  } catch (error: any) {
    const code = error instanceof AdapterLlmError ? String(error.code) : 'PROVIDER_ERROR'
    const status = code === 'MISSING_CREDENTIAL' ? 401 : code === 'RATE_LIMIT' ? 429 : 502
    sendJson(
      res,
      status,
      errorPayload(
        String(error?.message ?? error),
        code,
        status,
        code !== 'MISSING_CREDENTIAL',
        (error as any)?.providerRetryAfterMs,
      ),
    )
    return
  }

  if (normalized.stream) {
    await streamResponse(res, state0(normalized.model), result.stream, controller)
  } else {
    const collected: ProviderStreamEvent[] = []
    try {
      for await (const event of result.stream) collected.push(event)
    } catch (error: any) {
      const code = error instanceof AdapterLlmError ? String(error.code) : 'PROVIDER_ERROR'
      const status = code === 'MISSING_CREDENTIAL' ? 401 : code === 'RATE_LIMIT' ? 429 : 502
      sendJson(res, status, errorPayload(String(error?.message ?? error), code, status))
      return
    }
    sendJson(res, 200, aggregateResponse(newChunkState(normalized.model), collected))
  }
}

function state0(model: string) {
  return newChunkState(model)
}

async function streamResponse(
  res: ServerResponse,
  state: ReturnType<typeof newChunkState>,
  stream: AsyncGenerator<ProviderStreamEvent>,
  controller: AbortController,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n')
    } catch {}
  }, KEEP_ALIVE_MS)
  keepAlive.unref?.()
  try {
    for await (const event of stream) {
      for (const frame of eventToChunks(state, event)) {
        if (!res.write(frame)) {
          // 背压：等一次 drain 再继续（正常体量下几乎不触发）
          await new Promise<void>((resolve) => res.once('drain', resolve))
        }
      }
      if (controller.signal.aborted) break
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (error: any) {
    // 流中途抛错：按 OpenAI 语义补一个 error 帧再收口（客户端能看到失败原因）
    const code = error instanceof AdapterLlmError ? String(error.code) : 'PROVIDER_ERROR'
    const frame = `data: ${JSON.stringify({
      error: { message: String(error?.message ?? error), code },
    })}\n\n`
    try {
      if (!res.writableEnded) {
        res.write(frame)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } catch {}
  } finally {
    clearInterval(keepAlive)
  }
}
