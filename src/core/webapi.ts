/**
 * DeepSeek 网页版 (chat.deepseek.com) API 客户端：
 * PoW SHA3 WASM 求解 + chat_session 生命周期 + /chat/completion SSE 流式解析。
 *
 * 协议依据（2026 年多个活跃逆向实现交叉验证）：
 *   POST /api/v0/chat/create_pow_challenge  {target_path} → data.biz_data.challenge
 *   POST /api/v0/chat_session/create        {}            → data.biz_data.chat_session.id
 *   POST /api/v0/chat_session/delete        {chat_session_id}
 *   POST /api/v0/chat/completion            {chat_session_id, parent_message_id:null, prompt,
 *                                            ref_file_ids:[], thinking_enabled, search_enabled,
 *                                            model_type, action:null, preempt:false}
 *   请求头：Authorization: Bearer <token>、Cookie、x-hif-*、x-ds-pow-response
 *   SSE 负载为 patch 流：
 *     {"v":{"response":{...}}}                  完整快照（fragments / content）
 *     {"p":"response/fragments","o":"APPEND","v":{type,content}}
 *     {"p":"response/fragments/-1/content","v":"…"}
 *     {"p":"response/thinking_content","v":"…"} 旧格式：思考直连
 *     {"p":"response/content","v":"…"}          旧格式：正文直连
 *     {"v":"…"} / {"o":"APPEND","v":"…"}        承接上一个 path 的续段
 *     {"p":"response/status","v":"FINISHED"}    状态
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebAuth } from './auth.ts'
import { AdapterLlmError, httpErrorCode, parseRetryAfterMs } from './auth.ts'
// 默认区间来自 gate.ts —— 设置页的滑块边界与这里的默认值必须是**同一份**，否则界面显示的和实际跑的不是一回事。
import {
  DEFAULT_CLEANUP_BATCH,
  DEFAULT_CLEANUP_DELAY_MS,
  DEFAULT_CLEANUP_GAP_MS,
  type CleanupRange,
} from './gate.ts'
// 上下文投喂方式（全量 / 链式增量）——决策是纯函数，见 context-feed.ts 的模块注释。
import { currentContextMode, decideFeed, type ChainState, type FeedDecision, type FeedReason } from './context-feed.ts'

export const DS_BASE = 'https://chat.deepseek.com'

/** PoW 求解器 WASM 的已知默认地址（页面资源捕获失败时兜底）。 */
export const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'

/** 浏览器 UA 兜底（捕获失败时使用）。 */
export const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface DsHeaders {
  [key: string]: string
}

/**
 * 组装一次网页端请求的头。
 * 优先复用登录时捕获的浏览器真实头（extraHeaders），再用最新登录态覆盖
 * authorization/cookie/指纹；user-agent 采用浏览器值（网页端接口需要浏览器指纹），
 * DSH 归属信息通过 `x-deepseek-harness` 头显式声明。
 */
export function buildDsHeaders(auth: WebAuth, referer?: string): DsHeaders {
  const headers: DsHeaders = {
    'user-agent': auth.userAgent || FALLBACK_UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin: DS_BASE,
    referer: referer || `${DS_BASE}/`,
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-app-version': '2.0.0',
    ...(auth.extraHeaders ?? {}),
  }
  headers.authorization = `Bearer ${auth.token}`
  headers['content-type'] = 'application/json'
  headers.origin = DS_BASE
  headers.referer = referer || `${DS_BASE}/`
  headers['user-agent'] = auth.userAgent || headers['user-agent'] || FALLBACK_UA
  headers['x-deepseek-harness'] = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness); provider=deepseek-web'
  // 这两个头由本插件按次生成/捕获，绝不复用快照里的旧值
  delete headers['x-ds-pow-response']
  if (auth.cookie) headers.cookie = auth.cookie
  else delete headers.cookie
  if (auth.hifDliq) headers['x-hif-dliq'] = auth.hifDliq
  if (auth.hifLeim) headers['x-hif-leim'] = auth.hifLeim
  return headers
}

// ── 响应信封（网页端常以 HTTP 200 + 业务错误码返回失败）────────

/** 网页端统一信封：code===0 为成功；非 0 时 msg 是给用户看的诊断。 */
export function envelopeError(json: any): { code: number; msg: string } | undefined {
  if (!json || typeof json !== 'object') return undefined
  const code = (json as any).code
  if (typeof code === 'number' && code !== 0) {
    return { code, msg: String((json as any).msg ?? (json as any).message ?? 'unknown error') }
  }
  // ⚠️ 网页端把**真实业务错误**放在 data.biz_code 里，外层 code 依旧是 0。
  // 只认外层 code 的后果（实测 2026-09-11）：服务端明明说得很清楚
  //   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
  // 却被降级成人人看不懂、而且**不可重试**的
  //   `非流式响应（content-type: application/json）：{...}` + MALFORMED_RESPONSE。
  // 认了 biz_code 之后，既能给出真原因，也能按原因做定向恢复（重建会话重试）。
  const bizCode = (json as any).data?.biz_code
  if (typeof bizCode === 'number' && bizCode !== 0) {
    const bizMsg = (json as any).data?.biz_msg
    const text = bizMsg === undefined || bizMsg === null || bizMsg === '' ? 'unknown error' : String(bizMsg)
    return { code: bizCode, msg: text }
  }
  return undefined
}

/**
 * 账号被临时限制判定（实测 2026-09-11）：
 *   {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted",
 *                     "biz_data":{"is_muted":1,"mute_until":1789173841.894}}}
 * 这是**服务端对账号的限制**（免费网页端对高频自动化调用的静默限流），不是插件 bug：
 * 登录态有效、建会话也成功，只有 completion 被拒。必须把解除时间明确告诉用户，
 * 并且**不要空转重试** —— 否则每一轮都白发请求，还可能延长限制。
 */
export function isMutedError(biz: { code?: number; msg?: string } | undefined): boolean {
  return biz?.code === 5 || /user\s+is\s+muted|account\s+is\s+muted/i.test(String(biz?.msg ?? ''))
}

/** 从响应信封里读出解除限制的时间（ms）；读不到返回 undefined。 */
export function muteUntilMs(json: any): number | undefined {
  const raw = (json as any)?.data?.biz_data?.mute_until
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.round(seconds * 1000)
}

/** 被限制时的用户可读文案（带解除时间）。 */
function mutedMessage(untilMs: number | undefined): string {
  if (untilMs === undefined) {
    return 'DeepSeek 网页端已临时限制本账号（user is muted），未给出解除时间。这期间任何网页模型调用都会失败；请等待解除，或改用官方 API key。'
  }
  const when = new Date(untilMs).toLocaleString('zh-CN', { hour12: false })
  const minutes = Math.max(1, Math.round((untilMs - Date.now()) / 60_000))
  return (
    `DeepSeek 网页端已临时限制本账号（user is muted）：预计 ${when} 解除，约 ${minutes} 分钟后。` +
    '这期间任何网页模型调用都会失败（登录态本身有效、建会话也正常，只有发消息被拒）；' +
    '请等待解除，或改用官方 API key。免费网页端对高频自动化调用会静默限流，刚跑过大量工具步骤的会话尤其容易被限。'
  )
}

/**
 * 「同一账号同时只能生成一条」的并发拒绝（实测 2026-09-11：两个 DSH 窗口共用同一网页账号，
 * 一个正在生成时另一个发请求即得此错：`A message is being generated, please try again later.`）。
 * 它**不是封号**（封号是 `user is muted`），但也无法立刻成功 ——
 * 归为可重试的 RATE_LIMIT，交由 dsh-llm-retry 稍后自动重发，而不是让整轮直接失败。
 */
export function isBusyGenerating(message: string): boolean {
  return /being generated|try again later|请稍后再试|稍后再试|正在生成/i.test(String(message ?? ''))
}

/**
 * 连续节流的状态：被限一次就退避久一点，别在限流窗口里反复撞。
 * （实测 2026-09-11 下午：同一个账号连续被限，5 次重试全落在窗口里 → 整轮失败。）
 */
/**
 * 当前使用的 fetch 实现。
 *
 * 默认是 Node 的全局 fetch（undici）。宿主可以注入 **Electron 的 `net.fetch`** ——
 * 后者走 Chromium 原生网络库，能带来与真实浏览器一致的 TLS / HTTP2 指纹。
 * 为什么在意：实测 Node fetch 与 Chrome 的指纹差异是**结构性**的
 * （JA4 的 h1 vs h2、Node 无 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同）。
 *
 * 注意：Electron 的 utility 进程里 `require('electron')` 只暴露 `net` 与 `systemPreferences`
 * （实测 2026-09-12），所以宿主只能注入 net.fetch，拿不到别的网络相关能力。
 */
let injectedFetch: typeof fetch | undefined

/**
 * 实际发请求用的 fetch —— 刻意做成**每次现取**（`injectedFetch ?? fetch`），
 * 而不是在模块加载那一刻把全局 fetch 固化下来。
 *
 * 原因（2026-09-12 实测踩到）：固化写法会让「模块加载之后再替换 globalThis.fetch」失效 ——
 * 单测正是用这种方式打桩，结果请求绕过了桩件、**真的发到了线上**
 * （拿回一个 INVALID_TOKEN，测试看着在验证错误分类，实际在打网络）。
 */
function activeFetch(input: any, init?: any): Promise<Response> {
  return (injectedFetch ?? fetch)(input, init)
}

/** 注入 fetch 实现；传 undefined 还原为 Node 全局 fetch。 */
export function setFetchImpl(impl?: typeof fetch): void {
  injectedFetch = impl
}

/**
 * 当前生效的 fetch（诊断/检查更新这类**旁路请求**用它，从而与网页端请求走同一个传输层）。
 * 注意它已经做了"每次现取"，直接当 fetch 用即可。
 */
export function currentFetch(input: any, init?: any): Promise<Response> {
  return activeFetch(input, init)
}

/** 当前用的是注入实现还是 Node 原生（诊断用）。 */
export function fetchImplKind(): 'injected' | 'node' {
  return injectedFetch ? 'injected' : 'node'
}

let throttleStreak = 0
let lastThrottleAt = 0

/** 取下一次节流退避（ms）：20s 起、每次翻倍、上限 90s，并加 0~30% 抖动。 */
export function throttleBackoffMs(now: number = Date.now()): number {
  // 超过 5 分钟没被限，认为窗口已过，重新开始计数
  if (now - lastThrottleAt > 5 * 60_000) throttleStreak = 0
  const base = Math.min(20_000 * 2 ** throttleStreak, 90_000)
  const jitter = Math.round(base * 0.3 * Math.random())
  return base + jitter
}

/** 记录一次节流；返回本次应给的退避（ms）。 */
function noteThrottled(now: number = Date.now()): number {
  if (now - lastThrottleAt > 5 * 60_000) throttleStreak = 0
  throttleStreak += 1
  lastThrottleAt = now
  return throttleBackoffMs(now)
}

/**
 * 账号级节流：「发得太频繁」。
 *
 * 实测 2026-09-11 16:11（SSE error 事件，不是 HTTP 429）：
 *   `消息发送过于频繁，请稍后重试`
 * ⚠️ 注意它和上面那条**差一个字**：并发拒绝写的是「请稍后再**试**」，节流写的是「请稍后**重**试」。
 * 之前只匹配前者，于是这条落到 PROVIDER_ERROR（**不可重试**）→ 整轮直接失败、只能手点「继续」。
 *
 * 与 `user is muted`（有明确解除时间）也不是一回事：节流是短时的，退避够久就能过去。
 * 退避给 20s（并发那条只给 5s）：撞得越勤越可能延长限制。
 */
export function isThrottled(message: string): boolean {
  return /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试|限流/i.test(
    String(message ?? ''),
  )
}

/**
 * 会话失效判定：服务端用 biz_msg 表达「这个 chat_session_id 不存在/无效」。
 * 触发场景（实测）：请求发出前会话已被删除（旧版把删除排在建会话之后 1.5s，
 * 而 PoW 求解 + 建连可能超过 1.5s），或服务端自行回收了闲置会话。
 * 这类失败**可以透明恢复**：本插件每次调用都是全新会话、不依赖服务端历史 → 换个会话重发即可。
 */
export function isInvalidSessionError(biz: { code?: number; msg?: string } | undefined): boolean {
  return /invalid\s+chat\s+session|chat\s+session\s+(?:not\s+found|expired|invalid)|chat_session_id[^\p{L}]{0,4}(?:无效|不存在|已过期|非法)|会话.{0,8}(?:无效|不存在|已过期)/iu.test(
    String(biz?.msg ?? ''),
  )
}

/** 业务错误码 → 稳定错误码（40003/40001：授权失败）。 */
function bizErrorCode(code: number): string {
  if (code === 40003 || code === 40001) return 'AUTH'
  if (code === 429) return 'RATE_LIMIT'
  return 'PROVIDER_ERROR'
}

function bizErrorMessage(code: number, msg: string): string {
  if (code === 40003 || code === 40001) {
    return `DeepSeek 网页授权失败：${msg} —— 登录态已过期或无效，请到「设置 → DeepSeek 网页登录」重新登录`
  }
  return `DeepSeek 网页端错误（code ${code}）：${msg}`
}

// ── PoW 求解 ──────────────────────────────────────────────

interface PoWChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: string | number
  expire_at: string | number
  signature: string
}

let wasmModuleCache: { url: string; promise: Promise<WebAssembly.Module> } | null = null
/** 已验证可用/已发现的 WASM 地址（按凭证里记录的原值缓存，避免每次请求都探测）。 */
let resolvedWasmUrl: { key: string; url: string } | null = null

async function readOfficialResource(url: string, max: number, outer?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443') ||
      (parsed.hostname !== 'deepseek.com' && !parsed.hostname.endsWith('.deepseek.com'))) throw new Error('非官方资源地址')
  const signal=outer?AbortSignal.any([outer,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)
  const resp=await activeFetch(parsed.href,{signal,redirect:'error'})
  if(!resp.ok||!resp.body){await resp.body?.cancel();throw new Error(`资源请求失败 HTTP ${resp.status}`)}
  const reader=resp.body.getReader();const chunks:Uint8Array[]=[];let size=0
  try {
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength
      if(size>max)throw new Error('资源超过字节上限');chunks.push(item.value)}
  } finally {try{await reader.cancel()}catch{};reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return bytes
}

async function isReachable(url: string, outer?: AbortSignal): Promise<boolean> {
  if(!checkedWasmUrl(url))return false
  const signal=outer?AbortSignal.any([outer,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000)
  let resp:Response|undefined
  try {resp=await activeFetch(url,{method:'GET',headers:{range:'bytes=0-0'},signal,redirect:'error'});return resp.ok}
  catch {if(outer?.aborted)outer.throwIfAborted();return false}
  finally {try{await resp?.body?.cancel()}catch{}}
}

/** 从网页端首页/JS chunk 里发现当前构建的 sha3 wasm 地址（哈希随版本变化）。 */
async function discoverWasmUrl(signal?: AbortSignal): Promise<string | undefined> {
  const decode = (bytes:Uint8Array)=>new TextDecoder().decode(bytes)
  const find = (text:string,base:string):string|undefined=>{
    for(const match of text.matchAll(/[^"'\s<>]*sha3[_a-z0-9.]*\.wasm/gi)) {
      try{const url=checkedWasmUrl(new URL(match[0],base).href);if(url)return url}catch{}
    }
    return undefined
  }
  try {
    signal?.throwIfAborted()
    const html=decode(await readOfficialResource(`${DS_BASE}/`,2*1024*1024,signal))
    const direct=find(html,`${DS_BASE}/`);if(direct)return direct
    const scripts=[...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].slice(0,8)
    for(const match of scripts){
      signal?.throwIfAborted()
      try{const url=new URL(match[1],`${DS_BASE}/`).href
        const found=find(decode(await readOfficialResource(url,8*1024*1024,signal)),url)
        if(found)return found
      }catch{if(signal?.aborted)signal.throwIfAborted()}
    }
  }catch{if(signal?.aborted)signal.throwIfAborted()}
  return undefined
}

/**
 * 解析可用的 PoW WASM 地址：凭证记录值 → 已知默认值 → 页面发现。
 * 结果按凭证原值缓存一次，避免每个请求都做探测。
 */
export async function resolveWasmUrl(auth: WebAuth, signal?: AbortSignal): Promise<string> {
  const key = auth.wasmUrl || ''
  if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url
  // 凭证里的地址先过白名单：不合法就丢弃（并告警），绝不拿去发请求
  const fromAuth = checkedWasmUrl(auth.wasmUrl)
  if (auth.wasmUrl && !fromAuth) {
    lastWasmUrlRejection = auth.wasmUrl
  }
  const candidates = [fromAuth, checkedWasmUrl(DEFAULT_WASM_URL)].filter((url): url is string => !!url)
  for (const url of candidates) {
    if (await isReachable(url, signal)) {
      resolvedWasmUrl = { key, url }
      return url
    }
  }
  const discovered = checkedWasmUrl(await discoverWasmUrl(signal))
  if (discovered) {
    resolvedWasmUrl = { key, url: discovered }
    return discovered
  }
  // 全都拿不到：宁可带着「地址不合法/找不到」的明确报错失败，也不要退回未校验的地址
  return fromAuth ?? checkedWasmUrl(DEFAULT_WASM_URL) ?? DEFAULT_WASM_URL
}

/**
 * F12（2026-09-12 审计）：PoW WASM 地址的白名单校验。
 *
 * 为什么需要：`auth.wasmUrl` 主要来自**导入的账号备份**，可被构造成任意地址
 * （审计已复现：可打内网 / 云元数据 / file: 协议）。Electron 的 net.fetch 支持的
 * 协议比 Node fetch 更宽，不能把后者的协议限制当成统一边界。
 *
 * 为什么只限到 deepseek.com 而不是写死单个主机：默认地址里带内容哈希
 * （sha3_wasm_bg.7b9ca65ddd.wasm），官方一改就失效；而 `wasmUrl` 实际上**不是**
 * 浏览器抓来的（browser-login 里恒为空），页面发现（discoverWasmUrl）是唯一的
 * 兜底路径。所以保留发现能力，只把「能不能用」收白名单，既挡 SSRF 又留后路。
 */
const MAX_WASM_BYTES = 8 * 1024 * 1024

/** 最近一次被白名单拒绝的凭证 wasmUrl（诊断/单测用；本模块无日志器，留状态而不是打日志）。 */
export let lastWasmUrlRejection: string | undefined

/** 合法则返回规范化后的地址，否则返回 undefined（调用方负责回退并告警）。 */
export function checkedWasmUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  if (url.port && url.port !== '443') return undefined
  const host = url.hostname.toLowerCase()
  // 挡住 169.254.169.254 / localhost / 内网 / 任意第三方，同时容忍未来换 CDN
  if (host !== 'deepseek.com' && !host.endsWith('.deepseek.com')) return undefined
  if (!url.pathname.toLowerCase().endsWith('.wasm')) return undefined
  return url.href
}

async function loadWasmModule(wasmUrl: string): Promise<WebAssembly.Module> {
  const url=checkedWasmUrl(wasmUrl)
  if(!url)throw new Error('非法 WASM 地址')
  if(wasmModuleCache?.url===url)return wasmModuleCache.promise
  const promise=(async()=>WebAssembly.compile(await readOfficialResource(url,MAX_WASM_BYTES)))()
  wasmModuleCache={url,promise}
  promise.catch(()=>{
    if(wasmModuleCache?.promise===promise)wasmModuleCache=null
    if(resolvedWasmUrl?.url===url)resolvedWasmUrl=null
  })
  return promise
}

/**
 * 调用 DeepSeek 的 sha3_wasm_bg 求解 PoW。
 * wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)；
 * prefix = `${salt}_${expire_at}_`；返回 float64 答案（取整）。
 */
async function solvePoW(challenge: PoWChallenge, wasmUrl: string): Promise<number> {
  const module = await loadWasmModule(wasmUrl)
  const instance = await WebAssembly.instantiate(module, { wbg: {} })
  const e = instance.exports as any
  if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
    throw new Error('PoW WASM exports missing (wasm_solve / __wbindgen_export_0 / memory)')
  }
  const encoder = new TextEncoder()
  const cBytes = encoder.encode(challenge.challenge)
  const pBytes = encoder.encode(`${challenge.salt}_${challenge.expire_at}_`)
  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0
  new Uint8Array(e.memory.buffer).set(cBytes, cP)
  new Uint8Array(e.memory.buffer).set(pBytes, pP)
  const sp = e.__wbindgen_add_to_stack_pointer(-16)
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(challenge.difficulty))
  const dv = new DataView(e.memory.buffer)
  const code = dv.getInt32(sp, true)
  const answer = dv.getFloat64(sp + 8, true)
  e.__wbindgen_add_to_stack_pointer(16)
  if (code === 0 || !Number.isFinite(answer) || answer <= 0) throw new Error(`PoW solve failed (code=${code})`)
  return Math.floor(answer)
}

/** 取得一次完成请求的 PoW 响应头值（base64 JSON）。 */
export async function createPowHeader(auth: WebAuth, targetPath: string, signal?: AbortSignal): Promise<string> {
  let resp: Response
  try {
    resp = await activeFetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: buildDsHeaders(auth),
      body: JSON.stringify({ target_path: targetPath }),
      signal,
    })
  } catch (error: any) {
    throw new AdapterLlmError(`DeepSeek PoW challenge request failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }
  const text = await resp.text()
  if (!resp.ok) {
    const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
    throw new AdapterLlmError(
      `DeepSeek PoW challenge failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      httpErrorCode(resp.status),
      { status: resp.status, ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}) },
    )
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new AdapterLlmError('DeepSeek PoW challenge returned non-JSON', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  const biz = envelopeError(json)
  if (biz) {
    throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status })
  }
  const challenge: PoWChallenge | undefined = json?.data?.biz_data?.challenge
  if (!challenge?.challenge || !challenge?.salt || !challenge?.signature) {
    throw new AdapterLlmError(
      'DeepSeek PoW challenge missing fields（登录态可能已过期，或被要求人机校验）',
      'MALFORMED_RESPONSE',
      { status: resp.status },
    )
  }
  const wasmUrl = await resolveWasmUrl(auth, signal)
  const answer = await solvePoW(challenge, wasmUrl)
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  })
  return Buffer.from(payload).toString('base64')
}

// ── 文件上传（图片输入）────────────────────────────────────
//
// 实测（2026-09）：网页端看图不是「模型原生多模态入参」，而是网页把图片
// 上传成文件（`/api/v0/file/upload_file`，PoW 场景 = 该路径），拿到
// `data.biz_data.id`（形如 file-xxxx，model_kind=VISION）后在完成请求里用
// `ref_file_ids` 引用。已验证：上传「左红右蓝」PNG 后模型准确回答「左红色，右=蓝色」。

export interface UploadedFile {
  fileId: string
  name?: string
}

/** 上传一张图片，返回 file_id。`data` 为原始编码字节（png/jpeg/webp/gif）。 */
export async function uploadImageFile(
  auth: WebAuth,
  input: { data: Uint8Array; mediaType: string; name?: string },
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const targetPath = '/api/v0/file/upload_file'
  const powHeader = await createPowHeader(auth, targetPath, signal)
  const headers: DsHeaders = { ...buildDsHeaders(auth) }
  // multipart 由 FormData 设定 boundary，必须去掉 content-type
  delete headers['content-type']
  headers['x-ds-pow-response'] = powHeader

  const form = new FormData()
  const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data as any)
  form.append('file', new Blob([bytes], { type: input.mediaType || 'image/png' }), input.name || 'image.png')

  let resp: Response
  try {
    resp = await activeFetch(`${DS_BASE}${targetPath}`, { method: 'POST', headers, body: form, signal })
  } catch (error: any) {
    throw new AdapterLlmError(`DeepSeek 图片上传失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }
  const text = await resp.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (!resp.ok) {
    throw new AdapterLlmError(
      `DeepSeek 图片上传失败 (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      httpErrorCode(resp.status),
      { status: resp.status },
    )
  }
  const biz = envelopeError(json)
  if (biz) throw new AdapterLlmError(`DeepSeek 图片上传被拒（code ${biz.code}）：${biz.msg}`, bizErrorCode(biz.code), { status: resp.status })
  const fileId = json?.data?.biz_data?.id ?? json?.data?.id
  if (typeof fileId !== 'string' || !fileId) {
    throw new AdapterLlmError('DeepSeek 图片上传未返回 file_id', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  return { fileId, ...(input.name ? { name: input.name } : {}) }
}

// ── 会话 ──────────────────────────────────────────────────

/** 新建一个网页端聊天会话，返回 chat_session_id。 */
export async function createChatSession(auth: WebAuth, signal?: AbortSignal): Promise<string> {
  let resp: Response
  try {
    resp = await activeFetch(`${DS_BASE}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: buildDsHeaders(auth),
      body: '{}',
      signal,
    })
  } catch (error: any) {
    throw new AdapterLlmError(`DeepSeek session create failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }
  const text = await resp.text()
  if (!resp.ok) {
    const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
    throw new AdapterLlmError(
      `DeepSeek session create failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      httpErrorCode(resp.status),
      { status: resp.status, ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}) },
    )
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new AdapterLlmError('DeepSeek session create returned non-JSON', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  const biz = envelopeError(json)
  if (biz) {
    throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status })
  }
  const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id
  if (typeof id !== 'string' || !id) {
    throw new AdapterLlmError('DeepSeek session create missing id', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  return id
}

/** 尽力删除一个网页端会话（避免污染用户网页端聊天列表）。失败静默。 */
// ── 会话清理：把「每轮建一个立刻删一个」的机器特征压下来 ──────────────
//
// 背景：一次模型调用要发 4 个请求 —— 建会话 → 取 PoW → completion → 删会话。
// 其中「每轮新建一个临时会话、用完立刻删掉」是最强的机器行为特征之一（真人绝不会这样）。
//
// 为什么不能直接复用会话：DSH 每次把**全量历史**交给我们，而网页端会话是**有状态**的，
// 复用会让服务端看到「历史 + 全量 prompt」两份上下文，迅速撑爆窗口。所以只能优化**删除侧**。
//
//   immediate = 老行为：调用结束后 1.5s 删掉（每轮 1 个 DELETE 请求）
//   deferred  = 默认：攒够 batchSize 个、或从第一个入队起等满 delayMs 才清理；
//               清理时**先尝试一个请求批量删**（服务端支持的话 N 个会话只花 1 个请求），
//               不支持则回退逐个删，并且此后不再尝试批量（只浪费一次）。
//   keep      = 完全不删：请求数最少，但网页端会留下临时会话。

export type SessionCleanupMode = 'immediate' | 'deferred' | 'keep'

export interface SessionCleanupPolicy {
  mode: SessionCleanupMode
  /** 当前生效值：有区间时是"这一轮抽到的"，没有区间时就是固定值（毫秒）。 */
  delayMs: number
  /** 当前生效值：攒够多少个立即清理（个）。 */
  batchSize: number
  /** 当前生效的删除间隔（毫秒）—— 相邻两个删除请求之间停多久。 */
  gapMs: number
  /**
   * 三对区间（可选）。给了就"每轮 / 每次重新随机抽"，没给就保持固定值语义 ——
   * 这样老调用方（传死 batchSize / delayMs 的）行为完全不变。
   *
   * 为什么要有：**固定值本身就是机器特征** —— 每次都攒到第 8 个就动手、每次都正好等 90 秒、
   * 逐个删除时请求连发（中间 0 间隔）。真人不会这么精确。
   */
  batchRange?: CleanupRange
  delayRange?: CleanupRange
  gapRange?: CleanupRange
}

export const DEFAULT_SESSION_CLEANUP: SessionCleanupPolicy = {
  mode: 'deferred',
  // 均值落在旧默认值上（90s / 8 个 / 1.5s），所以升级后行为没有突变，只是多了方差
  delayMs: Math.round((DEFAULT_CLEANUP_DELAY_MS.min + DEFAULT_CLEANUP_DELAY_MS.max) / 2),
  batchSize: Math.round((DEFAULT_CLEANUP_BATCH.min + DEFAULT_CLEANUP_BATCH.max) / 2),
  gapMs: Math.round((DEFAULT_CLEANUP_GAP_MS.min + DEFAULT_CLEANUP_GAP_MS.max) / 2),
  batchRange: DEFAULT_CLEANUP_BATCH,
  delayRange: DEFAULT_CLEANUP_DELAY_MS,
  gapRange: DEFAULT_CLEANUP_GAP_MS,
}

/**
 * 单个请求里最多塞多少个会话 id。
 *
 * 为什么要有：队列在"清理很慢"时可能积很多（比如你离开两小时后回来，一次 flush 要删几十个）。
 * 「一次请求删掉一大批」正是用户担心的事 —— 所以超过这个数就拆成多次，
 * 每次之间按随机间隔停一下。
 */
const MAX_IDS_PER_REQUEST = 20

/**
 * 会话生命周期事件（2026-09-14）。
 *
 * 宿主用它维护一份「**还欠一次删除**」的会话清单并落盘（见 `session-journal.ts`），
 * 于是进程退出/被强杀之后，下次启动还能把这些会话补删掉 —— 在此之前，
 * 复用槽和待删队列只活在内存里，进程一走就静默丢失，网页端就会一直堆。
 *
 * 三个事件对应三种账：
 *   - `leased`  会话进了复用槽（此刻**还没删**，所以是欠账）；
 *   - `queued`  会话进了待删队列（同样是欠账，只是排队了）；
 *   - `deleted` **确认删掉**（服务端接受了）→ 唯一能销账的信号。
 */
export type SessionLifecycleEvent =
  | { kind: 'leased'; auth: WebAuth; sessionId: string }
  | { kind: 'queued'; auth: WebAuth; sessionId: string }
  | { kind: 'deleted'; sessionId: string }

let sessionLifecycleHook: ((event: SessionLifecycleEvent) => void) | undefined

/** 注册生命周期钩子（宿主启动时调一次即可；传 `undefined` 取消）。 */
export function setSessionLifecycleHook(hook?: (event: SessionLifecycleEvent) => void): void {
  sessionLifecycleHook = hook
}

function emitSessionLifecycle(event: SessionLifecycleEvent): void {
  try {
    sessionLifecycleHook?.(event)
  } catch {
    /* 钩子出错不能影响请求主流程 */
  }
}

export interface SessionCleanerOptions {
  policy?: Partial<SessionCleanupPolicy>
  logger?: { info?: (msg: string) => void; debug?: (msg: string) => void }
  /** 单测注入。 */
  fetchImpl?: typeof fetch
  setTimeoutImpl?: (fn: () => void, ms: number) => any
  clearTimeoutImpl?: (t: any) => void
  /** 随机源。单测注入一个确定序列即可得到可重复的取值。默认 Math.random。 */
  randomImpl?: () => number
}

export interface SessionCleaner {
  schedule(auth: WebAuth, sessionId: string): void
  /** 立即清理队列（测试 / 卸载时用）。 */
  flush(): Promise<void>
  pendingCount(): number
  policy(): SessionCleanupPolicy
  /** 运行时改策略（设置页保存后调用），返回改完后的值。 */
  configure(next: Partial<SessionCleanupPolicy>): SessionCleanupPolicy
}

export function createSessionCleaner(options: SessionCleanerOptions = {}): SessionCleaner {
  const policy: SessionCleanupPolicy = {
    mode: options.policy?.mode ?? DEFAULT_SESSION_CLEANUP.mode,
    delayMs: Math.max(0, Math.floor(options.policy?.delayMs ?? DEFAULT_SESSION_CLEANUP.delayMs)),
    batchSize: Math.max(1, Math.floor(options.policy?.batchSize ?? DEFAULT_SESSION_CLEANUP.batchSize)),
    // 没给区间（老调用方 / 老配置）→ 间隔为 0，也就是**不加额外间隔**，保持老行为。
    // 只有显式配了 gapRange 才启用"删一个歇一下"。
    gapMs: Math.max(
      0,
      Math.floor(options.policy?.gapMs ?? (options.policy?.gapRange ? DEFAULT_SESSION_CLEANUP.gapMs : 0)),
    ),
    // 区间是**可选**的：老调用方只传死 batchSize / delayMs 时，这里保持"无区间"= 固定值语义
    // （否则它们传的 3 会被默认区间 6~10 顶掉，单测与旧行为全乱）。
    ...(options.policy?.batchRange ? { batchRange: options.policy.batchRange } : {}),
    ...(options.policy?.delayRange ? { delayRange: options.policy.delayRange } : {}),
    ...(options.policy?.gapRange ? { gapRange: options.policy.gapRange } : {}),
  }
  /** 策略切换时按模式给默认延迟/批量（immediate 用老参数）。 */
  function applyModeDefaults(): void {
    if (policy.mode === 'immediate') {
      policy.delayMs = 1_500
      policy.batchSize = 1
    } else if (policy.mode === 'deferred' && policy.batchSize <= 1) {
      // 从「不删 / 立即」切回「延迟」时给一组新的随机值（不是写死的默认值）
      policy.delayMs = policy.delayRange
        ? pickInt(policy.delayRange)
        : DEFAULT_SESSION_CLEANUP.delayMs
      policy.batchSize = policy.batchRange
        ? pickInt(policy.batchRange)
        : DEFAULT_SESSION_CLEANUP.batchSize
    }
  }
  const doFetch = options.fetchImpl ?? fetch
  const setT = options.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = options.clearTimeoutImpl ?? ((t: any) => clearTimeout(t))
  const logger = options.logger

  let queue: { auth: WebAuth; sessionId: string }[] = []
  let timer: any
  /** 探测到服务端不接受批量删除后置位 —— 之后一律逐个删，不再浪费请求。 */
  let batchUnsupported = false

  const random = options.randomImpl ?? Math.random

  /** 在 [min, max] 里取整数（闭区间）。random 可注入，单测因此可重复。 */
  function pickInt(range: CleanupRange): number {
    const lo = Math.min(range.min, range.max)
    const hi = Math.max(range.min, range.max)
    if (hi <= lo) return lo
    // 注入的假随机源有可能返回 1，夹一下保证不越界
    return Math.min(hi, lo + Math.floor(random() * (hi - lo + 1)))
  }

  /**
   * 新的一轮清理开始（队列由空变非空）时重新抽：这一轮攒几个、最多等多久。
   *
   * 为什么按"轮"抽而不是每次都抽：阈值与等待时间要在一轮里保持稳定，
   * 否则"攒够 6~10 个"会退化成"好像随时都在触发"。每轮换一组，既有方差又不失节奏。
   */
  function rollCycle(): void {
    if (policy.mode !== 'deferred') return
    if (policy.batchRange) policy.batchSize = Math.max(1, pickInt(policy.batchRange))
    if (policy.delayRange) policy.delayMs = Math.max(0, pickInt(policy.delayRange))
  }

  /** 每次要发一个删除请求之前抽一次间隔（顺带记下当前值，供设置页显示）。 */
  function rollGap(): number {
    policy.gapMs = policy.gapRange ? Math.max(0, pickInt(policy.gapRange)) : Math.max(0, policy.gapMs)
    return policy.gapMs
  }

  /** 用注入的定时器睡一会儿（单测里就是"等假表被触发"）。 */
  function sleep(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const handle = setT(() => resolve(), ms)
      ;(handle as any)?.unref?.()
    })
  }

  /** 装一次「到点清理」的表（已经装了就不动）。 */
  function armTimer(): void {
    if (timer !== undefined) return
    if (policy.mode === 'keep') return
    timer = setT(() => {
      void flush()
    }, Math.max(0, policy.delayMs))
    ;(timer as any)?.unref?.()
  }

  /**
   * 服务端"看起来接受了"：HTTP ok 且响应体里没有业务错误信封。
   *
   * 网页端会在 HTTP 200 上裹一层 `{code, msg, data:{biz_code,biz_msg}}` ——
   * 只看 `resp.ok` 会把"其实没删掉"当成成功（F07 踩过这个坑）。
   */
  async function respLooksOk(resp: Response): Promise<boolean> {
    let ok = resp.ok
    if (ok) {
      const text = await resp.text().catch(() => '')
      try {
        const json = text ? JSON.parse(text) : undefined
        if (json && envelopeError(json)) ok = false
      } catch {
        ok = false
      }
    }
    return ok
  }

  /**
   * 删一个，返回**是否确认删掉** —— 删除回执要用来摘掉"欠删除"日志里的记录
   * （见 session-journal.ts：只有确认删掉才移记录，否则下次启动还来补删）。
   */
  async function deleteOne(auth: WebAuth, sessionId: string): Promise<boolean> {
    try {
      const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
        method: 'POST',
        headers: buildDsHeaders(auth),
        body: JSON.stringify({ chat_session_id: sessionId }),
        signal: AbortSignal.timeout(10_000),
      })
      return await respLooksOk(resp)
    } catch {
      return false // 清理失败不影响主流程
    }
  }

  /**
   * 删一批：优先一个请求批量删；服务端不接受则**逐个删**。
   *
   * 逐个删时两个请求之间会停一个随机间隔 —— 原来这里是**连发**（一批 20 个就是 20 个连续请求），
   * 那是最像脚本的部分。
   */
  async function deleteChunk(batch: { auth: WebAuth; sessionId: string }[]): Promise<void> {
    if (batch.length === 0) return
    // ⚠️ F07（2026-09-12 审计）：批量删除**只发一个凭证**（HTTP 请求只有一个 Authorization 头），
    // 若这一批里混了不同账号的会话，就等于「拿 A 的凭证去删 B 的会话」——
    // 轻则整批被服务端拒绝，重则 resp.ok 时被当成全部成功（旧代码 ok 就直接 return，
    // 不校验每个 id 是否真的删掉）。混号时退化为逐个删，逐个删用的是各自的 auth。
    const firstToken = batch[0].auth?.token
    const sameAccount = batch.every((item) => item.auth?.token === firstToken)
    if (batch.length > 1 && !batchUnsupported && sameAccount) {
      try {
        const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
          method: 'POST',
          headers: buildDsHeaders(batch[0].auth),
          body: JSON.stringify({ chat_session_ids: batch.map((b) => b.sessionId) }),
          signal: AbortSignal.timeout(15_000),
        })
        const ok = await respLooksOk(resp)
        if (ok) {
          // 批量删只发一个请求，服务端接受即认为这一批都删掉了（它不逐个回报）。
          // 所以只对"同账号 + 无业务错误"的批次这样处理 —— 见上面的 F07 说明。
          for (const item of batch) emitSessionLifecycle({ kind: 'deleted', sessionId: item.sessionId })
          logger?.debug?.(`deepseek-web: 已批量清理 ${batch.length} 个临时会话（只用了 1 个请求）`)
          return
        }
        batchUnsupported = true
        logger?.debug?.('deepseek-web: 服务端不接受批量删除会话，之后改为逐个删除')
      } catch {
        // 网络异常 ≠ 不支持，下次仍可尝试
      }
    }

    for (let i = 0; i < batch.length; i += 1) {
      if (i > 0) await sleep(rollGap())
      if (await deleteOne(batch[i].auth, batch[i].sessionId)) {
        emitSessionLifecycle({ kind: 'deleted', sessionId: batch[i].sessionId })
      }
    }
    logger?.debug?.(`deepseek-web: 已清理 ${batch.length} 个临时会话`)
  }

  /** 真正干活的清理。分片：队列积很多时也不一口气删完（见 MAX_IDS_PER_REQUEST 的说明）。 */
  async function doFlush(): Promise<void> {
    if (timer !== undefined) {
      clearT(timer)
      timer = undefined
    }
    const batch = queue
    queue = []
    try {
      if (batch.length === 0) return
      for (let i = 0; i < batch.length; i += MAX_IDS_PER_REQUEST) {
        if (i > 0) await sleep(rollGap())
        await deleteChunk(batch.slice(i, i + MAX_IDS_PER_REQUEST))
      }
    } catch (error: any) {
      // 清理失败不影响主流程
      logger?.debug?.(`deepseek-web: 会话清理出错（已忽略）：${error?.message ?? error}`)
    } finally {
      // 清理期间可能又攒了新的：重新装表，否则它们会一直躺在队列里没人管（直到下次有会话入队）
      if (queue.length > 0) armTimer()
    }
  }

  /**
   * 立即清理队列。
   *
   * **串行化**：上一次还没删完时，这一次排在它后面等 —— 否则两轮 flush 的删除请求会交错发出，
   * 正是我们要避免的"连发"。排队的 flush 轮到自己时才取队列，所以能带上期间新攒的会话。
   */
  let chain: Promise<void> = Promise.resolve()
  function flush(): Promise<void> {
    chain = chain.then(doFlush, doFlush)
    return chain
  }

  function schedule(auth: WebAuth, sessionId: string): void {
    if (policy.mode === 'keep') return
    // 队列由空变非空 = 新的一轮开始 → 重新抽本轮的阈值与最长等待
    if (queue.length === 0) rollCycle()
    queue.push({ auth, sessionId })
    // 落账：这个会话此刻**还没删**（排着队）。宿主据此落盘，进程被强杀后下次启动补删。
    emitSessionLifecycle({ kind: 'queued', auth, sessionId })
    // 只有 deferred 才「攒够就立即清理」。immediate 始终走延迟 —— 保持老行为：
    // 调用结束后过一会儿才删，避免「流刚结束就紧跟一个 DELETE」这种过紧的节奏。
    if (policy.mode === 'deferred' && queue.length >= policy.batchSize) {
      void flush()
      return
    }
    armTimer()
  }

  function configure(next: Partial<SessionCleanupPolicy>): SessionCleanupPolicy {
    const modeChanged = next.mode !== undefined && next.mode !== policy.mode
    if (next.mode !== undefined) policy.mode = next.mode
    if (next.delayMs !== undefined) policy.delayMs = Math.max(0, Math.floor(next.delayMs))
    if (next.batchSize !== undefined) policy.batchSize = Math.max(1, Math.floor(next.batchSize))
    if (next.gapMs !== undefined) policy.gapMs = Math.max(0, Math.floor(next.gapMs))
    // 区间：给了就换；没给就保持原样（"缺省 = 不随机"的语义不能丢）
    for (const key of ['batchRange', 'delayRange', 'gapRange'] as const) {
      const value = next[key]
      if (value && Number.isFinite(value.min) && Number.isFinite(value.max)) {
        policy[key] = { min: Math.floor(Math.min(value.min, value.max)), max: Math.floor(Math.max(value.min, value.max)) }
      }
    }
    if (modeChanged) applyModeDefaults()
    if (policy.mode === 'keep') void flush() // 切到「不删」时把已排队的清掉，避免残留
    logger?.info?.(
      `deepseek-web: 会话清理策略已更新 —— ${policy.mode}` +
        (policy.mode === 'deferred'
          ? `（攒 ${policy.batchSize} 个或 ${Math.round(policy.delayMs / 1000)}s 后清理` +
            (policy.gapRange ? `；批量删除不受支持时逐个删，间隔 ${policy.gapMs}ms` : '') +
            '）'
          : ''),
    )
    return { ...policy }
  }

  return {
    schedule,
    flush,
    pendingCount: () => queue.length,
    policy: () => ({ ...policy }),
    configure,
  }
}

/** 默认清理器（immediate 语义，兼容旧调用方）。 */
const defaultCleaner = createSessionCleaner({
  policy: { mode: 'immediate', delayMs: 1_500, batchSize: 1 },
})

export function scheduleDeleteSession(auth: WebAuth, sessionId: string): void {
  defaultCleaner.schedule(auth, sessionId)
}

/** 验证登录态：优先 users/current，端点不存在时退回 PoW challenge 探活。 */
/**
 * 从 `users/current` 的 user 对象里挑一个**能看的账号标识**。
 *
 * 两个必须记住的坑（都是实测踩出来的，2026-09-12）：
 *
 *  1. **不能用 `??` 串起来。** 接口对"没设邮箱"的账号会返回 `email: ""`，
 *     而空字符串**不是** nullish —— `"" ?? x` 的结果就是 `""`，整条回退链当场被它挡住，
 *     display 永远是空，界面只好退回去显示内部 id（`acc_cd8e05ec`）。
 *     所以必须按"**有内容**"取，跳过 undefined / null / 空白。
 *
 *  2. **字段名要和响应对齐。** 手机号是 `mobile_number`（不是 `mobile`），
 *     而且服务端返回的**已经是脱敏形态**（如 `183******78`），可以直接展示。
 *
 * 实测响应形状（只列相关字段）：
 *   { id, token, email: "", mobile_number: "183******78", area_code: "+86", chat: {...} }
 */
export function pickUserDisplay(user: any): string {
  const candidates = [
    user?.email,
    user?.mobile_number,
    user?.mobile,
    user?.phone,
    user?.username,
    user?.nickname,
    user?.name,
  ]
  for (const value of candidates) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

/**
 * 判定 `users/current` 的响应体**形状**是否可信。
 *
 * ⚠️ F09（2026-09-12 审计）：旧代码在 `resp.json()` 抛错时把 json 置为 undefined，
 * 而 `envelopeError(undefined)` 返回 undefined，于是径直走到 `ok: true`，
 * 返回一个**空壳的 user({})**。也就是说：反爬页 / WAF 拦截页 / 空响应
 * —— 它们同样是 HTTP 200 —— 会被当成"验证通过"。
 *
 * 后果很实际：探活显示"通过"、账号看起来正常，
 * 0.1.31 加的「需要重新登录」按钮就永远不会触发；什么都没确认到，却说成功。
 * 只读零额度请求偶发失败的代价只是一次重试，远比"误报成功"划算。
 *
 * 抽成纯函数是为了能单测（validateAuth 要发网络请求，测不了这条分支）。
 */
/**
 * 校验 `users/current` 的信封。**必须能辨认出一个用户身份**才算成功。
 *
 * 2026-09-13 第二轮审计 N09：旧实现只拒绝"不是对象"和"data、code 都缺"，
 * 于是 `{code:0}`、`{data:null}`、`{code:"401",data:null}` 这类空壳/错型信封全部被判成功 ——
 * 而 `validateAuth` 之后又会回落空对象，导致"校验成功"与"拿到有效身份"脱节。
 * 现在：业务码必须是数值、data 必须是对象、且里面要能找到一个可辨认的用户字段。
 */
export function classifyAuthEnvelope(json: unknown): { ok: true } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return fail('users/current 响应不是 JSON 对象（可能是反爬页面或网关拦截）')
  }
  const obj = json as any
  // 业务码必须是**数值**：字符串 "401" 这种错型信封不能当成功
  if (typeof obj.code !== 'number') return fail('users/current 缺少数值业务码（形状不符）')
  const bizError = envelopeError(obj)
  if (bizError) return fail(bizError.msg)
  if (obj.code !== 0 || !obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
    return fail('users/current 缺少用户数据（形状不符）')
  }
  if (obj.data.biz_code !== undefined && typeof obj.data.biz_code !== 'number') {
    return fail('users/current 内层业务码无效')
  }
  const payload = obj.data.biz_data ?? obj.data
  const user = payload?.user ?? payload
  if (!user || typeof user !== 'object' || Array.isArray(user)) return fail('users/current 用户形状无效')
  const hasId =
    (typeof user.id === 'string' && user.id.trim().length > 0) ||
    (typeof user.id === 'number' && Number.isFinite(user.id))
  const named = ['email', 'mobile_number', 'mobile', 'phone', 'username', 'nickname', 'name'].some(
    (k) => typeof user[k] === 'string' && user[k].trim(),
  )
  // 空壳信封（data 里什么都没有）不能算校验成功
  return hasId || named ? { ok: true } : fail('users/current 缺少可辨认的用户身份')
}

export async function validateAuth(
  auth: WebAuth,
  signal?: AbortSignal,
): Promise<{ ok: boolean; user?: { id?: string; display?: string }; error?: string }> {
  try {
    const resp = await activeFetch(`${DS_BASE}/api/v0/users/current`, { headers: buildDsHeaders(auth), signal })
    if (resp.ok) {
      let json: any
      try {
        json = await resp.json()
      } catch {
        json = undefined
      }
      // 形状校验（纯函数，见 classifyAuthEnvelope 的注释）
      const verdict = classifyAuthEnvelope(json)
      if (!verdict.ok) return verdict
      const payload = json?.data?.biz_data ?? json?.data
      const user = payload?.user ?? payload ?? {}
      const display = pickUserDisplay(user)
      return {
        ok: true,
        user: {
          ...(user?.id !== undefined ? { id: String(user.id) } : {}),
          ...(display ? { display } : {}),
        },
      }
    }
    if (resp.status === 404) {
      await createPowHeader(auth, '/api/v0/chat/completion', signal)
      return { ok: true }
    }
    return { ok: false, error: `users/current HTTP ${resp.status}` }
  } catch (error: any) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── SSE 流式解析 ──────────────────────────────────────────

export type WebStreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'status'; value: string }
  | {
      kind: 'finish'
      reason?: string
      /**
       * 服务端上报的**本消息**总 token 数（含 prompt + 回复 + 服务端自身开销）。
       * 实测 2026-09-13：9 字符 prompt → 38；12,424 字符 prompt → 6446；
       * 且同一会话第二轮仍只报自己的 38 → 是「本消息」而不是「会话累计」。
       * 拿不到时缺省（此时调用方退回按字符估算）。
       */
      totalTokens?: number
    }
  | {
      kind: 'error'
      message: string
      raw?: string
      /** 语义归类（如并发生成 → RATE_LIMIT），调用方据此决定重试 */
      code?: string
      retryAfterMs?: number
      /** RATE_LIMIT 细分：并发抢占（等对面写完）还是账号节流（等限流解除）—— 文案与退避都不同 */
      rateLimitKind?: 'concurrent' | 'throttled'
    }

interface Fragment {
  type: string
  content: string
  emitted: number
}

function isReasoningType(type: string): boolean {
  const t = type.toUpperCase()
  return t === 'THINK' || t === 'REASONING' || t === 'THINKING'
}

/** 把字节流切成行（SSE 帧以 \n 分隔）。 */
async function* iterateLines(body: any): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = function* (): Generator<string> {
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
    }
  }
  if (typeof body?.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        yield* drain()
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {}
    }
  } else if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      yield* drain()
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, '')
}

/**
 * 网页端 completion 负载的解析状态机（可单测：handle 返回待 yield 的事件）。
 *
 * ⚠️ 正确性模型（2026-09 事故修复）：
 *   真实事故：模型回答了完整一段，DSH 里只显示「，」「不上」「了一圈」这类 1~3 字碎片，
 *   并伴随 EMPTY_RESPONSE 重试。根因是旧实现用「只增不减的 emitted 计数器」做去重，
 *   而快照会把派生文本重置为更短的内容 —— 计数器被撑大后保持高位，后续只在文本长度
 *   超过它时才吐字，于是前面的全丢、只剩余数的尾巴；余数为空又触发重试。
 *
 *   现在的规则：
 *     ① **增量事件驱动发射**（fragment APPEND / -1/content / thinking_content / content / 裸 v）
 *     ② **快照只做对账**：仅当候选文本是「已发射内容的严格延伸」时补差；
 *        更短（过期快照）或分歧（服务端重排/回退）一律忽略，绝不重置已发射内容
 *     ③ 快照永远不会让已发射内容变小 → 不会丢字、不会因此触发假 EMPTY_RESPONSE
 */
export interface SseStateOptions {
  /**
   * 本轮请求是否开启了思考（对应请求体里的 `thinking_enabled`）。
   *
   * F25（2026-09-14，用真实帧复现）：正常流的**首帧快照**一定带一个 `type: "THINK"`
   * 的 fragment（抓包实测 4 轮全如此），之后思考全部通过
   * `response/fragments/-1/content` 与「无 path 的裸续段」续写 —— 也就是说
   * **思考的归属完全依赖那份快照**。一旦快照没能进入状态机（整帧丢失，或服务端
   * 先发了 `fragments: []` 的快照），`fragments` 就一直是空的，而旧实现在
   * 「无 fragment 可续」时**无条件当正文发射** ⇒ 整段思考上屏。
   *
   * 实测后果：09-14 一轮 2062 字符、09-12 两轮 10526 / 4360 字符的全部进正文，
   * 且这些正文块开头都缺几个字（"回答中文…" 本该是 "我们需要回答中文…"，
   * 缺掉的正是被丢弃的那份快照里的片段）—— 一个根因同时解释「整段上屏」与「缺开头」。
   *
   * 现在：开了思考却还没 fragment 时先**缓冲**，等 fragment 出现再定归属。
   * 未开思考时不缓冲（没有歧义），保持旧行为。
   */
  thinkingEnabled?: boolean
  /**
   * 本轮 assistant 的 message_id（链式投喂用）。
   *
   * 来源是流的**首帧** `event: ready`：`{"request_message_id":1,"response_message_id":2,...}`
   * （真实样本 `.workbuddy/tmp/shortq-r1-*.sse`）。下一轮就把它当 `parent_message_id` 发上去，
   * 服务端据此把新消息挂到上一条回答下面，于是历史由服务端维护、我们只发增量。
   *
   * 用回调而不是往 WebStreamEvent 里加一种 kind：新 kind 会流到 adapter 的事件消费处，
   * 那里对未知 kind 的处理没人守（多一种事件就多一处可能被当成"未知"丢掉）。
   */
  onResponseMessageId?: (id: number) => void
}

/** F28：思考的标准包装标签。孤儿兜底用（见 finish 里的判据）。 */
const THINKING_WRAPPER_RE = /<\s*\/?\s*(analysis|summary|thinking|scratchpad|thought)\b/i

/**
 * F28 取证开关：把原始 SSE 逐行落盘，给「孤儿思考归正文」这类通道错位定论用。
 * 默认关；设环境变量 `DSH_WEB_LOGIN_DUMP_SSE=1` 开启（需重启 DSH 生效）。
 * 文件写到 `~/.dsh/deepseek-web/frames/<时间戳>-<序号>.sse`，逐行 append ——
 * 就算进程被强杀，已收到的帧也在盘上（F24 的教训：别用构造帧当证据，要抓真实帧）。
 */
function dumpSinkPath(): string | null {
  if (process.env.DSH_WEB_LOGIN_DUMP_SSE !== '1') return null
  try {
    const dir = join(homedir(), '.dsh', 'deepseek-web', 'frames')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return join(dir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.sse`)
  } catch {
    return null
  }
}

export function createSseState(options: SseStateOptions = {}) {
  const fragments: Fragment[] = []
  /** fragments 派生文本（仅用于快照对账候选）。 */
  let fragmentsText = ''
  let fragmentsThinking = ''
  /** 直连格式的派生文本（仅用于快照对账候选）。 */
  let directText = ''
  let directThinking = ''
  /** 已发射的规范流（只增不减）。 */
  let outText = ''
  let outThinking = ''
  let divergences = 0
  let sink: 'fragments' | 'thinking' | 'content' | null = null
  /**
   * F25：通道未知的暂存文本。只在「请求开了思考、但还没出现任何 fragment」时使用
   * —— 正常流不会走到这里（首帧快照就带着 THINK fragment）。
   */
  let orphanBuffer = ''
  const thinkingEnabled = options.thinkingEnabled === true
  let pendingFinish: string | undefined
  let sawData = false
  /** 服务端上报的本消息 token 总量（见 WebStreamEvent 的 totalTokens 说明）。 */
  let totalTokens: number | undefined

  const emit = (out: WebStreamEvent[], kind: 'text' | 'thinking', delta: string): void => {
    if (!delta) return
    if (kind === 'text') outText += delta
    else outThinking += delta
    out.push({ kind, text: delta })
  }
  const emitText = (out: WebStreamEvent[], delta: string): void => emit(out, 'text', delta)
  const emitThinking = (out: WebStreamEvent[], delta: string): void => emit(out, 'thinking', delta)

  /**
   * F25：把暂存文本按**刚出现的 fragment 类型**归属并发射。
   *
   * 真实帧（2026-09-14 抓，4 轮同构）显示两条规律：
   *   1. 思考的 fragment 由**首帧快照**建立；正文的 fragment 由 `response/fragments`
   *      的 APPEND 建立（`fragments+1 [RESPONSE]`）；
   *   2. 第一个 RESPONSE fragment 出现之前，流上的内容**全是思考**。
   *
   * 所以无论先到的是 THINK 还是 RESPONSE fragment，暂存的那段都应归思考 ——
   * 正文不会"先于自己的 fragment"出现在流上。这样即使快照整帧丢失，
   * 思考仍会回到思考通道，而不是被当成正文顶到用户脸上。
   */
  const settleOrphans = (out: WebStreamEvent[], firstType: string): void => {
    if (!orphanBuffer) return
    const text = orphanBuffer
    orphanBuffer = ''
    if (!isReasoningType(firstType)) {
      // 正文 fragment：它之前的内容只可能是思考（见上面的规律 2），仍归思考。
    }
    directThinking += text
    emitThinking(out, text)
  }

  /** 快照对账：只在候选是严格延伸时补差；过期/分歧忽略（宁可漏一次快照，也不吐乱码或丢字）。 */
  const reconcile = (out: WebStreamEvent[], kind: 'text' | 'thinking', candidate: string): void => {
    const current = kind === 'text' ? outText : outThinking
    if (!candidate || candidate === current) return
    if (candidate.startsWith(current)) {
      emit(out, kind, candidate.slice(current.length))
      return
    }
    if (current.startsWith(candidate)) return // 过期（更短）快照
    divergences += 1 // 分歧：忽略
  }

  /** 重建 fragments 派生文本（快照覆盖时用）。 */
  const rebuildFragmentText = (): void => {
    fragmentsText = ''
    fragmentsThinking = ''
    for (const fragment of fragments) {
      if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content
      else fragmentsText += fragment.content
    }
  }
  /** 快照：整表替换 + 对账（不直接发射）。 */
  const replaceFragments = (list: any[], out: WebStreamEvent[]): void => {
    fragments.length = 0
    for (const f of list) {
      if (f && typeof f === 'object' && typeof f.content === 'string') {
        fragments.push({ type: String(f.type ?? 'RESPONSE'), content: f.content, emitted: 0 })
      }
    }
    rebuildFragmentText()
    sink = fragments.length > 0 ? 'fragments' : null
    // F25：快照迟到时（正常是流的第一帧），先把之前"无归属"的文本结算掉。
    if (fragments.length > 0) settleOrphans(out, fragments[0].type)
  }
  /** 增量：追加 fragment（其 content 属于新内容 → 直接发射）。 */
  const appendFragments = (incoming: any, out: WebStreamEvent[]): void => {
    const list = Array.isArray(incoming) ? incoming : incoming !== undefined ? [incoming] : []
    let settled = false
    for (const f of list) {
      if (!f || typeof f !== 'object' || typeof f.content !== 'string') continue
      const fragment: Fragment = { type: String(f.type ?? 'RESPONSE'), content: f.content, emitted: 0 }
      // F25：第一个 fragment 出现之前攒下的文本先定归属（必须在发射本 fragment 之前）。
      if (!settled) {
        settled = true
        settleOrphans(out, fragment.type)
      }
      fragments.push(fragment)
      if (isReasoningType(fragment.type)) {
        fragmentsThinking += fragment.content
        emitThinking(out, fragment.content)
      } else {
        fragmentsText += fragment.content
        emitText(out, fragment.content)
      }
    }
    sink = fragments.length > 0 ? 'fragments' : null
  }
  /** 增量：续写最后一个 fragment。 */
  const appendToLastFragment = (text: string, out: WebStreamEvent[]): void => {
    const fragment = fragments[fragments.length - 1]
    if (!fragment) {
      // 没有 fragment 可续 → 这段文字不是"续写 fragment"，而是**当前通道的裸续段**，必须尊重 sink。
      //
      // F24（实测）：思考阶段服务端就是分两步下发的 —— 先 `response/thinking_content` 发开头
      // 一小段（建立 sink='thinking'），再用 `response/fragments/-1/content` 发**思考的其余全部**。
      // 旧实现在这里无条件当正文发射，于是一整段思考被上屏：268 条 assistant 消息里 7 条中招
      // （5016~14877 字符），且这些正文块开头都缺 2~4 个字符（" me analyze…" 本该是
      // "Let me analyze…"）—— 缺掉的正是先走 thinking 通道的那一小段，两处现象由这一分支同时解释。
      //
      // sink 未建立时**保持旧行为**（当正文）：服务端也可能首帧就发 -1/content，
      // 那种情况没有通道信息可用，当正文是唯一合理的兜底（不能为了修这个而丢字）。
      if (sink === 'thinking') {
        directThinking += text
        emitThinking(out, text)
        return
      }
      if (sink === 'content') {
        directText += text
        emitText(out, text)
        return
      }
      // F25：请求开了思考、却还没有任何 fragment 可续 —— 正常流里首帧快照一定带 THINK
      // fragment，走到这里说明那份快照没能进入状态机（丢失 / fragments 为空）。
      // 这段文字极可能是思考的尾巴，先攒着，等 fragment 出现再定归属（见 settleOrphans）。
      // 旧实现在这里无条件当正文发射，就是"整段思考上屏"的直接原因。
      if (thinkingEnabled) {
        orphanBuffer += text
        return
      }
      directText += text
      emitText(out, text)
      return
    }
    fragment.content += text
    if (isReasoningType(fragment.type)) {
      fragmentsThinking += text
      emitThinking(out, text)
    } else {
      fragmentsText += text
      emitText(out, text)
    }
  }
  /** 增量：裸续段按当前 sink 归属。 */
  const appendSink = (text: string, out: WebStreamEvent[]): void => {
    if (sink === 'thinking') {
      directThinking += text
      emitThinking(out, text)
    } else if (sink === 'content') {
      directText += text
      emitText(out, text)
    } else if (sink === 'fragments') {
      appendToLastFragment(text, out)
    }
  }

  return {
    /** 负载处理（增量直接发射；快照只对账）。 */
    handlePayload(d: any, eventName?: string): WebStreamEvent[] {
      const out: WebStreamEvent[] = []
      sawData = true
      // 0) 首帧 `event: ready`：把本轮 assistant 的 message_id 交给调用方（链式投喂要用）。
      //    不 return：这里的判据只看字段本身，`ready` 的负载不会命中下面的任何分支，
      //    这样即使服务端某天不带 `event: ready` 那行，只要字段还在就照样能拿到。
      if (d && typeof d === 'object' && typeof (d as any).response_message_id === 'number') {
        options.onResponseMessageId?.((d as any).response_message_id)
      }
      // 1) 完整 response 快照
      if (d && typeof d === 'object' && d.v && typeof d.v === 'object' && d.v.response && typeof d.v.response === 'object') {
        const response = d.v.response
        if (Array.isArray(response.fragments)) {
          replaceFragments(response.fragments, out)
          // fragments 存在时以它为准；否则用 content
          if (fragments.length > 0) {
            reconcile(out, 'thinking', fragmentsThinking)
            reconcile(out, 'text', fragmentsText)
          }
        }
        if (typeof response.content === 'string') {
          directText = response.content
          sink = 'content'
          if (fragments.length === 0) reconcile(out, 'text', directText)
        }
        if (response.finish_reason !== undefined && response.finish_reason !== null) {
          pendingFinish = String(response.finish_reason)
        }
        return out
      }
      // 2) 模型错误事件：按语义归类（并发生成 → 可重试的 RATE_LIMIT），调用方据此决定重试还是报错
      if (d && typeof d === 'object' && d.type === 'error') {
        const message = typeof d.content === 'string' ? d.content : typeof d.message === 'string' ? d.message : 'model error'
        const event: WebStreamEvent & { raw?: string } = {
          kind: 'error',
          message,
          ...(d.finish_reason !== undefined ? { raw: String(d.finish_reason) } : {}),
        }
        if (isBusyGenerating(message)) {
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = 5_000
          event.rateLimitKind = 'concurrent'
        } else if (isThrottled(message)) {
          // 账号级节流（「消息发送过于频繁，请稍后重试」）：连续被限就退避渐长，别一直撞
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = noteThrottled()
          event.rateLimitKind = 'throttled'
        }
        out.push(event)
        return out
      }
      // 3) SSE 命名事件（title 忽略；toast 视为提示性错误）
      if (eventName === 'toast') {
        const message = d && typeof d === 'object' ? (d.content ?? d.message ?? JSON.stringify(d)) : String(d)
        const full = `DeepSeek toast: ${String(message).slice(0, 200)}`
        const event: WebStreamEvent = { kind: 'error', message: full }
        if (isBusyGenerating(full)) {
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = 5_000
          event.rateLimitKind = 'concurrent'
        } else if (isThrottled(full)) {
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = noteThrottled()
          event.rateLimitKind = 'throttled'
        }
        out.push(event)
        return out
      }
      if (eventName === 'title') return out
      // 4) 顶层 finish_reason
      if (d && typeof d === 'object' && d.finish_reason !== undefined && d.finish_reason !== null) {
        pendingFinish = String(d.finish_reason)
        return out
      }
      const path: string | undefined = d?.p
      const value = d?.v
      if (typeof path === 'string') {
        switch (path) {
          case 'response/fragments':
            appendFragments(value, out)
            return out
          case 'response/fragments/-1/content': {
            if (typeof value === 'string') {
              appendToLastFragment(value, out)
              // F24：只有**真的续到 fragment 上**才把 sink 切到 'fragments'。
              // fragments 为空但已建立 thinking/content 通道时必须保持原通道 ——
              // 否则紧接着的裸续段会因 sink='fragments' 又退回"当正文"，等于没修。
              const keepChannel = fragments.length === 0 && (sink === 'thinking' || sink === 'content')
              if (!keepChannel) sink = 'fragments'
            }
            return out
          }
          case 'response/fragments/-1/elapsed_secs': {
            // F27：这是「刚结束的是一段**思考**」的直接证据 —— 真实帧里它紧跟 THINK fragment
            // 出现、值就是该段思考的耗时（正文 fragment 上的这个字段是 null）。
            // 快照丢失时，它能告诉我们暂存的那段文本到底属于哪个通道。
            if (typeof value === 'number' && value > 0) settleOrphans(out, 'THINK')
            return out
          }
          case 'response/thinking_content':
            if (typeof value === 'string') {
              directThinking += value
              emitThinking(out, value)
              sink = 'thinking'
            }
            return out
          case 'response/content':
            if (typeof value === 'string') {
              directText += value
              emitText(out, value)
              sink = 'content'
            }
            return out
          case 'response/finish_reason':
            if (typeof value === 'string') pendingFinish = value
            return out
          case 'accumulated_token_usage':
            // 兼容：万一服务端直接以顶层路径下发（真实样本是裹在 response/BATCH 里的，见上）。
            // ⚠️ 快照里的那个字段初始恒为 0（status 还是 WIP），**不要**拿它当结果 ——
            // 判定脚本第一版就是取了末尾快照的 0，结论整个反过来。
            if (typeof value === 'number' && Number.isFinite(value)) totalTokens = value
            return out
          case 'response/status':
            if (typeof value === 'string') {
              out.push({ kind: 'status', value })
              if (value === 'FINISHED') pendingFinish = pendingFinish ?? 'FINISHED'
            }
            return out
          case 'response': {
            if (Array.isArray(value)) {
              for (const op of value) {
                if (op && typeof op === 'object' && op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
                  appendFragments(op.v, out)
                }
                // 真实形态（2026-09-13 抓包）：
                //   {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38}, …]}
                // 它在**内层 op** 里，不是顶层 case —— 第一版补丁插错层级，测试直接抓到。
                if (op && typeof op === 'object' && op.p === 'accumulated_token_usage') {
                  if (typeof op.v === 'number' && Number.isFinite(op.v)) totalTokens = op.v
                }
              }
            }
            return out
          }
          default:
            return out
        }
      }
      // 5) 无 path 的续段：承接当前 sink
      if (typeof value === 'string' && value.length > 0) appendSink(value, out)
      return out
    },
    /** 对外入口（负载已直接发射增量，这里只做兜底对账）。 */
    handle(d: any, eventName?: string): WebStreamEvent[] {
      return this.handlePayload(d, eventName)
    },
    /** 流结束：产出 finish（若确实收到过数据）。 */
    finish(): WebStreamEvent[] {
      const out: WebStreamEvent[] = []
      // F27（2026-09-14，修订 F25 的兜底）：整轮都没等到任何 fragment 时**按正文收尾**。
      //
      // F25 当初按"开了思考就归思考"收尾，理由是"避免以正文的名义补发思考"。但那个方向
      // 有一个更糟的失败模式：**万一暂存里其实是正文，回答就从界面上消失了** ——
      // 用户只看到一段思考、正文空白，会以为模型没回答（实测反馈："正文的内容卡在思考里"）。
      // 两种错法的代价不对等：
      //   · 思考被显示到正文 → 内容都在，用户读得懂这是思考；
      //   · 正文被吞进思考 → 用户看不到回答，是明确的功能故障。
      // 所以无线索时一律归正文。有 fragment 的正常/异常路径不受影响（由 settleOrphans 结算）。
      if (sawData && orphanBuffer) {
        const text = orphanBuffer
        orphanBuffer = ''
        // F28（2026-09-14，第二次修订兜底）：兜底方向维持 F27 的"归正文"，但**加一条标签判据** ——
        // 孤儿文本以 <analysis>/<summary> 这类**思考的标准包装**为主体时归思考。
        // 依据（实测 [998]/[1091] 两条消息）：text 块 27397 字**整块**都是 analysis+summary 复盘、
        // 没有一句对用户说的话 —— 模型不会把整条回答写成纯复盘 ⇒ 那是思考。
        // 反过来，普通正文几乎不会以这些标签为主体，误伤面很小。
        // 其余无线索的孤儿仍按正文收尾（F27 的原则不变：看不到回答比看到思考更糟）。
        if (thinkingEnabled && THINKING_WRAPPER_RE.test(text)) {
          directThinking += text
          emitThinking(out, text)
        } else {
          directText += text
          emitText(out, text)
        }
      }
      if (!sawData) return out
      out.push({ kind: 'finish', reason: pendingFinish, ...(totalTokens !== undefined ? { totalTokens } : {}) })
      return out
    },
    /** 诊断：已发射正文/思考长度与快照分歧次数（单测与排查用）。 */
    stats(): { text: string; thinking: string; divergences: number; orphanLen?: number; totalTokens?: number } {
      return {
        text: outText,
        thinking: outThinking,
        divergences,
        ...(orphanBuffer ? { orphanLen: orphanBuffer.length } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      }
    },
  }
}

/** 解析 /chat/completion 的 SSE 字节流，产出增量文本/思考事件。 */
export async function* parseWebSse(body: any, options?: SseStateOptions): AsyncGenerator<WebStreamEvent> {
  const state = createSseState(options)
  let eventName = ''
  /**
   * F13（2026-09-12 审计）：SSE 规范允许一个事件里出现**多个** `data:` 行，
   * 收齐后要用 `\n` 拼接再整体解析。旧实现逐行 `JSON.parse`，一旦服务端把一个
   * JSON 拆到多行（或 payload 里本身含换行），每行都解析失败 → 被
   * `catch { continue }` 静默丢弃，表现为「流突然断了/少了一段」且无任何报错。
   */
  let dataLines: string[] = []
  const flushData = (): { events: WebStreamEvent[]; done: boolean } => {
    if (dataLines.length === 0) return { events: [], done: false }
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (data.length === 0) return { events: [], done: false }
    if (data === '[DONE]') return { events: Array.from(state.finish()), done: true }
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return { events: [], done: false }
    }
    return { events: Array.from(state.handle(parsed, eventName)), done: false }
  }

  // F28 取证：开关开着就把原始帧逐行落盘（见 dumpSinkPath 的说明），失败不影响主流程。
  const dumpPath = dumpSinkPath()
  for await (const line of iterateLines(body)) {
    if (dumpPath) {
      try {
        appendFileSync(dumpPath, line + '\n')
      } catch {
        /* 取证是尽力而为 */
      }
    }
    if (line.length === 0) {
      // 空行 = 事件结束
      const flushed = flushData()
      for (const event of flushed.events) yield event
      if (flushed.done) return
      eventName = ''
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      // 新事件名出现 = 上一个事件结束（有些实现不补空行，这里也要收口）
      const flushed = flushData()
      for (const event of flushed.events) yield event
      if (flushed.done) return
      eventName = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
      continue
    }
  }
  // 流结束：末尾可能没有空行，攒下的 data 不能丢
  const tail = flushData()
  for (const event of tail.events) yield event
  if (tail.done) return
  for (const event of state.finish()) yield event
}

// ── 完成请求 ──────────────────────────────────────────────

// ── 会话复用（2026-09-12 实测判定后新增）────────────────────

/**
 * 复用一个网页端会话最多发多少次请求，超过就换一个新的；0 = 关闭复用（回到「每请求一个会话」）。
 *
 * 为什么可以复用（**实测**，不是推理）：
 * 每次 completion 都发 `parent_message_id: null` → 每条消息都是会话里的**根消息**、没有父链，
 * 服务端按消息树回溯上下文时回溯到空。判定实验（2026-09-12）：同一会话先发
 * 「记住编号 ZC-7391-KX，只回 OK」→ 得到 `OK`；再问「编号是什么」→ 答 `不知道`。
 * 证明同会话历史**不会**进入上下文。
 * （0.1.21 注释里「复用会让上下文翻倍」的说法是未经实测的推理，已被这次实验推翻。）
 *
 * 收益：实测 2026-09-12 一天建了 182 个网页端会话（峰值 74 个/小时、最密 8 个/分钟），
 * 因为每个 DSH 回合 = 建一个会话、用完再删一个 —— 真人不会这样建删对话。
 * 复用后建会话数降到「轮次 / N」。
 */
export const DEFAULT_SESSION_REUSE_TURNS = 20

/** 复用槽：同一账号当前可复用的会话。key 是凭证摘要（不进日志、不拿明文当键）。 */
/**
 * 复用槽。`cleanup` 记录**这个会话归谁回收**（2026-09-13 审计 N04）：
 * 切号时旧槽要交回**原账号**的清理回调，不能用当前账号的去删别人的会话。
 */
let reuseSlot: { key: string; sessionId: string; turns: number; cleanup?: (id: string) => void } | undefined

/**
 * 链式投喂的链状态（2026-09-14）。只跟随**正在复用的那个会话**：
 * 会话轮换、切号、请求失败/取消、流被污染，都会让它作废 —— 下一轮自动退回全量重发。
 * 判定逻辑在 context-feed.ts（纯函数），这里只负责"喂进去 + 按结果记下来"。
 */
let contextChain: ChainState | undefined

/**
 * 上一次上报过的决策原因（0.1.63）。链式投喂的决策每轮都在做，
 * 但"原因"通常连续几百轮都不变 —— 只在**变化时**上报，日志才不会被刷满，
 * 同时"哪一轮开始退回全量、为什么"又一定能看见。
 */
let lastFeedReason: FeedReason | undefined

/** 丢弃当前的链（会话退役/测试隔离用）。 */
export function resetContextChain(): void {
  contextChain = undefined
  lastFeedReason = undefined
}

/** 给状态页看：当前链式投喂是否真的在跑（没用链式就返回 undefined）。 */
export function contextChainInfo(): { sessionId: string; turns: number; parentId: number } | undefined {
  if (!contextChain) return undefined
  return {
    sessionId: contextChain.sessionId,
    turns: contextChain.entries.length,
    parentId: contextChain.parentId,
  }
}

/** 凭证摘要：只用来判断「是不是同一个账号」。不做安全用途、不落日志。 */
function accountKey(auth: WebAuth): string {
  const raw = `${auth?.token ?? ''}|${auth?.cookie ?? ''}`
  let hash = 2166136261
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

interface SessionLease {
  sessionId: string
  reused: boolean
}

async function leaseSession(
  auth: WebAuth,
  signal: AbortSignal,
  transport: CompletionTransport,
  maxTurns: number,
  cleanup?: (id: string) => void,
): Promise<SessionLease> {
  signal.throwIfAborted()
  const key = accountKey(auth)
  const limit = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : DEFAULT_SESSION_REUSE_TURNS
  // 关闭复用：每次都要新会话（调用方会自己回收）
  if (limit === 0) return { sessionId: await transport.createSession(auth, signal), reused: false }
  if (reuseSlot && reuseSlot.key === key && reuseSlot.turns < limit) {
    reuseSlot.turns += 1
    return { sessionId: reuseSlot.sessionId, reused: true }
  }
  // ⚠️ N04：轮换/切号时，旧槽必须交给**它自己的** cleanup 归还。
  // 旧实现只在"同账号轮换"时返回 retired、切号时直接覆盖旧槽 ——
  // 后者等于把旧会话的清理归属丢掉了（永远不会有人删它）。
  const previous = reuseSlot
  const sessionId = await transport.createSession(auth, signal)
  if (signal.aborted) {
    // 建会话期间被取消：这个会话还没人认领，就地回收，别留垃圾
    try {
      cleanup?.(sessionId)
    } catch {}
    signal.throwIfAborted()
  }
  reuseSlot = { key, sessionId, turns: 1, ...(cleanup ? { cleanup } : {}) }
  // 落账：这个会话进了复用槽，此刻**还没删**。宿主据此落盘 —— 否则进程被强杀时
  // 槽里的会话（每次退出必留一个）永远没人回收。
  emitSessionLifecycle({ kind: 'leased', auth, sessionId })
  if (previous) {
    try {
      previous.cleanup?.(previous.sessionId)
    } catch {}
  }
  return { sessionId, reused: false }
}

/** 把某个会话从复用槽里摘掉（会话失效 / 请求失败时调用，下次会新建）。 */
export function retireSession(sessionId?: string): void {
  if (!sessionId || (reuseSlot && reuseSlot.sessionId === sessionId)) reuseSlot = undefined
  // 会话被退役 ⇒ 它的链也失效（留着会让下一轮"续"到一个已经不存在的父消息上）。
  if (!sessionId || contextChain?.sessionId === sessionId) contextChain = undefined
}

/**
 * 卸载/退出时的收尾：把复用槽里的会话**交回它自己的清理回调**，然后清空槽。
 *
 * 为什么必须单独有这个函数（2026-09-14）：`retireSession()` 只是把槽清掉，
 * 排队删除是槽里那个 `cleanup` 干的活 —— 直接清槽等于把待删的会话一起丢了，
 * 它就会永远留在网页端（每次退出必留一个，实测就是这样堆起来的）。
 *
 * 返回被退役的 sessionId（没有则 `undefined`），调用方可以据此记账/打日志。
 * 注意它**只排队**、不等删除完成；删不掉的部分由 `session-journal.ts` 兜底，
 * 记录只在"确认删掉"时才被摘掉，所以强杀也能在下次启动补删。
 */
export function disposeSessionReuse(): string | undefined {
  const slot = reuseSlot
  contextChain = undefined
  if (!slot) return undefined
  reuseSlot = undefined
  try {
    slot.cleanup?.(slot.sessionId)
  } catch {
    /* 排队失败不影响卸载 */
  }
  return slot.sessionId
}

/** 只给测试用：清空复用槽。 */
export function resetSessionReuse(): void {
  reuseSlot = undefined
  contextChain = undefined
  // 决策回执的状态也是模块级的（见 lastFeedReason），一并清掉，测试之间才互不干扰
  lastFeedReason = undefined
}

/** 链式投喂的决策回执（见 CompletionParams.onContextFeed）。 */
export interface FeedReport {
  /** 决策原因 —— chained = 真的发了增量；其余都是"退回全量"的具体理由。 */
  reason: FeedReason
  /** true = 本轮只发了增量；false = 本轮重发了全量 prompt。 */
  chained: boolean
  /** 实际写进请求体的 prompt 长度（chained 时就是增量大小）。 */
  promptChars: number
}

export interface CompletionParams {
  prompt: string
  /**
   * 链式投喂用：`prompt` 的结构化拆分（`head` = 系统+协议+工具目录，`entries` = **未截断**的历史条目）。
   * 不传 = 算不出"新增了哪几条"，只能走全量 —— 适配器两条序列化路径都要传，
   * 漏传会让链式模式静默退化成全量（靠 tests/check-bundle.mjs 的产物断言守）。
   */
  promptParts?: { head: string; entries: readonly string[]; maxChars?: number }
  /**
   * 链式投喂的决策回执（0.1.63）。**只在决策原因变化时**回调一次，
   * 用来回答"这一轮到底发了增量，还是退回全量、因为哪条判据"——
   * 没有它，0.1.62 的链式投喂在日志里是完全不可见的。
   */
  onContextFeed?: (report: FeedReport) => void
  thinkingEnabled: boolean
  searchEnabled?: boolean
  modelType: 'default' | 'expert' | 'vision'
  /** 已上传文件的 file_id（图片输入：随请求引用，模型据此看图）。 */
  refFileIds?: readonly string[]
  signal?: AbortSignal
  idleTimeoutMs?: number
  /**
   * 建连阶段（建会话 + PoW + 等到响应头）的整体期限，默认 45 秒。
   * 抽成可注入是为了能离线验证「建连挂住必须被中断」——这段原本没有统一限时，
   * 是审计 F10 指出的"可无限等待"（idle watchdog 要到响应头之后才启动）。
   */
  connectTimeoutMs?: number
  /** 同一会话复用的轮次上限（0 = 每请求一个会话，用完即删）。 */
  sessionReuseTurns?: number
  onDeleteSession?: (sessionId: string) => void
}

/**
 * 会话/请求的可注入传输层（默认就是真实实现）。
 * 抽出来是为了能在单测里确定性地复现「会话失效 → 重建重试」与「删除时机」这两条路径，
 * 不必真的打网络（这两处正是反复出问题的地方）。
 */
export interface CompletionTransport {
  createSession: (auth: WebAuth, signal?: AbortSignal) => Promise<string>
  powHeader: (auth: WebAuth, targetPath: string, signal?: AbortSignal) => Promise<string>
}

const defaultTransport: CompletionTransport = { createSession: createChatSession, powHeader: createPowHeader }

/**
 * 打开一次 completion 请求（建会话 + PoW + 发送），返回可用的会话与响应。
 *
 * 非 SSE 响应（HTTP 200 上裹着业务错误信封）在这里统一裁决：
 *  - 会话失效（invalid chat session id）→ **换一个新会话透明重试一次**（用户无感）；
 *  - 其它业务错误 → 按业务码抛出（AUTH / RATE_LIMIT / PROVIDER_ERROR…）。
 */
async function openCompletion(
  auth: WebAuth,
  params: CompletionParams,
  signal: AbortSignal,
  transport: CompletionTransport,
): Promise<{ sessionId: string; resp: Response; feed: FeedDecision }> {
  let lastFailure: AdapterLlmError | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = await leaseSession(
      auth,
      signal,
      transport,
      params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
      params.onDeleteSession,
    )
    const sessionId = lease.sessionId
    // 链式投喂：决定本轮发全量还是增量、parent 指向谁。判据在 context-feed.ts（纯函数）：
    // 模式=chained 且「复用了同一会话 + 条目严格追加 + 头部/账号都没变」才发增量，
    // 任何一条不满足都退回全量 + parent=null（= 0.1.61 及以前的行为）。
    const feed = decideFeed({
      mode: currentContextMode(),
      ...(params.promptParts
        ? {
            head: params.promptParts.head,
            entries: params.promptParts.entries,
            ...(params.promptParts.maxChars !== undefined ? { maxChars: params.promptParts.maxChars } : {}),
          }
        : {}),
      full: params.prompt,
      sessionId,
      accountKey: accountKey(auth),
      reused: lease.reused,
      ...(contextChain ? { chain: contextChain } : {}),
    })
    // 决策回执（0.1.63）：只在原因变化时上报一次，让日志能回答"这一轮为什么没走增量"。
    if (feed.reason !== lastFeedReason) {
      lastFeedReason = feed.reason
      params.onContextFeed?.({
        reason: feed.reason,
        chained: feed.parentMessageId !== null,
        promptChars: feed.prompt.length,
      })
    }
    let resp: Response
    try {
      resp = await activeFetch(`${DS_BASE}/api/v0/chat/completion`, {
        method: 'POST',
        headers: {
          ...buildDsHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
          accept: 'text/event-stream',
          'x-ds-pow-response': await transport.powHeader(auth, '/api/v0/chat/completion', signal),
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          // 链式投喂时是上一条 assistant 的 message_id；全量模式恒为 null（根消息、无父链）。
          parent_message_id: feed.parentMessageId,
          prompt: feed.prompt,
          ref_file_ids: params.refFileIds ?? [],
          thinking_enabled: params.thinkingEnabled,
          search_enabled: params.searchEnabled ?? false,
          model_type: params.modelType,
          action: null,
          preempt: false,
        }),
        signal,
      })
    } catch (error: any) {
      retireSession(sessionId)
      params.onDeleteSession?.(sessionId)
      // ⚠️ N04：**先放行已经是 AdapterLlmError 的错误**。
      // 旧写法无条件包成 TRANSPORT，会把 PoW/网络层带出来的 AUTH / RATE_LIMIT
      // 等结构化分类抹掉 —— 宿主于是按"可重试的传输错误"处理本该停止重试的情况。
      if (error instanceof AdapterLlmError) throw error
      if (params.signal?.aborted) throw new AdapterLlmError('DeepSeek web request aborted by caller', 'ABORTED', { cause: error })
      throw new AdapterLlmError(`DeepSeek web request failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const code = httpErrorCode(resp.status)
      const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
      const hint =
        code === 'AUTH'
          ? ' —— 网页登录态可能已过期，请到「设置 → DeepSeek 网页登录」重新登录'
          : code === 'RATE_LIMIT'
            ? ' —— 网页端频控（免费额度），稍后重试即可'
            : ''
      retireSession(sessionId) // 失败即弃，下次换新会话
      params.onDeleteSession?.(sessionId)
      throw new AdapterLlmError(
        `DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}${hint}`,
        code,
        { status: resp.status, ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}), cause: new Error(text) },
      )
    }
    if (!resp.body) {
      retireSession(sessionId)
      params.onDeleteSession?.(sessionId)
      throw new AdapterLlmError('DeepSeek web completion returned no body', 'EMPTY_RESPONSE')
    }

    // HTTP 200 也可能是「业务错误信封」或 HTML 挑战页 —— 非 SSE 一律先当错误处理
    const contentType = String(resp.headers.get('content-type') ?? '')
    if (contentType.includes('text/event-stream')) return { sessionId, resp, feed }

    const text = await resp.text().catch(() => '')
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {}
    const biz = envelopeError(parsed)
    const muted = isMutedError(biz)
    const busy = !muted && !!biz && isBusyGenerating(biz.msg)
    const untilMs = muteUntilMs(parsed)
    const failure = biz
      ? new AdapterLlmError(
          muted
            ? mutedMessage(untilMs)
            : busy
              ? 'DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口/标签页正在用同一账号生成）。这一步会自动重试；若两个窗口都要用网页模型，建议其中一个换 provider 或换账号。'
              : bizErrorMessage(biz.code, biz.msg),
          muted || busy ? 'RATE_LIMIT' : isInvalidSessionError(biz) ? 'TRANSPORT' : bizErrorCode(biz.code),
          {
            status: resp.status,
            // 解除时间远大于重试策略的上限 → dsh-llm-retry 会直接放弃重试（而不是空转打请求）
            ...(muted && untilMs !== undefined ? { providerRetryAfterMs: Math.max(0, untilMs - Date.now()) } : {}),
            // 绝对值单独带一份：宿主会把它记到账号上，在设置页显示倒计时
            ...(muted && untilMs !== undefined ? { mutedUntilMs: untilMs } : {}),
            ...(busy ? { providerRetryAfterMs: 5_000 } : {}),
          },
        )
      : new AdapterLlmError(
          `DeepSeek 网页端返回了非流式响应（content-type: ${contentType || 'unknown'}）：${text.slice(0, 200)}`,
          'MALFORMED_RESPONSE',
          { status: resp.status },
        )
    retireSession(sessionId) // 这个会话已经废了，顺手回收，不留垃圾
    params.onDeleteSession?.(sessionId)
    if (attempt === 0 && biz && isInvalidSessionError(biz)) {
      lastFailure = failure
      continue
    }
    throw failure
  }
  throw lastFailure ?? new AdapterLlmError('DeepSeek 网页端无法建立可用会话', 'PROVIDER_ERROR')
}

/**
 * 发起一次网页版完成请求并流式产出事件；会话在**流结束之后**尽力删除。
 *
 * ⚠️ 删除时机是这个模块最容易被写错的地方（2026-09-11 实测故障）：
 * 旧实现把 `onDeleteSession` 放在**建会话之后立刻**调用，而它内部是「延迟 1.5s 删除」，
 * 于是会话可能在 completion 请求发出之前就被自己删掉 —— 若 PoW 求解 + 建连超过 1.5s，
 * 服务端回
 *   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
 * 更隐蔽的是「生成进行到一半会话消失」，服务端可能直接掐断流 —— 表现就是回答说半句就停、
 * 工具调用没收全（正是我们一直在追的那类截断）。
 * 现在删除只发生在 finally（流正常结束、报错或调用方中止都算），会话在整个请求期间都活着。
 */
/** 复用模式下的"飞行互斥"：保证同一时刻只有一个复用请求在跑，避免轮换撞上并发。 */
let reuseFlightTail: Promise<void> = Promise.resolve()

export async function* streamWebCompletion(
  auth: WebAuth,
  params: CompletionParams,
  transport: CompletionTransport = defaultTransport,
): AsyncGenerator<WebStreamEvent> {
  const controller = new AbortController()
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal
  const rawLimit = params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : DEFAULT_SESSION_REUSE_TURNS

  let release: (() => void) | undefined
  let sessionId: string | undefined
  let iterator: AsyncGenerator<WebStreamEvent> | undefined
  let body: any
  let complete = false
  let poisoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 本轮实际发出去了什么（链式投喂据此记账；见 finally 里的链更新）。 */
  let sentFeed: FeedDecision | undefined
  /** 首帧 `event: ready` 给的 assistant message_id —— 就是下一轮的 parent_message_id。 */
  let responseMessageId: number | undefined
  /** 同一个会话只回收一次（复用/轮换/失败三条路径可能都想回收它）。 */
  const deleted = new Set<string>()
  const cleanup = (id: string): void => {
    if (deleted.has(id)) return
    deleted.add(id)
    try {
      params.onDeleteSession?.(id)
    } catch {}
  }
  /** 让等待可被取消：abort 时立刻 reject，不等定时器/对端。 */
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        promise.catch(() => {})
        reject(signal.reason)
        return
      }
      const abort = () => {
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
    })
  const arm = (ms: number, message: string): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new AdapterLlmError(message, 'TIMEOUT')), ms)
    ;(timer as any).unref?.()
  }

  /**
   * F10：外层拥有本次调用创建过的**全部**会话。
   *
   * 建连阶段没有统一限时时，`createSession` 之后、响应头之前的任何失败都会让
   * 「已建出来但还没人认领」的会话漏在服务端；`openCompletion` 内部的失败分支只覆盖
   * 它自己 catch 得到的错误。超时/取消会**放弃**进行中的 `openCompletion`（不再等它），
   * 所以必须在这里兜住它后续才返回的那些会话。
   */
  const owned = new Set<string>()
  let finalized = false
  const tracked: CompletionTransport = {
    ...transport,
    createSession: async (value, sig) => {
      const id = await transport.createSession(value, sig)
      if (finalized) {
        // 已经收尾了才建出来（超时之后仍在跑的建连）→ 立刻归还，别留给下一次请求
        retireSession(id)
        cleanup(id)
      } else {
        owned.add(id)
      }
      return id
    },
  }

  try {
    signal.throwIfAborted()
    // N04：复用开启时全程串行（含跨账号）—— 共享槽位要一致的并发状态；
    // 关闭复用时保持原并发模式（每次自己建会话，彼此独立）。
    if (limit > 0) {
      const previous = reuseFlightTail
      const mine = new Promise<void>((resolve) => {
        release = resolve
      })
      reuseFlightTail = previous.then(
        () => mine,
        () => mine,
      )
      await wait(previous)
    }
    const connectMs =
      Number.isFinite(params.connectTimeoutMs) && (params.connectTimeoutMs as number) > 0
        ? Math.min(params.connectTimeoutMs as number, 600_000)
        : 45_000
    arm(connectMs, `DeepSeek 建立流超时（${connectMs}ms）`)
    // F10：**用 wait() 包住** —— 建连期限靠 controller.abort 生效，而 abort 只对
    // 「肯配合 signal 的传输」立即生效。包一层之后，即使底层 promise 永远不结算，
    // 等待也会在 abort 的瞬间结束（否则「限时」形同虚设，会一直挂在 await 上）。
    const opened = await wait(
      openCompletion(
        auth,
        { ...params, sessionReuseTurns: limit, onDeleteSession: cleanup },
        signal,
        tracked,
      ),
    )
    sessionId = opened.sessionId
    sentFeed = opened.feed
    body = opened.resp.body
    if (timer) clearTimeout(timer)
    iterator = parseWebSse(body, {
      thinkingEnabled: params.thinkingEnabled,
      onResponseMessageId: (id) => {
        responseMessageId = id
      },
    })
    const idle =
      Number.isFinite(params.idleTimeoutMs) && (params.idleTimeoutMs as number) > 0
        ? Math.min(params.idleTimeoutMs as number, 600_000)
        : 120_000
    for (;;) {
      arm(idle, `DeepSeek 流等待超时（${idle}ms）`)
      const item = await wait(iterator.next())
      if (timer) clearTimeout(timer)
      if (item.done) {
        complete = true
        break
      }
      if (item.value.kind === 'error') poisoned = true
      yield item.value
    }
  } catch (error: any) {
    if (params.signal?.aborted) throw new AdapterLlmError('请求已取消', 'ABORTED', { cause: error })
    if (controller.signal.aborted && controller.signal.reason instanceof AdapterLlmError) throw controller.signal.reason
    if (error instanceof AdapterLlmError) throw error
    throw new AdapterLlmError('DeepSeek 流请求失败', 'TRANSPORT', { cause: error })
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    // 主链不等待不合作的假/自定义流（否则仍会阻塞所有复用请求）
    if (iterator) {
      void iterator
        .return(undefined)
        .catch(() => {})
        .finally(() => {
          if (body && !body.locked) void body.cancel().catch(() => {})
        })
    }
    // N04：**提前结束（调用方 return / 取消）也必须退役会话**。
    // 旧实现只在 HTTP 失败分支退役，stream generator 被提前 return 时不退役 ——
    // 于是下一次请求会接着用一个"上一条流还没消费完"的会话。
    // F10：改成遍历本次创建过的**全部**会话；唯一放过的只有「正常跑完且仍在复用」的那个。
    finalized = true
    for (const id of owned) {
      if (id === sessionId && complete && !poisoned && limit > 0) continue
      retireSession(id)
      cleanup(id)
    }
    // 链式投喂的记账（2026-09-14）：只有「流正常跑完 + 没被污染 + 拿到了本轮的
    // assistant message_id」才把这链接上；其余（报错/取消/提前 return/没收到 ready）
    // 一律作废 —— 下一轮 decideFeed 会看到"没有链"，自动退回全量重发。
    // 注意这里按**每一次请求**记账（一轮里可能有首轮 + 续写轮多次调用），不是按 DSH 回合：
    // 续写轮的增量与 parent 正是靠这次记账才对得上。
    if (sentFeed?.next && complete && !poisoned && typeof responseMessageId === 'number') {
      contextChain = { ...sentFeed.next, parentId: responseMessageId }
    } else if (contextChain && (!sessionId || contextChain.sessionId === sessionId)) {
      contextChain = undefined
    }
    release?.()
  }
}
