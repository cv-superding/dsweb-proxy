/**
 * Provider 注册表 —— 新增厂商只需在这里 import + register 一行。
 *
 * 预留路线（按接入难度排序，接口已按需预留）：
 *  - 豆包（doubao.com 网页版）：PoW/签名类，SSE 形态与 deepseek 相近
 *  - 千问（tongyi.aliyun.com / chat.qwen.ai）：有原生 function calling 的可能，届时
 *    NormalizedRequest.tools 可直传，不必走提示词协议
 *  - ChatGPT（chatgpt.com）：登录壁垒最高（Cloudflare），大概率要走浏览器内 fetch 桥
 */
import type { WebProxyProvider } from './provider-types.ts'

const registry = new Map<string, () => WebProxyProvider>()

export function registerProvider(id: string, factory: () => WebProxyProvider): void {
  if (registry.has(id)) throw new Error(`provider "${id}" 已注册`)
  registry.set(id, factory)
}

export function listProviderIds(): string[] {
  return [...registry.keys()]
}

export function createProvider(id: string): WebProxyProvider {
  const factory = registry.get(id)
  if (!factory) throw new Error(`未知 provider "${id}"（已注册：${[...registry.keys()].join(', ')}）`)
  return factory()
}

// ── 内置 provider 装配 ──
// 首次调用才实例化（登录窗口、探活循环都延迟到真正用到时启动）。
import { DeepseekWebProvider } from './providers/deepseek.ts'
import { QwenWebProvider } from './providers/qwen.ts'
import { DoubaoWebProvider } from './providers/doubao.ts'
registerProvider('deepseek-web', () => new DeepseekWebProvider())
registerProvider('qwen-web', () => new QwenWebProvider())
registerProvider('doubao-web', () => new DoubaoWebProvider())
