# dsweb-proxy

<p align="center">
  <img src="docs/assets/banner-dsweb-proxy.png" alt="dsweb-proxy — 网页版登录态 → OpenAI 兼容反代" width="100%">
</p>

**网页版 → OpenAI 兼容反代**：复用你已登录的网页版账号（不用 API Key、走免费额度），在本机起一个 OpenAI 协议兼容的 HTTP 服务，ZCode / 任何 OpenAI 客户端都能直接把它们当模型用。

| Provider | 网页端 | 模型 id | 登录方式 |
|---|---|---|---|
| `deepseek-web` | chat.deepseek.com | `deepseek-chat` / `deepseek-reasoner` | CDP 浏览器登录 / token |
| `qwen-web` | chat.qwen.ai | `qwen3-max` / `qwen3-coder-plus` / 动态目录 | CDP 浏览器登录（localStorage token） |
| `doubao-web` | www.doubao.com | `doubao-chat` / `doubao-thinking` | CDP 浏览器登录（sessionid cookie） |

ZCode 侧**零配置路由**：模型名以 `qwen` 开头自动走千问，`doubao` 开头自动走豆包，其余走 DeepSeek。每家厂商独立账号库（`accounts/`、`accounts-qwen/`、`accounts-doubao/`），互不干扰；限流/封号自动轮转按厂商独立执行。

```
ZCode agent loop ──▶ http://127.0.0.1:8787/v1/chat/completions
                       dsweb-proxy（Node 核心）
                         ├─ OpenAI messages → 对话转写序列化
                         ├─ OpenAI tools   → 提示词工具协议（流式解析回 tool_calls）
                         ├─ PoW / 临时会话 / SSE / 图片上传（webapi.ts）
                         ├─ 串行 + 随机间隔节流（gate.ts）
                         └─ 自动续写（60s 截断兜底）
                     ──▶ chat.deepseek.com
```

多厂商预留：`src/registry.ts` 里注册一行即可接入新厂商（豆包 / 千问 / ChatGPT），
每个厂商只需实现 `src/provider-types.ts` 的 `WebProxyProvider` 接口。

## 快速开始

### 1. 启动

```bash
# 方式 A：Tauri 桌面应用（托盘 + 控制台窗口）
dsweb-proxy.exe            # 双击即起，sidecar 自动拉起服务

# 方式 B：Node CLI
node dist/cli.cjs serve    # 默认 127.0.0.1:8787
```

### 2. 登录（首次）

```bash
dsweb-proxy login          # 拉起真实 Edge/Chrome 窗口，登录后自动捕获凭证并关闭
```

**已装过 DSH 插件的机器无需重新登录** —— 反代直接复用 `~/.dsh/web-login` 的账号库。

### 3. ZCode 接入

`~/.zcode/v2/provider_config.json` 的 `providerRules` 里加：

```json
{
  "providerId": "dsweb-proxy",
  "providerName": "DeepSeek Web (proxy)",
  "config": {
    "group": "standard-personal",
    "access": { "type": "api-key", "apiKey": "local" },
    "api": { "type": "openai-chat-completions", "baseUrl": "http://127.0.0.1:8787/v1" },
    "personalModelIds": ["deepseek-chat", "deepseek-reasoner"],
    "modelOrder": ["deepseek-chat", "deepseek-reasoner"]
  }
}
```

重启 ZCode，模型选择器里选 `DeepSeek Web (proxy)` 即可。

## 模型

| id | 思考 | 适合 |
|---|---|---|
| `deepseek-chat` | 关 | 工具调用、改写、检索 |
| `deepseek-reasoner` | 开 | 数学、多步调试、规划（推理流走 `reasoning_content`） |

## CLI

```
serve    启动反代（--port / --host 可改）
login    浏览器窗口登录（CDP 捕获 token + cookie + 指纹头）
status   登录状态（JSON）
logout   退出当前账号
token    手动粘贴 userToken
config   查看配置与 ZCode 接入片段
```

## HTTP API

| 路由 | 说明 |
|---|---|
| `GET /v1/models` | 模型目录 |
| `POST /v1/chat/completions` | 对话（`stream: true/false`，支持 tools） |
| `GET /admin/status` | 登录状态 |
| `POST /admin/login` | 触发浏览器登录 |
| `POST /admin/logout` | 退出 |
| `GET /healthz` | 探活 |

## 配置

`${DSWEB_PROXY_HOME:-~/.dsh/web-login}/proxy.json`：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "apiKey": "设了就强制 Bearer 校验",
  "deepseek": {
    "minRequestIntervalMs": 2000,
    "maxRequestIntervalMs": 4000,
    "maxPromptChars": 400000,
    "maxRefImages": 24,
    "autoContinue": true,
    "maxContinuations": 2,
    "sessionCleanup": "deferred"
  }
}
```

节流是**风控阀门**：网页端同账号并发生成会被拒，双窗口并发实测 6 分钟内触发 1 天限制。
默认 2~4 秒随机间隔（区间随机是刻意的：固定间隔方差≈0，是「定时器特征」）。
已被限流过就调到 5000~9000。

## 开发

```bash
npm install
npx tsc --noEmit                  # 类型检查
node tests/run-all.mjs            # 离线测试（61 断言，含 HTTP 端到端）
node scripts/build.mjs            # bundle → dist/cli.cjs
node scripts/build-sidecar.mjs    # SEA 单文件 exe → src-tauri/binaries/
cargo tauri build                 # 桌面应用（在 src-tauri/ 下）
```

## 已知限制（多厂商）

- 千问：网页端无原生 tools（提示词协议模拟）；请求体近 128KiB 触发阿里 WAF 挑战（RGV587_ERROR，按源 IP 风控）；`RateLimited` = 日配额耗尽；模型目录登录后动态拉取
- 豆包：字节系 `a_bogus` 签名门槛 —— 本反代走「伪签名 + sessionid」路线，遇到空回复/710022004 滑块挑战时说明该路线被拦（需换号或等风控放松）；`content_type=2008` 帧为思维链；账号级风控实测存在（换号即解）
- 豆包/千问的工具调用与 DeepSeek 一样走提示词协议（三家网页端都没有原生 function calling）

- 网页端单请求 60s 生成上限 → 反代自动续写（默认 2 轮）无缝拼接
- 工具调用走提示词协议（网页端无原生 function calling），偶发格式漂移已被
  四层过滤器 + 修复链兜住，但不保证 100%
- Node fetch 的 TLS 指纹与真实浏览器结构性不同（DSH 插件的 Chromium 传输层依赖
  Electron，此处不可用）→ 节流参数建议保守
- 同账号只开一个聊天窗口；多开并发会触发服务端临时封禁（1 天）
- 免费额度有频控；`429` 会带 `retry_after_ms` 返回

## 来源与致谢

核心协议实现（PoW / SSE patch 流 / 工具协议 / 会话卫生）移植自
[dsh-deepseek-web-login](https://github.com/cv-superding/dsh-deepseek-web-login)（Apache-2.0），
其协议情报又来自 LLM-Red-Team/deepseek-free-api 等公开项目。行为逐项实测验证。
