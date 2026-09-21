#!/usr/bin/env node
/**
 * dsweb-proxy CLI —— serve / login / status / logout / config。
 *
 * 用法：
 *   dsweb-proxy serve [--port 8787] [--host 127.0.0.1]
 *   dsweb-proxy login          # 拉起真实 Edge/Chrome 登录窗口（CDP 捕获凭证）
 *   dsweb-proxy status
 *   dsweb-proxy logout
 *   dsweb-proxy token <userToken>   # 手动粘 token（非交互环境）
 */
import { startServer } from './server/http.ts'
import { readProxyConfig, writeProxyConfig, type ProxyConfig } from './config.ts'
import { createProvider } from './registry.ts'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      args[key] = value
    }
  }
  return args
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const provider = createProvider('deepseek-web')

  switch (command) {
    case 'serve': {
      const config: ProxyConfig = { ...readProxyConfig() }
      if (args.port) config.port = Number(args.port)
      if (args.host) config.host = args.host
      const handle = await startServer(config)
      const status = await provider.status()
      console.log(`[dsweb-proxy] http://${handle.host}:${handle.port}/v1`)
      console.log(`[dsweb-proxy] 登录状态：${status.loggedIn ? `已登录${status.display ? `（${status.display}）` : ''}` : '未登录 —— 先运行 dsweb-proxy login'}`)
      console.log('[dsweb-proxy] ZCode 接入：provider_config.json 里把 baseUrl 指到上面的 /v1，模型选 deepseek-chat / deepseek-reasoner')
      // 保活：Ctrl+C 退出
      process.on('SIGINT', async () => {
        await handle.close()
        process.exit(0)
      })
      return
    }
    case 'login': {
      console.log('[dsweb-proxy] 拉起浏览器登录窗口（登录完成后窗口自动关闭）……')
      const outcome = await provider.login()
      console.log(`[dsweb-proxy] ${outcome.message}`)
      process.exit(outcome.ok ? 0 : 1)
      break
    }
    case 'status': {
      const status = await provider.status()
      console.log(JSON.stringify(status, null, 2))
      return
    }
    case 'logout': {
      const outcome = await provider.logout()
      console.log(`[dsweb-proxy] ${outcome.message}`)
      return
    }
    case 'token': {
      const token = rest[0]
      if (!token) {
        console.error('用法：dsweb-proxy token <userToken>')
        process.exit(2)
      }
      const { commitCapturedAuth } = await import('./providers/account-ctx.ts')
      commitCapturedAuth({ token } as any)
      console.log('[dsweb-proxy] token 已写入当前账号（校验会在首次请求时进行）')
      return
    }
    case 'config': {
      // 输出当前配置与 ZCode provider_config.json 的接入片段
      const config = readProxyConfig()
      console.log(JSON.stringify(config, null, 2))
      console.log('\n// ZCode provider_config.json 接入片段（加进 providerRules）：')
      console.log(
        JSON.stringify(
          {
            providerId: 'dsweb-proxy',
            providerName: 'DeepSeek Web (proxy)',
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: config.apiKey ?? 'local' },
              api: { type: 'openai-chat-completions', baseUrl: `http://${config.host}:${config.port}/v1` },
              personalModelIds: ['deepseek-chat', 'deepseek-reasoner'],
              modelOrder: ['deepseek-chat', 'deepseek-reasoner'],
            },
          },
          null,
          2,
        ),
      )
      return
    }
    default:
      console.error(
        '用法：dsweb-proxy <serve|login|status|logout|token|config>\n' +
          '  serve   启动 OpenAI 兼容反代（默认 127.0.0.1:8787）\n' +
          '  login   浏览器窗口登录（CDP 捕获凭证）\n' +
          '  status  登录状态\n' +
          '  logout  退出当前账号\n' +
          '  token   手动粘贴 userToken\n' +
          '  config  查看配置与 ZCode 接入片段',
      )
      process.exit(command ? 2 : 0)
  }
}

main().catch((error) => {
  console.error(`[dsweb-proxy] ${error?.stack ?? error}`)
  process.exit(1)
})
