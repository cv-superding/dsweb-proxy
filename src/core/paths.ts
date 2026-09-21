/**
 * 路径解析 —— 单独成文件，避免 auth.ts ↔ accounts.ts 互相 import 形成环。
 *
 * dsweb-proxy 的状态目录解析顺序：
 *   1. DSWEB_PROXY_HOME（显式指定，测试与 Tauri 壳用）
 *   2. DSH_HOME/web-login —— 与 DSH 插件共享旧状态（平滑迁移，凭证不用重登）
 *   3. ~/.dsweb-proxy —— 全新安装的缺省位置
 *
 * 兼容说明：DSH 插件把状态放在 `${DSH_HOME || ~/.dsh}/web-login/`。本反代保留同一
 * 解析顺序作为缺省，让已装过 DSH 插件的机器**零迁移**复用登录态与账号库。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 反代自己的主目录（与 DSH 生态兼容的解析顺序）。 */
export function resolveProxyHome(): string {
  if (process.env.DSWEB_PROXY_HOME) return process.env.DSWEB_PROXY_HOME
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'web-login')
}

/** 反代的状态目录（凭证 / 账号库 / 配置 / 台账都放这里）。 */
export function webLoginDir(): string {
  return resolveProxyHome()
}

/**
 * 旧版单账号凭证文件（DSH 插件 0.1.25 及以前只有这一个账号）。
 * 账号库接管后这个路径仍要认得 —— 用来做一次性迁移。
 */
export function legacyAuthFilePath(): string {
  return join(webLoginDir(), 'deepseek-auth.json')
}

/**
 * DSH 插件时代的登录态目录（仅迁移探测用）。
 * 若反代主目录为空而它有账号，可以整目录拷过来复用。
 */
export function legacyDshWebLoginDir(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-login')
}
