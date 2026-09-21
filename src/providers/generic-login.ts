/**
 * 通用网页端凭证捕获（CDP）—— 千问 / 豆包等多 provider 共用。
 *
 * 与 deepseek 的 browser-login.ts 同一套 CDP 底座，但目标页面、要抓的东西、
 * 登录判定都按厂商配置。抓到的凭证统一落库到各自 provider 的账号库分区。
 *
 * 每厂商配置三件事：
 *   loginUrl      登录页
 *   isLoggedIn    localStorage/cookie 探测（返回 true = 页面已登录）
 *   extract       抓凭证（token / cookie / headers）→ WebAuth 形状
 */
import { pickCookieMeta } from '../core/cookies.ts'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CdpClient, buildBrowserArgs, findSystemBrowser, parseDevToolsActivePort, pickExtraHeaders } from '../core/browser-login.ts'

export interface ProviderLoginConfig {
  /** provider id（决定凭证落到哪个账号库分区 + 浏览器 profile 目录）。 */
  provider: string
  loginUrl: string
  /**
   * 页面登录判定 + 凭证抽取。在页面上下文里跑 `evaluate` 拿 localStorage；
   * cookie 与请求头由 CDP 域直接取。
   */
  isLoggedIn: (page: CdpClient) => Promise<boolean>
  extract: (page: CdpClient) => Promise<{
    token: string
    userAgent: string
    cookies: Array<{ name: string; value: string; session?: boolean; expires?: number }>
    extraHeaders: Record<string, string>
  }>
}

export interface GenericLoginOutcome {
  ok: boolean
  auth?: Record<string, unknown>
  message: string
}

export function defaultProfileDir(provider: string): string {
  const base = process.env.DSWEB_PROXY_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-login')
  return join(base, `browser-profile-${provider}`)
}

/** 在调试端口的 target 列表里找一个 URL 命中 `urlTest` 的页面（与 deepseek 同逻辑）。 */
async function findPageTarget(port: number, urlTest: (url: string) => boolean, timeoutMs = 20_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = (await resp.json()) as any[]
      const page = Array.isArray(targets) ? targets.find((t) => t?.type === 'page' && urlTest(String(t.url ?? ''))) : undefined
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

/**
 * 通用登录流程：找浏览器 → 起 profile + 调试端口 → 开登录页 → 轮询登录态 → 抓凭证 → 关窗口。
 * 轮询超时 5 分钟（人在输手机号+验证码，别催）。
 */
export async function genericBrowserLogin(config: ProviderLoginConfig): Promise<GenericLoginOutcome> {
  const browser = findSystemBrowser()
  if (!browser) return { ok: false, message: '系统里没有可用的 Edge/Chrome' }

  const profileDir = defaultProfileDir(config.provider)
  mkdirSync(profileDir, { recursive: true })
  const url = config.loginUrl

  const child = spawn(browser.path, buildBrowserArgs(profileDir, url), { stdio: 'ignore', detached: false })
  try {
    // 等 DevToolsActivePort（与 deepseek browser-login 同判定）
    const portFile = join(profileDir, 'DevToolsActivePort')
    let port: number | undefined
    for (let i = 0; i < 60 && !port; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (existsSync(portFile)) {
        port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      }
      if (child.exitCode !== null) return { ok: false, message: '浏览器窗口被关闭，登录中止' }
    }
    if (!port) return { ok: false, message: '浏览器调试端口未就绪' }

    const host = new URL(config.loginUrl).host
    const page = await findPageTarget(port, (url) => url.includes(host))
    if (!page) return { ok: false, message: `浏览器里没找到 ${host} 页面` }
    const cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Network.enable').catch(() => {})
    await cdp.send('Page.enable').catch(() => {})

    // 从 /api/* 真实请求捡 UA 与额外请求头
    let apiUserAgent = ''
    // 等登录态出现（最长 5 分钟）
    const deadline = Date.now() + 5 * 60_000
    let loggedIn = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return { ok: false, message: '浏览器窗口被关闭，登录中止' }
      try {
        loggedIn = await config.isLoggedIn(cdp)
      } catch {
        /* 页面还在跳转，忽略 */
      }
      if (loggedIn) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (!loggedIn) {
      cdp.close()
      child.kill()
      return { ok: false, message: '等待登录超时（5 分钟）' }
    }

    const extracted = await config.extract(cdp)
    cdp.close()
    child.kill()

    return {
      ok: true,
      message: '登录成功',
      auth: {
        token: extracted.token,
        cookie: extracted.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        cookieMeta: pickCookieMeta(extracted.cookies as any, () => true),
        userAgent: extracted.userAgent,
        ...(Object.keys(extracted.extraHeaders).length > 0 ? { extraHeaders: extracted.extraHeaders } : {}),
        capturedAt: new Date().toISOString(),
      },
    }
  } catch (error: any) {
    try {
      child.kill()
    } catch {}
    return { ok: false, message: `登录失败：${error?.message ?? error}` }
  }
}

export { pickExtraHeaders }
