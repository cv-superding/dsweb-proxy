/**
 * 配置加载 —— 单一来源：`${webLoginDir()}/proxy.json`。
 * DSH 插件时代的 gate.json / context-feed.json 继续沿用（共享同一状态目录），
 * 这里只放反代自身的新配置（监听端口、API key 门禁、各 provider 覆盖项）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { webLoginDir } from './core/paths.ts'

export interface ProxyConfig {
  /**
   * 服务开关：false = 壳启动时不自动拉起反代（用户可在控制台手动启动）。
   * 默认 true（装上就能用）。
   */
  enabled?: boolean
  /** HTTP 监听端口（默认 8787）。改端口需重启服务（控制台会提示）。 */
  port: number
  /** 监听地址（默认 127.0.0.1，仅本机）。 */
  host: string
  /**
   * API key 门禁：设置后 /v1/* 请求必须带 `Authorization: Bearer <key>`。
   * 本机监听下可选；设了就强制校验（多机共享时必设）。
   */
  apiKey?: string
  /**
   * 自动轮转：遇「账号级限制 / 登录态失效」时自动切到库里下一个可用账号（默认开）。
   * 普通频控（发太快）不切号 —— 退避重试；多号连轰是更强的多开特征。
   */
  rotation: boolean
  /** deepseek-web 专属覆盖项（缺省用 core/gate.ts 的内置默认）。 */
  deepseek?: {
    minRequestIntervalMs?: number
    maxRequestIntervalMs?: number
    maxPromptChars?: number
    maxRefImages?: number
    autoContinue?: boolean
    maxContinuations?: number
    deleteWebSessions?: boolean
    sessionCleanup?: 'immediate' | 'deferred' | 'keep'
    thinkingByModel?: { 'deepseek-chat'?: boolean; 'deepseek-reasoner'?: boolean }
  }
}

export const DEFAULT_CONFIG: ProxyConfig = {
  enabled: true,
  port: 8787,
  host: '127.0.0.1',
  rotation: true,
}

export function proxyConfigPath(): string {
  return `${webLoginDir()}/proxy.json`
}

export function readProxyConfig(): ProxyConfig {
  try {
    const raw = JSON.parse(readFileSync(proxyConfigPath(), 'utf8'))
    const merged: ProxyConfig = { ...DEFAULT_CONFIG, ...raw, deepseek: { ...DEFAULT_CONFIG.deepseek, ...raw?.deepseek } }
    // 配置是用户手改的：端口越界/NaN 一律回落默认，否则服务根本 listen 不起来。
    if (!Number.isInteger(merged.port) || merged.port < 1024 || merged.port > 65535) merged.port = DEFAULT_CONFIG.port
    if (typeof merged.host !== 'string' || !merged.host) merged.host = DEFAULT_CONFIG.host
    if (merged.enabled !== false) merged.enabled = true
    if (typeof merged.rotation !== 'boolean') merged.rotation = true
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeProxyConfig(config: ProxyConfig): void {
  mkdirSync(webLoginDir(), { recursive: true })
  writeFileSync(proxyConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}

/**
 * 运行时配置缓存。
 *
 * 为什么要缓存：provider 每次 chat 都要读 rotation 开关，而 readProxyConfig() 是**读盘**；
 * 每轮请求读一次文件既慢又没必要。这里 1 秒 TTL 足够让「控制台改完立即生效」成立，
 * 又不会把磁盘打热。
 *
 * 注意：改端口/监听地址**不能**靠它热生效 —— 那需要重新 listen，由壳重启 sidecar 完成；
 * apiKey / rotation / enabled 都是每次请求读取，改完立即生效。
 */
let cached: { at: number; config: ProxyConfig } | undefined

export function runtimeConfig(): ProxyConfig {
  const now = Date.now()
  if (cached && now - cached.at < 1000) return cached.config
  const config = readProxyConfig()
  cached = { at: now, config }
  return config
}

/** 控制台保存配置后调用：让下一次 runtimeConfig() 立刻重读，不必等 TTL。 */
export function invalidateRuntimeConfig(): void {
  cached = undefined
}

/** 默认端口（UI 与文档共用同一份数字）。 */
export const DEFAULT_PORT = DEFAULT_CONFIG.port
