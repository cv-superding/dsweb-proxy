/**
 * 提示词协议层：
 *  1) 把 DSH 的消息词汇（system / user / assistant / tool-result / reasoning / tool-call）
 *     序列化成网页端可吃的单段 prompt（网页 API 只有 `prompt` 字符串，无 tools 字段）。
 *  2) 工具调用桥：网页模型没有原生 function calling，改用「JSON 协议 + 流式解析」——
 *     指令要求模型只输出 {"tool_calls":[{"name":…,"arguments":{…}}]}，
 *     本模块在流式文本上做 hold-back 扫描，命中即转成 tool-call 块，不命中则原样透传正文。
 */
import { randomUUID } from 'node:crypto'
import { AdapterLlmError } from './auth.ts'

export interface ToolSchemaLike {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCallRequest {
  id: string
  name: string
  /** 原始 JSON 字符串（DSH ToolCallBlock.arguments 语义）。 */
  arguments: string
}

/** 单次 push/flush 的产出。 */
export interface FilterOutput {
  text: string
  calls: ToolCallRequest[]
  /**
   * 捕获到的协议块**无法解析**（raw = 原文，mode = 标记家族）。
   * ⚠️ 这个字段的意义：绝不再把这种残留当正文吐出去 —— 它既不是模型想说的话，
   * 又会被 Web GUI 的 markdown 渲染器当成垃圾（实测 2026-09：泄漏文本里的
   * `$ErrorActionPreference='…'` 被渲染成 KaTeX 行内公式 → 用户看到「一个字符一行 +
   * 弯引号」的乱码）。调用方据此决定「重试」或「给一句人话提示」。
   *
   * `reason` 区分失败形态，用于诊断（实测日志只留前 400 字符，看不到后半段的坏点）：
   *  - `unbalanced`：块没配平/没收全 —— 多半是流被服务端 60s 上限截断，不是模型写错；
   *  - `unparsable`：块是完整的，但结构不符（漏括号、引号没转义等）；
   *  - `echo`      ：载荷里裹着转写回声（`[Tool Result for …]` 等）—— 模型在**复述历史**，
   *                  不是真在调用。此类**必须丢弃**：实测抓到过一个 8152 字符、含 15 条
   *                  「调用」的载荷，全部是历史回放，执行它等于把旧命令重跑一遍；
   *  - `oversize`  ：超过捕获上限，放弃。
   */
  rejected?: { raw: string; mode: 'json' | 'xml'; reason?: 'unbalanced' | 'unparsable' | 'oversize' | 'echo' }
}

/**
 * 单个工具描述的上限。
 *
 * 2026-09-12 从 400 提到 3200。理由：DSH 实际下发 61 个工具，其中 17 个描述超过 400 字符，
 * 而**被砍掉的恰恰是最要紧的部分** —— `pwsh` 的 3010 字符里有 2610 个字符在讲
 * 「沙箱拒绝（file access denied）是策略判定、不是命令的 bug，别换个方式重试」
 * 「命名管道不可用时 stdio:'pipe' 的 spawn 会报 EPERM，同样别换方式」
 * 「只读沙箱下 .NET 静态调用 / Add-Type / COM / 反射会失败」这类**遇错该怎么办**的指引；
 * `workflow` 的 2500 字符里是 agent() / pipeline() / parallel() 的钩子签名。
 * 把它们砍掉，模型一遇错就只能瞎猜 —— 实测这两个工具正是 rejected.jsonl 里失败最多的。
 */
const MAX_DESCRIPTION_CHARS = 3_200

/**
 * 工具目录（一节）的总预算。
 *
 * 2026-09-12 从 24_000 提到 56_000。理由：实测 DSH 下发 61 个工具、不截描述时共需
 * **50,942 字符**，旧预算只装得下 35 个。更糟的是**截断是按字母序发生的**（工具按名排序），
 * 于是 `write`(w)、`web_search`、`web_fetch`、`subagent`、`todo_write`、`skill`、`read_image`、
 * 全部 `ssh_*`/`sftp_*` 被砍，而极少用的 `db_tx_rollback`、`db_list_connections` 反而留下。
 * 取 56_000 留约十分之一余量（够再添几个中等大小的工具）；再超就走下面的"列出名字"兜底。
 * 不至于撑爆上下文：DeepSeek 网页端上下文 1M token，而实际生效的 maxChars 是
 * **150 万字符**（`index.ts` 的 `maxPromptChars` 默认值；这里 12 万那个旧注释已过时 ——
 * 2026-09-13 核对时发现写的还是旧默认值，容易让人误判 prompt 体量）。
 */
const MAX_TOOLS_SECTION_CHARS = 56_000
const HOLD_BACK_CHARS = 24
const MAX_CAPTURE_CHARS = 256 * 1024

/** 工具调用协议指令（固定文本，进 prompt 前缀，保持前缀缓存友好）。 */
/**
 * head（system + 工具协议 + 工具目录）在 prompt 里最多占的比例。
 * 0.62 是 0.1.33 调的：实测 61 个工具时 head 约 6.35 万字符，而 0.45 × 12 万 = 5.4 万装不下。
 * 转写仍余约 5.6 万字符 —— 历史可以截，工具定义不可以。
 */
const HEAD_RATIO = 0.62
/** 协议段拼接时的固定开销（换行、`---` 分隔、省略标记等）。 */
const PROTOCOL_SLACK_CHARS = 96

export const TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output ONLY a single JSON object, with no other text before or after it:

{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}

Rules:
1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch is allowed).
2. Stop immediately after that JSON object. The runner executes the call(s) and returns the results to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Do NOT use XML/HTML-like markup for tool calls: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), and none of the private delimiter-prefixed variants some DeepSeek surfaces use. The JSON object above is the ONLY accepted format. Markup is not just ignored — it leaks into the visible transcript (and into the web conversation) as broken output.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry — measured case: a model emitted 15 replayed calls inside one 8152-char payload, and every one of them had to be thrown away.
9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`

/** 判定「这是一段要执行的程序」的最小长度：短于它的多半只是行内提及某个 API。 */
const MIN_TOOL_PROGRAM_CHARS = 80

/**
 * 检测「模型把工具程序写成了正文」——而不是作为工具调用发出。
 *
 * 现场（2026-09-17 11:00，`--F-Code-DSH-Code-gongji--` 会话）：第三方 preset（染神）
 * 的 `tool-bootstrap.mjs` 注入了一条 PTC 说明 ——「你在 Programmatic Tool Calling 模式，
 * 所有动作必须通过 run_code 写 TypeScript 程序完成」；同 preset 的 persona 还写着
 * `One complete deliverable per turn: numbered steps or code blocks`。
 * 于是模型把 run_code 的 code 参数**原样贴进了正文**：三轮里一次工具调用都没发出
 * （`toolCallCount` 始终为 0），agent loop 判定回合结束 → 用户看到「它停下来了」。
 * 模型自己在 reasoning 里也承认："我把 TypeScript 代码写成了正文文本，而不是作为工具调用发出"。
 *
 * 判据：正文里出现**围栏代码块**且块内含 `tools.<name>(…)` 形态的调用 —— 那是 PTC
 * 程序体的特征（正常回答不会这么写）。没有围栏时只认带 `await` 的形态，更严格，
 * 免得把「提到某个 API」错判成「写了程序」。
 *
 * ⚠️ 这**只是判据**：调用方还要确认「本轮零工具调用」，否则健康的程序化调用轮会被误伤。
 */
export function looksLikeUnexecutedToolProgram(text: string): boolean {
  const source = String(text ?? '')
  if (!source) return false
  const blocks: string[] = []
  const fence = /```[^\n]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(source)) !== null) blocks.push(match[1])
  if (blocks.length === 0) {
    return /await\s+tools\.[A-Za-z_$][\w$]*\s*\(/.test(source)
  }
  return blocks.some(
    (block) => block.length >= MIN_TOOL_PROGRAM_CHARS && /tools\.[A-Za-z_$][\w$]*\s*\(/.test(block),
  )
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

/** 渲染工具目录（含 JSON Schema）。 */
export function buildToolSection(
  tools: readonly ToolSchemaLike[] | undefined,
  maxChars: number = MAX_TOOLS_SECTION_CHARS,
): string {
  if (!tools || tools.length === 0) return ''
  const parts: string[] = ['', '## Available tools']
  // 预算取「内置上限」与「调用方给的额度」的较小值。
  // 调用方（serializePrompt）会按剩余空间算一个动态额度传进来 —— 见下面 F18 的注释。
  let budget = Math.max(0, Math.min(MAX_TOOLS_SECTION_CHARS, maxChars))
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]
    let schemaText = ''
    try {
      schemaText = JSON.stringify(tool.parameters ?? {})
    } catch {
      schemaText = '{}'
    }
    const block = [
      '',
      `### ${tool.name}`,
      truncate(String(tool.description ?? '').replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION_CHARS),
      `Parameters (JSON Schema): ${schemaText}`,
    ].join('\n')
    if (budget - block.length < 0) {
      // 预算用完。**必须把剩下的工具名说出来**：旧写法只有一句
      // "(remaining tools omitted for length)"，模型连"还有哪些工具存在"都不知道，
      // 只能盲猜名字和参数 —— 实测 61 个工具里 26 个就是这样静默消失的。
      // 同时明确要求它别猜参数，改为向用户确认。
      const rest = tools
        .slice(index)
        .map((item) => String(item?.name ?? ''))
        .filter(Boolean)
      parts.push(
        `\n(⚠️ The following ${rest.length} tools are NOT described above (omitted for length): ` +
          `${rest.join(', ')}. If you need one of them, ask the user for its exact parameters — ` +
          'do NOT guess them.)',
      )
      break
    }
    budget -= block.length
    parts.push(block)
  }
  return parts.join('\n')
}

function flattenText(blocks: readonly any[] | undefined, out: string[] = []): string[] {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'tool-result' && Array.isArray(block.content)) flattenText(block.content, out)
  }
  return out
}

/**
 * 逐张产出图片占位标记，**按图片在消息里的实际顺序**。
 *
 * 为什么要分「带上」与「略过」（0.1.77，群友实测报告 `code 10 / too many ref file`）：
 * 图片是**请求级**的（一次请求用 `ref_file_ids` 带一批），而网页端对这一批的数量有上限 ——
 * 实测最后一次成功是 40 张、第一次失败是 52 张，真值落在 (40, 52]。超长会话里我们只发
 * 最近的 N 张，更早的会被略过；此时若标记仍一律写 `[image attached]`，模型就会**以为它
 * 收到了那些图**，然后对着没送出去的图瞎猜。所以分两种标记写。
 *
 * ⚠️ **必须按顺序逐个产出，不能写成「N 个 attached 再 M 个 omitted」** ——
 * 那样标记的先后就不再对应图片的时间先后，模型会搞不清被省略的是哪几张。
 *
 * `kept` 为 undefined 时全部算「已发出」（＝ 0.1.77 之前的行为，续写轮与既有单测走这条路）；
 * 图没有 `attachmentId` 时也算「已发出」—— 那种情况判断不了，保守起见别把真发出去的标成省略。
 */
function blockImageMarks(
  blocks: readonly any[] | undefined,
  kept: ReadonlySet<string> | undefined,
): string[] {
  const marks: string[] = []
  const walk = (list: readonly any[] | undefined): void => {
    for (const block of list ?? []) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image') {
        const key = String(block.attachment?.attachmentId ?? '')
        marks.push(!kept || !key || kept.has(key) ? '[image attached]' : '[earlier image omitted]')
      } else if (block.type === 'tool-result' && Array.isArray(block.content)) walk(block.content)
    }
  }
  walk(blocks)
  return marks
}

/** 按出现顺序收集消息里的图片附件引用（含 tool-result 内嵌图片）。 */
export function collectImageRefs(messages: readonly any[] | undefined): any[] {
  const refs: any[] = []
  const walk = (blocks: readonly any[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image' && block.attachment) refs.push(block.attachment)
      else if (block.type === 'tool-result' && Array.isArray(block.content)) walk(block.content)
    }
  }
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    walk(Array.isArray(message.content) ? message.content : undefined)
  }
  return refs
}

/** mediaType → 文件名后缀。服务端按**后缀**判类型（不看 multipart 里的 content-type）。 */
const IMAGE_EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** 服务端认得的图片后缀。不在此列的一律重建名字，别把 bmp/tiff 之类原样发过去再被拒一次。 */
const KNOWN_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

/**
 * 上传时该用的文件名。
 *
 * 为什么必须归一（2026-09-15 真机 A/B，三组对照，同一份 PNG 字节只改名字）：
 *   `image.png` ✅ / `<64位hex>.png` ✅ / **纯 64 位 hex ❌ `code 9 unsupported file type`** /
 *   不给 name（走缺省 image.png）✅
 * ⇒ 服务端**按文件名后缀**判类型，content-type 说了不算。
 * 而宿主给 `tool/result` 内嵌图片的 `name` 正是**纯 sha256（没有后缀）**，
 * `user/message` 与 `agent/inbox` 给的是 `image.png` —— 于是"凡是经工具返回的图一律传不上去"：
 * 本机 09-14 的 36 次 + 09-15 的 6 次被拒，全部是这个原因（会话日志里
 * `tool/result` 的 name 无一例外是 64 位 hex，user/message 无一例外带 .png）。
 *
 * 所以这里只保留**受支持的后缀**，其余按 mediaType 重建为 `image.<ext>`
 * ——保证发出去的文件名总是声明了一个服务端支持的类型。
 */
export function imageUploadName(name: unknown, mediaType: unknown): string {
  const ext = IMAGE_EXT_BY_MEDIA_TYPE[String(mediaType ?? '').trim().toLowerCase()] ?? 'png'
  const raw = typeof name === 'string' ? name.trim() : ''
  // 只取基名：万一宿主给的是路径，别把目录带进 multipart 的文件名
  const base = raw.split(/[\\/]/).pop() ?? ''
  const matched = /\.([a-z0-9]{2,5})$/i.exec(base)
  if (matched && KNOWN_IMAGE_EXT.has(matched[1].toLowerCase())) return base
  return `image.${ext}`
}

/** 把一条 assistant 消息里的 tool-call 块渲染回协议 JSON（供历史学习格式）。 */
function renderToolCalls(blocks: readonly any[]): string | null {
  const calls = (blocks ?? []).filter((block) => block?.type === 'tool-call')
  if (calls.length === 0) return null
  const payload = {
    tool_calls: calls.map((call) => {
      let args: unknown = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        args = { _raw: String(call.arguments ?? '') }
      }
      return { name: String(call.name ?? ''), arguments: args }
    }),
  }
  return JSON.stringify(payload)
}

/** 中间截断：保留开头（任务/协议）与结尾（最近回合），并把省略标记计入预算。 */
function truncateMiddle(text: string, maxChars: number, tailRatio = 0.7): string {
  if (text.length <= maxChars) return text
  const RESERVE = 64 // 标记串预留（"...[N chars omitted]..." 远小于此）
  const budget = Math.max(0, maxChars - RESERVE)
  const tail = Math.floor(budget * tailRatio)
  const head = Math.max(0, budget - tail)
  const dropped = text.length - head - tail
  const marker = `\n\n...[${dropped} chars omitted]...\n\n`
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

export interface SerializeOptions {
  system?: string
  messages: readonly any[]
  tools?: readonly ToolSchemaLike[]
  maxChars?: number
  /**
   * 本次请求**真正会带上**的图片 key 集合（各图的 `attachmentId`）。
   *
   * 给了它就按它区分「这张图在不在本次请求里」，占位标记相应写成
   * `[image attached]`（带上了）或 `[earlier image omitted]`（被长度控制略过）。
   *
   * **不给**（undefined）＝ 一律按「带上了」处理 —— 那是 0.1.77 之前的行为。
   * 续写轮与既有单测走的就是这条路，prompt 形态必须逐字节不变。
   */
  keptImageKeys?: ReadonlySet<string>
}

/**
 * 序列化为网页端单段 prompt。
 * 结构：system → 工具协议与目录 → 对话转写（User:/Assistant:/[Tool Result]）。
 */
export interface PromptParts {
  /** 固定头：system + 协议指令 + 工具目录（可能为空串）。 */
  head: string
  /** 历史条目（**未截断**）。链式投喂按它算增量，所以不能受截断影响。 */
  entries: string[]
  /** 真正发出去的那份字符串（超预算时是截断后的）—— 与 serializePrompt 的返回值一致。 */
  full: string
}

export function serializePrompt(options: SerializeOptions): string {
  return serializePromptParts(options).full
}

/**
 * 与 serializePrompt 同源，但额外交出 `head` 与未截断的 `entries`。
 *
 * 为什么需要（2026-09-14，链式投喂）：增量 = 本轮条目减去上一轮条目，必须拿
 * **结构化**的条目数组去比前缀；而最终字符串可能被 truncateMiddle 从中间截过，
 * 用字符串切前缀会把截断位置算错（截断点之后的"新增"其实是被挖掉的中段）。
 */
export function serializePromptParts(options: SerializeOptions): PromptParts {
  const maxChars = options.maxChars ?? 120_000
  // N07：小数/NaN/极小值直接拒绝，别让它们一路漂到后面的算术里（`new Array(小数)` 这类坑在旁边就有）
  if (!Number.isSafeInteger(maxChars) || maxChars < 128) {
    throw new RangeError('maxChars 必须为至少 128 的整数')
  }
  const system = String(options.system ?? '').trim()
  // ⚠️ F18（2026-09-12 审计）：**按剩余空间给工具目录算预算**，而不是"先渲染满、事后截 head"。
  // 旧做法是先把工具目录渲染到 5.6 万字符，再发现 head 超过 `maxChars * 比例`，
  // 于是 `truncateMiddle` 从**中间**挖掉一块 —— 留下的是**残缺的 JSON Schema**：
  // 模型会照着半截定义猜参数，比"干脆不列这个工具"更糟；而且 maxChars 越小时越容易触发。
  // 现在反过来：先把 system 与协议指令的固定开销扣掉，剩下的才是工具目录能用的额度。
  // 装不下就走 buildToolSection 自己的兜底（列出被省略的工具名），head 永远完整。
  const toolBudget = Math.max(
    0,
    Math.floor(maxChars * HEAD_RATIO) - system.length - TOOL_PROTOCOL_INSTRUCTIONS.length - PROTOCOL_SLACK_CHARS,
  )
  const toolSection = buildToolSection(options.tools, toolBudget)
  const protocol = toolSection ? `\n\n${TOOL_PROTOCOL_INSTRUCTIONS}${toolSection}` : ''

  const lines: string[] = []
  for (const message of options.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const blocks: any[] = Array.isArray(message.content) ? message.content : []
    if (message.role === 'system') {
      const text = flattenText(blocks).join('')
      if (text.trim()) lines.push(`[System]\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(blocks).join('')
      const renderedCalls = renderToolCalls(blocks)
      if (renderedCalls) lines.push(`Assistant: ${renderedCalls}`)
      else if (text.trim()) lines.push(`Assistant: ${text}`)
      continue
    }
    // user 角色：可能是纯文本，也可能携带 tool-result 块
    const toolResults = blocks.filter((block) => block?.type === 'tool-result')
    const text = flattenText(blocks.filter((block) => block?.type !== 'tool-result')).join('')
    const imageMarks = blockImageMarks(blocks, options.keptImageKeys)
    const images = imageMarks.length
    if (text.trim() || (toolResults.length === 0 && images === 0) || images > 0) {
      // 图片本体由调用方上传后经 ref_file_ids 附在请求上；这里只放可定位的占位标记，
      // 让模型知道「图几」对应哪条消息（顺序与 uploadedImages 收集顺序一致）。
      //
      // 0.1.77：被长度控制略过的那些**不能也写 `[image attached]`** —— 逐张按实发情况写，
      // 模型才知道哪些是真有的（见 blockImageMarks 的说明）。
      const imageNote = imageMarks.length > 0 ? `\n${imageMarks.join(' ')}` : ''
      lines.push(`User: ${text}${imageNote}`)
    }
    for (const result of toolResults) {
      const body = flattenText(result.content).join('') || '(no output)'
      const errorMark = result.isError ? ' [ERROR]' : ''
      lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? '')}]\n${body}`)
    }
  }

  const transcript = lines.join('\n\n')
  const head = system ? `${system}${protocol}` : protocol.trim()
  const merged = transcript ? `${head}\n\n---\n\n${transcript}` : head

  if (merged.length <= maxChars) return { head, entries: lines, full: merged }

  // ⚠️ N07（2026-09-13 第二轮审计）：**固定头（system + 协议 + 工具目录）必须完整**，
  // 不能再按 `maxChars * HEAD_RATIO` 去截它。
  // 旧写法是 `headBudget = min(head.length, floor(maxChars * 0.62))`：
  // 只要 system 长到超过预算的 62%，就会从**中间**被挖掉一块 ——
  // 于是"预算明明够放完整 system"的请求，也会静默丢掉系统指令（模型照着残缺策略干活）。
  // 现在：固定头独占它的长度，剩余预算全给历史；**固定头自己放不下就明确报错**。
  // 代价：以前"静默丢指令还能生成"的请求现在会失败 —— 这是有意的，丢失系统指令比失败更糟。
  const separator = transcript ? '\n\n---\n\n' : ''
  const budget = maxChars - head.length - separator.length
  if (budget < 128) {
    throw new AdapterLlmError(
      '系统/工具定义超出 prompt 预算，请减少固定输入或扩大上限',
      'CONTEXT_WINDOW_EXCEEDED',
    )
  }
  return { head, entries: lines, full: head + separator + truncateMiddle(transcript, budget, 0.7) }

}

// ── 流式工具调用过滤器 ────────────────────────────────────

/** 完整 JSON 调用标记：{"tool_calls": 或 {"tool_call": （允许空白）。 */
const MARKER_RE = /\{\s*"tool_calls?"\s*:/
/**
 * XML 风格调用标记（实测：思考模式下模型偶尔改用这套标记，形如
 * `<tool_calls><invoke name="read"><parameter name="file_path">…</parameter></invoke></tool_calls>`；
 * 亦兼容 DeepSeek 自家的 DSML 前缀与 `dsml-` 连字符变体）。
 *
 * ⚠️ 2026-09-10 实测泄漏样本（真正的乱码来源）：模型把 DSML 前缀写成**重复的全角竖线**，
 * 且包裹标签名退化成 `calls`：
 *   `<` + `｜｜` + `DSML` + `｜｜` + ` ` + `calls>`
 * 旧写法只容忍单个竖线（`[|｜]`），于是 `<` 后吃掉一个 `｜` 就要求紧跟 `DSML`，
 * 却撞上第二个 `｜` → 整个标记认不出来 → 不进捕获态 → 原样进正文 → GUI 渲染成乱码。
 * 现在竖线按 `+` 容忍（含全角/半角混用），并把 `calls` 也列入包裹标签名。
 */
const DSML_PREFIX = '(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?'
const WRAPPER_NAMES = 'tool_calls|tool_call|function_calls|calls'
const XML_STARTER_RE = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES}|invoke)\\b`, 'i')
/** 代码围栏收尾（模型常把调用块放进 ``` 里）。 */
const FENCE_TAIL_RE = /\n?[ \t]*```[a-zA-Z0-9]*[ \t]*\n?$/
const FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/

/**
 * 开/收标签前缀（宽容写法）。严格解析与宽容解析**必须共用同一套**，否则会出现
 * 「findXmlToolCallEnd 认得出收尾、parseXmlToolCalls 认不出 invoke」→ 整块被降级成正文泄漏。
 * 覆盖：`< invoke`（标签名带空白）、单/重复竖线的 DSML 前缀（含全角）、`<dsml-invoke>`。
 */
const TAG_OPEN_PREFIX = `<\\s*${DSML_PREFIX}(?:dsml-)?`
const TAG_CLOSE_PREFIX = `<\\/\\s*${DSML_PREFIX}(?:dsml-)?`
const XML_CLOSE_NAMES = `parameter|invoke|${WRAPPER_NAMES}`

/**
 * 归一化 DSML 噪声 → 标准标签。
 * 竖线支持**重复与全角**（实测样本是双全角竖线），并连带吃掉其后的空白，
 * 让标签名紧跟在 `<` 之后（`<` + 前缀 + ` ` + `invoke` → `<invoke`）。
 */
function normalizeDsml(text: string): string {
  return text
    .replace(new RegExp(`<(/?)${DSML_PREFIX}`, 'gi'), '<$1')
    .replace(/<\s*dsml-/gi, '<')
    .replace(/<\/\s*dsml-/gi, '</')
}

/**
 * JSON 调用标记前缀（用于跨包 hold-back 判断）。
 * ⚠️ 2026-09 事故：真实分块会把标记切成 `{"tool` + `_calls":[{"name":…` 两半。
 * 旧实现比较时多拼了一个引号（`{'{"' + body}`，而 body 已含前引号 → `{""tool`），
 * 于是「末尾是潜在前缀」永远判 false → 半截标记被当正文吐出去、后半个再也拼不回完整标记
 * → 整个 JSON 泄漏成正文。修复见 partialMarkerSuffixLength。
 */
const JSON_MARKER_STARTERS = ['{"tool_calls"', '{"tool_call"']

/** XML 标记前缀（用于跨包 hold-back 判断）。`calls` 是实测出现的退化包裹名。 */
const XML_MARKER_STARTERS = ['<tool_calls', '<tool_call', '<function_calls', '<calls', '<invoke', '<dsml-tool_calls', '<dsml-invoke']

/**
 * 判断 text 末尾是否是（可能的）标记前缀 —— 决定是否 hold back。
 * @returns 需要保留在缓冲区里的尾部字符数（0 = 无需保留）
 */
function partialMarkerSuffixLength(text: string): number {
  const LIMIT = 32
  const from = Math.max(0, text.length - LIMIT)
  const raw = text.slice(from)
  // 候选起点：最后一个 `{` 或 `<`（在**原始**切片上定位，保证 held 长度与原文对齐）
  const braceAt = raw.lastIndexOf('{')
  const angleAt = raw.lastIndexOf('<')
  const startAt = Math.max(braceAt, angleAt)
  if (startAt === -1) return 0
  const held = raw.length - startAt
  const normalized = normalizeDsml(raw.slice(startAt))

  if (normalized.startsWith('{')) {
    if (MARKER_RE.test(normalized)) return 0 // 已是完整标记，交给捕获逻辑
    const body = normalized.replace(/^\{\s*/, '').replace(/\s+/g, '')
    // body 已含前引号（如 `"tool`）→ 与 starter 比较时应拼 `{` + body
    const ok = JSON_MARKER_STARTERS.some((starter) => starter.startsWith(`{${body}`))
    return ok ? held : 0
  }
  if (normalized.startsWith('<')) {
    if (XML_STARTER_RE.test(normalized)) return 0 // 已是完整标记
    const lower = normalized.toLowerCase().replace(/\s+/g, '')
    if (XML_MARKER_STARTERS.some((starter) => starter.startsWith(lower))) return held
    // ⚠️ DSML 前缀可能**只到了一半**：`<|DSML` 还差最后一个竖线，
    // 于是 normalizeDsml（要求「竖线 DSML 竖线」）认不出来 → 上面这条 hold 判定失效。
    // 2026-09-12 实测泄漏路径正是这里：pending 停在半截前缀时 hold 判定给了 0，
    // 半截标记被当正文吐出，随后几个字符补成 `<|DSML|calls>` 就成了正文里的乱码。
    // 兜底：把候选里的竖线与 `dsml` 一并擦掉再看是不是某个 starter 的前缀。
    const loose = lower.replace(/[|｜]|dsml/g, '')
    if (/^<\/?[a-z_]*$/.test(loose) && XML_MARKER_STARTERS.some((starter) => starter.startsWith(loose))) {
      return held
    }
    return 0
  }
  return 0
}

/** 从 index 0 起抽取一个配平的 JSON 对象；不完整返回 null。 */
export function extractBalancedJson(text: string): { json: string; end: number } | null {
  if (text[0] !== '{') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { json: text.slice(0, i + 1), end: i + 1 }
    }
  }
  return null
}

/** 读取一个 XML 属性值（支持双引号/单引号/裸值）。 */
function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, 'i')
  const match = re.exec(attrs)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3]
}

/**
 * 宽容 JSON 解析。实测场景：模型把 Windows 路径写成 `"D:\apps\DSH"`（单个反斜杠，
 * 非法转义），JSON.parse 直接抛错 → 工具调用解析失败、整段标记被当正文吐给用户。
 * 先试原样；失败则修补：非法转义补成字面反斜杠、字符串内裸换行转义、去尾逗号。
 */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {}
  for (const candidate of jsonRepairCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== undefined) return parsed
    } catch {}
  }
  return undefined
}

/**
 * 依次尝试的修复候选（只在原样解析失败时使用）。顺序有讲究：
 *
 * 先跑「路径尾反斜杠」启发式（`"…\app.asar\"` 里的 `\"` 是转义引号 → 字符串不终止，
 * 必须在切分字符串**之前**修，否则整个字符串范围都会错），再跑字符串级修复。
 *
 * 字符串级修复的智能规则：若某字符串里出现**非法转义**（如 `\A`），说明模型是「原样写出」
 * 未转义的反斜杠 —— 此时该字符串内所有反斜杠都按字面处理，否则 `\resources` 里的 `\r`
 * 会被 JSON 当成回车，路径被悄悄改坏（实测用户样本 #2）。
 * 若字符串里没有非法转义，则只做保守修补（保留 `\\`、`\"` 等合法转义）。
 */
/**
 * 修复「**字符串值里出现未转义的双引号**」——实测最高频的坏法，也是「自动停止」的元凶。
 *
 * 实测（2026-09-10 23:27:13，deepseek-reasoner）：命令天然写作
 *   `Get-ChildItem "$env:USERPROFILE\.dsh" | Select-Object Name`
 * 模型把这串里的引号**原样**塞进 JSON 字符串 → `Expected ',' or '}' after property value`
 * → 整条调用被丢弃 → 那一轮没有工具调用 → agent loop 认为回合正常结束
 * → 用户看到的症状就是「说半句就停了」。
 *
 * 判据（对 JSON 语法是稳的）：在字符串内部遇到双引号时，向后跳过空白看一个字符 ——
 * 只有它还是 `,` `}` `]`（或文本结束）时才说明字符串真的结束；否则该引号是内容里的字面引号。
 *
 * ⚠️ 冒号必须**按位置**区别对待：`"` 后面跟 `:` 只在「键的位置」才是结构符。
 * 若把值里的 `"` + `:` 也当成结束，那么命令内嵌 JSON 时会误判，例如
 *   `node -e "const o={"a":1}"`
 * 里的 `"a"` 会被当成字符串收尾 → 后面全部错位 → 整条调用照样被丢弃（我第一版就踩了这个洞）。
 * 因此这里跟踪「进入字符串时是否处于键位置」（上一结构符是 `{` / `,` / `[`）。
 */
export function escapeInnerQuotes(text: string): string {
  let out = ''
  let inString = false
  let keyPosition = false
  let lastStructural = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inString) {
      if (ch === '"') {
        inString = true
        keyPosition = lastStructural === '{' || lastStructural === ',' || lastStructural === '['
        out += ch
        continue
      }
      if (!' \t\n\r'.includes(ch)) lastStructural = ch
      out += ch
      continue
    }
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '')
      i += 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && ' \t\n\r'.includes(text[j])) j++
      const next = text[j]
      // 冒号只有在键位置才是结构符；值里的引号 + 冒号属于内容（内嵌 JSON 的常态）
      const isStructural =
        next === ',' || next === '}' || next === ']' || next === undefined || (next === ':' && keyPosition)
      if (isStructural) {
        inString = false
        lastStructural = next === undefined ? '' : next
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }
    out += ch
  }
  return out
}

/**
 * ⚠️ 刻意**不提供**「更激进的猜测」候选（例如把 `"` 后跟 `}` 也一律当内容）。
 * 试过，结果是灾难：外层键的收尾引号也会被转义 → 整个载荷被搅坏；
 * 而且即使侥幸解析成功，也可能交出一条**被改坏的命令**并真的执行它。
 * 嵌套引号（`node -e "console.log({"k":"v"})"`）在原理上无法靠单字符前瞻消歧 ——
 * 这种极端用例的正确处置是**拒绝 + 重试**（重试后模型通常会改用更简单的写法），
 * 而不是猜。宁可拒绝，也绝不交出坏命令。
 */
export function* jsonRepairCandidates(text: string): Generator<string> {
  const pathTail = (value: string): string => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, '$1\\\\"')
  // 依次尝试：原样 → 补未转义引号 → 结构性补括号；每种再各跑一遍字符串级修复。
  // 所有候选都由 JSON.parse 验证，取先成功的那个。
  for (const base of [text, ...structuralRepairCandidates(text)]) {
    for (const variant of [base, escapeInnerQuotes(base)]) {
      yield repairJsonText(pathTail(variant), { mode: 'smart' })
      yield repairJsonText(variant, { mode: 'smart' })
      yield repairJsonText(pathTail(variant), { mode: 'conservative' })
      yield repairJsonText(variant, { mode: 'conservative' })
    }
  }
}

/**
 * 结构性修复候选：模型写的 tool_calls JSON 常有**括号结构错误**（漏写闭合、数组/对象闭合顺序错乱）。
 *
 * 已覆盖的实测形态：
 *  - 每个调用对象少写一个 `}`（2026-09 事故 #4：批量 3 个调用各少一个）
 *  - arguments 写成数组、且 `]`/`}` 顺序错乱（2026-09-11 事故 #5：
 *    `{"tool_calls":[{"name":"pwsh","arguments":[{…}}]}`  ← args 数组没闭合就写了 `}`）
 *  - 外层对象少写收尾 `}`
 *
 * 做法（rebuildToolCallJson）：栈引导重排 —— 遇到不匹配的闭合符时，**插入缺失的容器闭合**
 * 使其匹配。只插入括号，绝不改写字符串内容。配合 parseToolCallJson 的
 * 「arguments 数组 → 取唯一元素」解包，这类调用可以完整恢复并执行。
 */
export function* structuralRepairCandidates(text: string): Generator<string> {
  const marker = /^\s*\{\s*"tool_calls?"\s*:\s*\[/.exec(text)
  if (!marker) return
  const rebuilt = rebuildToolCallJson(text)
  if (rebuilt && rebuilt !== text) yield rebuilt
}

/**
 * 栈引导的 tool_calls JSON 重排（只在严格解析失败后使用，**只插入括号、绝不改写字符串内容**）。
 *
 * 规则：
 *  1) 正常的开/闭符合配 → 原样输出并弹栈；
 *  2) 闭合符与栈顶不匹配 → 在其前**插入**能使它匹配的闭合序列（有上限保护），再正常闭合；
 *  3) `,` 出现在 tool_calls 数组的元素层级、而栈顶是未闭合的调用对象 → 先补 `}`
 *     （实测形态：批量调用每个元素都少写一个 `}`）；
 *  4) 收尾按栈补齐剩余闭合。
 *
 * ⚠️ 安全闸门：扫描结束时若**仍在字符串内**（流被服务端 60s 上限截断的典型特征）→ 返回 null。
 * 此时补括号会得到一条**被截断的命令**并真的执行它 —— 宁可拒绝（→ 重试），也不执行半条命令。
 */
export function rebuildToolCallJson(text: string): string | null {
  if (!/^\s*\{\s*"tool_calls?"\s*:\s*\[/.test(text)) return null
  let out = ''
  const stack: string[] = []
  let inString = false
  let escape = false
  let insertions = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      out += ch
      continue
    }
    if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '['
      while (stack.length > 0 && stack[stack.length - 1] !== want) {
        if (insertions >= 8) return null
        out += stack[stack.length - 1] === '{' ? '}' : ']'
        stack.pop()
        insertions += 1
      }
      if (stack.length === 0) return null
      stack.pop()
      out += ch
      continue
    }
    if (ch === ',') {
      // `,` 在 tool_calls 数组的**元素层级**（数组之上只有一层调用对象）而栈顶未闭合
      // → 模型忘了写这个元素的 `}`，补上（实测：批量调用每个都少一个 `}`）。
      // 数组之上超过一层 = 逗号在元素内部的合法位置（args 对象/数组里），不动。
      // ⚠️ 还必须带前瞻：调用对象内部的键分隔逗号（"name" 与 "arguments" 之间）在这一刻的
      // 深度同样是 1，但后面跟的是 `"arguments"` 而不是 `{"name"` —— 不带前瞻会把每个调用对象拦腰补坏。
      const bracketIndex = stack.indexOf('[')
      if (
        bracketIndex === 1 &&
        stack.length - bracketIndex - 1 === 1 &&
        stack[stack.length - 1] === '{' &&
        /^\s*\{\s*"name"\s*:/.test(text.slice(i + 1))
      ) {
        out += '}'
        stack.pop()
        insertions += 1
      }
      out += ch
      continue
    }
    out += ch
  }
  if (inString) return null // 安全闸门（见上）
  if (insertions > 8) return null
  while (stack.length > 0) {
    out += stack[stack.length - 1] === '{' ? '}' : ']'
    stack.pop()
  }
  return out
}

/**
 * 修复常见 JSON 语法问题。
 * @param options.mode - `smart`（默认）：字符串内出现非法转义时，把该字符串所有反斜杠按字面
 *   处理（模型原样写路径的常态，避免 `\r`/`\n`/`\t` 被误当转义）；
 *   `conservative`：只补非法转义，其余原样保留。
 */
export function repairJsonText(text: string, options: { mode?: 'smart' | 'conservative' } = {}): string {
  const mode = options.mode ?? 'smart'
  let out = ''
  let inString = false
  let buf = ''
  const flushString = (): void => {
    const raw = buf
    // smart：整串都是「原样写出」的反斜杠 → 全部按字面；否则只补非法转义
    const body =
      mode === 'smart' && hasInvalidEscape(raw)
        ? literalizeBackslashes(raw) // 整串按字面处理（模型原样写路径的常态）
        : escapeInvalidEscapes(raw)
    out += `"${body}"`
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inString) {
      if (ch === '"') {
        inString = true
        buf = ''
        continue
      }
      out += ch
      continue
    }
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) {
        buf += '\\\\'
        continue
      }
      buf += ch + next
      i += 1
      continue
    }
    if (ch === '"') {
      flushString()
      inString = false
      continue
    }
    if (ch === '\n') {
      buf += '\\n'
      continue
    }
    if (ch === '\r') {
      buf += '\\r'
      continue
    }
    if (ch === '\t') {
      buf += '\\t'
      continue
    }
    buf += ch
  }
  if (inString) flushString()
  // 去掉对象/数组结尾的多余逗号
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** 字符串里是否存在「非法转义」（判断模型是否原样写出了未转义的反斜杠）。 */
function hasInvalidEscape(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') continue
    const next = body[i + 1]
    if (next === undefined) return true
    if (!'"\\/bfnrtu'.includes(next)) return true
    i += 1
  }
  return false
}

/**
 * 把「模型原样写出的字符串」按字面语义重新转义。
 * 逐字符处理以避免正则的重复加倍：`\\` 保留为一个字面反斜杠、`\"` 保留为转义引号，
 * 其余单个反斜杠一律补成 `\\`（关键：让 `\resources` 里的 `\r` 不再变成回车）。
 */
function literalizeBackslashes(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === '\\') {
      out += '\\\\'
      i += 1
      continue
    }
    if (next === '"') {
      out += '\\"'
      i += 1
      continue
    }
    out += '\\\\'
  }
  return out
}

/** 只把「非法转义」补成字面反斜杠，合法转义原样保留。 */
function escapeInvalidEscapes(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      out += '\\\\'
      continue
    }
    if ('"\\/bfnrtu'.includes(next)) {
      out += ch + next
      i += 1
      continue
    }
    out += '\\\\'
  }
  return out
}

/** 去掉 CDATA 包装并按 JSON 解析值（解析不出就当字符串）。 */
function parseParameterValue(raw: string): unknown {
  let text = raw.trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text)
  if (cdata) text = cdata[1]
  if (text === '') return ''
  const parsed = parseJsonLenient(text)
  return parsed === undefined ? text : parsed
}

/**
 * 解析 XML/DSML 风格的工具调用块（整块文本，可能含多个 invoke）。
 * 支持：`<tool_calls>`/`<function_calls>` 包裹、裸 `<invoke>`、`|DSML|` 前缀、
 * CDATA 值、属性任意顺序、围栏包裹。
 */
export function parseXmlToolCalls(block: string): ToolCallRequest[] | null {
  const text = normalizeDsml(block).replace(FENCE_HEAD_RE, '').replace(/```\s*$/, '')
  const invokeRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}invoke\\s*>`, 'gi')
  const calls: ToolCallRequest[] = []
  let invoke: RegExpExecArray | null
  while ((invoke = invokeRe.exec(text)) !== null) {
    const name = readAttr(invoke[1], 'name')
    if (!name) continue
    const body = invoke[2]
    const args: Record<string, unknown> = {}
    let sawParam = false
    const paramRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}parameter\\s*>`, 'gi')
    let param: RegExpExecArray | null
    while ((param = paramRe.exec(body)) !== null) {
      const key = readAttr(param[1], 'name')
      if (!key) continue
      sawParam = true
      args[key] = parseParameterValue(param[2])
    }
    if (!sawParam) {
      // 没有 parameter 子元素：尝试把内文当 JSON 参数，否则按 _raw 保留
      const inner = body.trim()
      if (inner) {
        try {
          const parsed = JSON.parse(inner)
          if (parsed && typeof parsed === 'object') Object.assign(args, parsed as Record<string, unknown>)
          else args._raw = parsed
        } catch {
          args._raw = inner
        }
      }
    }
    calls.push({
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name,
      arguments: JSON.stringify(args),
    })
  }
  if (calls.length > 0) return calls
  return salvageXmlToolCalls(text)
}

/**
 * 宽容抢救：模型写出的 XML 调用块**收尾不全**时的最后一道网。
 *
 * 实测泄漏样本（2026-09，正是「一个字符一行」乱码的来源）：
 *   `<tool_calls><invoke name="pwsh"><parameter name="command">…</parameter>`
 * —— 参数值写完了，但**缺内层 `</invoke>`**（流被服务端上限截断时常见）。此时严格解析
 * 认不出 invoke（它的正则要求 `</invoke>` 收尾），于是整块被当正文吐给用户；
 * 而 Web GUI 把命令行里的 `$…$` 当 KaTeX 渲染 → 用户看到「一个字符一行 + 弯引号」的乱码。
 * （注：只缺最外层 `</tool_calls>` 的情形严格解析本来就能兜住，不是泄漏源。）
 *
 * 做法：不依赖任何闭合标签，只按「`<invoke name=…>` 开标签 → 下一个开标签或块尾」切段取值。
 * ⚠️ 只在**严格解析完全失败**时兜底，因此不会抢占正常路径。
 * 宁可能截断也不要泄漏 —— 截断的调用会在下一轮被模型自己纠正。
 */
function salvageXmlToolCalls(text: string): ToolCallRequest[] | null {
  const invokeStartRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>`, 'gi')
  const starts: { index: number; attrs: string }[] = []
  let match: RegExpExecArray | null
  while ((match = invokeStartRe.exec(text)) !== null) starts.push({ index: match.index, attrs: match[1] })
  if (starts.length === 0) return null

  const calls: ToolCallRequest[] = []
  for (let i = 0; i < starts.length; i++) {
    const name = readAttr(starts[i].attrs, 'name')
    if (!name) continue
    const bodyStart = starts[i].index + starts[i].attrs.length
    // 段落 = 到下一个 invoke 开标签为止；不能按闭合标签切，因为它们可能整段缺失。
    const nextStart = starts[i + 1]?.index ?? text.length
    const body = text.slice(bodyStart, nextStart)
    calls.push({
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name,
      arguments: JSON.stringify(salvageXmlParameters(body)),
    })
  }
  return calls.length > 0 ? calls : null
}

/** 从残缺的 invoke 内文里取出参数：按开标签切段，值取到下一个开标签或段尾。 */
function salvageXmlParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const paramStartRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>`, 'gi')
  const found: { start: number; end: number; key: string }[] = []
  let match: RegExpExecArray | null
  while ((match = paramStartRe.exec(body)) !== null) {
    const key = readAttr(match[1], 'name')
    if (key) found.push({ start: match.index, end: paramStartRe.lastIndex, key })
  }
  for (let i = 0; i < found.length; i++) {
    // 值 = 本参数开标签之后 → 下一个参数开标签之前（或段尾）
    // 按**开标签位置**切段而不是按 `</parameter>`：收尾标签可能整段缺失。
    const valueEnd = found[i + 1] ? found[i + 1].start : body.length
    // 值尾部残留的 `</parameter>` / `</invoke>` / `</tool_calls>` 一律剥掉
    args[found[i].key] = parseParameterValue(stripXmlClosers(body.slice(found[i].end, valueEnd)))
  }
  if (found.length === 0) {
    const inner = stripXmlClosers(body).trim()
    if (inner) {
      const parsed = parseJsonLenient(inner)
      if (parsed && typeof parsed === 'object') Object.assign(args, parsed as Record<string, unknown>)
      else args._raw = inner
    }
  }
  return args
}

/** 剥掉值尾部残留的收尾标签与空白。 */
function stripXmlClosers(value: string): string {
  const re = new RegExp(`(?:\\s*${TAG_CLOSE_PREFIX}(?:${XML_CLOSE_NAMES})\\s*>)+\\s*$`, 'i')
  return value.replace(re, '')
}

/**
 * 判断捕获到的协议块是否**确实是一次工具调用尝试**（而不是正文里恰好提到了 `<invoke>` 这类词）。
 * 只用于「解析失败时该丢弃还是该透出」的裁决：
 *  - 像调用 → 丢弃 + 告警（绝不泄漏成乱码，交给上层重试）
 *  - 不像调用 → 当普通正文透出（绝不吞掉模型正文）
 */
function looksLikeToolCallBlock(mode: 'json' | 'xml', raw: string): boolean {
  if (mode === 'json') return MARKER_RE.test(raw)
  const text = normalizeDsml(raw)
  // 带 name 属性的 invoke/parameter 开标签 = 真的在尝试调用。
  // 注意：系统提示词讲协议时只写 `<invoke>` / `<parameter>`（无 name=），因此不会被误判。
  return (
    new RegExp(`${TAG_OPEN_PREFIX}invoke\\b[^>]*\\bname\\s*=`, 'i').test(text) ||
    new RegExp(`${TAG_OPEN_PREFIX}parameter\\b[^>]*\\bname\\s*=`, 'i').test(text)
  )
}

/**
 * 分类失败形态，用于诊断 —— 日志只保留前 400 字符，看不到后半段的坏点，
 * 所以必须把「没收全」与「收全了但结构不对」分开，否则永远在猜。
 *
 *  - `unbalanced`：块没配平/没收全 —— 多半是流被服务端 60s 上限截断，不是模型写错；
 *  - `unparsable`：块是完整的，但结构不符（漏括号、引号没转义、形状不对）；
 *  - `echo`      ：载荷里裹着转写回声（模型在回放历史，不是在调用）。
 */
function classifyFailure(mode: 'json' | 'xml', raw: string): 'unbalanced' | 'unparsable' | 'echo' {
  // 最先判回声：实测抓到的 8152 字符载荷里有 15 条「调用」，命令串内裹着
  // `[Tool Result for call_…]` / `[Truncated]` —— 那是历史回放，执行它等于重跑旧命令。
  if (/\[\s*Tool Result\b/i.test(raw)) return 'echo'
  if (mode === 'json') return extractBalancedJson(raw.replace(FENCE_HEAD_RE, '')) ? 'unparsable' : 'unbalanced'
  return findXmlToolCallEnd(raw) === -1 ? 'unbalanced' : 'unparsable'
}

/** 把解析出的 JSON 转成工具调用请求；非协议形状返回 null。 */
export function parseToolCallJson(json: string): ToolCallRequest[] | null {
  const parsed: any = parseJsonLenient(json)
  if (!parsed || typeof parsed !== 'object') return null
  const raw = Array.isArray(parsed.tool_calls)
    ? parsed.tool_calls
    : parsed.tool_call && typeof parsed.tool_call === 'object'
      ? [parsed.tool_call]
      : null
  if (!raw) return null
  const calls: ToolCallRequest[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.tool === 'string' ? entry.tool : ''
    if (!name) continue
    let args = entry.arguments ?? entry.parameters ?? entry.args ?? {}
    // 模型偶尔把 arguments 写成**数组**（实测 2026-09-11：arguments:[{…}]，规范是对象）。
    // 只有一个对象元素时取该元素 —— 否则参数会被序列化成 "[{…}]"，工具拿到的是垃圾。
    if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      args = args[0]
    }
    if (typeof args === 'string') {
      // 已经是字符串：能解析就原样透出（DSH 的 arguments 语义是原始 JSON 串），否则包装
      const reparsed = parseJsonLenient(args)
      if (reparsed === undefined) args = JSON.stringify({ _raw: args })
    } else {
      try {
        args = JSON.stringify(args ?? {})
      } catch {
        args = '{}'
      }
    }
    calls.push({ id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`, name, arguments: String(args) })
  }
  return calls.length > 0 ? calls : null
}

/**
 * 流尾兜底的 JSON 抢救（比 parseToolCallJson 多退一步）。
 *
 * 捕获缓冲里可能带着捕获后残留的多余字符（围栏、正文），此时整段 `JSON.parse` 必然失败，
 * 但**配平的前缀本身是好的调用** —— 取前缀再解析，别把能救的调用整批丢掉。
 * 注意：不配平的截断仍由 structuralRepairCandidates 的安全闸门拒绝（宁可不执行半条命令）。
 */
function parseSalvagedToolCallJson(buffer: string): ToolCallRequest[] | null {
  const text = buffer.replace(FENCE_HEAD_RE, '')
  const direct = parseToolCallJson(text)
  if (direct) return direct
  const balanced = extractBalancedJson(text)
  if (balanced && balanced.end < text.length) return parseToolCallJson(balanced.json)
  return null
}

/**
 * 在捕获缓冲里找 XML 调用块的结束位置（含结束标签）。
 * - 包裹式（`<tool_calls>` / `<function_calls>`）：找对应闭合标签
 * - 裸 `<invoke>`：找到 `</invoke>` 后继续吞并紧随其后的 invoke 块（同一批调用）
 * 返回 -1 表示尚未收全（继续等流）。
 */
export function findXmlToolCallEnd(buffer: string): number {
  const text = buffer
  const wrapper = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES})\\b`, 'i').exec(text)
  const startsWithWrapper = wrapper !== null && wrapper.index === 0
  const isInvokeStart = (value: string): boolean =>
    new RegExp(`^\\s*<\\s*${DSML_PREFIX}(?:dsml-)?invoke\\b`, 'i').test(value)

  if (startsWithWrapper) {
    const tag = wrapper![1].toLowerCase()
    const closeRe = new RegExp(`<\\/\\s*${DSML_PREFIX}(?:dsml-)?${tag}\\s*>`, 'i')
    const match = closeRe.exec(text)
    return match ? match.index + match[0].length : -1
  }
  if (!isInvokeStart(text)) {
    // 可能是 `{"tool_calls":…` 之外的 XML 前缀（如仅 `<invoke` 尚未收全）
    return -1
  }
  let cursor = 0
  for (;;) {
    const slice = text.slice(cursor)
    if (!isInvokeStart(slice)) return cursor > 0 ? cursor : -1
    const closeRe = /<\/\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?invoke\s*>/i
    const match = closeRe.exec(slice)
    if (!match) return -1
    cursor += match.index + match[0].length
    const rest = text.slice(cursor)
    // 后面的下一个非空白若是新的 invoke，则继续吞并
    if (isInvokeStart(rest)) continue
    // ⚠️ 2026-09-12 实测泄漏：模型常把**包裹开始标签写丢、只留下闭合标签**，
    // 于是正文里冒出 `</|DSML|calls>`（甚至退化成 `</ calls>`）。
    // 孤立的闭合标签属于这一批调用，不该上屏 —— 收全了就一起吞掉。
    // 复现：连续裸 `<|DSML|invoke …>` 之后跟一个 `</|DSML|calls>`，旧代码会把它当正文吐出。
    const strayClose = new RegExp(
      `^\\s*<\\/\\s*${DSML_PREFIX}(?:dsml-)?(?:${WRAPPER_NAMES})\\s*>`,
      'i',
    )
    const stray = strayClose.exec(rest)
    if (stray) return cursor + stray[0].length
    // 看起来"还在收"的残片（`<` / `</` / `</|DSM` / `</ calls` …）→ 继续等，
    // 别急着当正文吐。真收不全时 flush() 会走 parseXmlToolCalls，整段不外泄。
    const tail = rest.trim()
    if (tail.startsWith('<') && /^<\/?\s*[|｜]?\s*[A-Za-z]{0,14}$/.test(tail)) return -1
    return cursor
  }
}

/**
 * 剥掉「孤立的工具调用标记残片」。
 *
 * ⚠️ 2026-09-12 实测泄漏（用户截图里那句 `voke> </ calls>`）：模型把**包裹开始标签写丢**，
 * 只留下闭合标签，或者只留下标签的后半截。这些残片不属于回答，但会绕过捕获逻辑
 * （识别器只认 `<…invoke` / `<…calls>` 这类**开始**形态）落进正文缓冲，最后被当正文吐出去。
 *
 * 触发路径是 `flush()`：残片通常很短（`</|DSML|calls>` 只有 16 字符），
 * 小于 HOLD_BACK_CHARS 就会被一直 hold 住，流结束时无条件吐出。
 *
 * 三道规则，从明确到宽松：
 *   1. 带 DSML 前缀的孤立闭合标签 —— `</|DSML|calls>` / `</ | DSML | invoke>`
 *      （DSML 是 DeepSeek 私有的标记名，正文里不可能正常出现，剥掉零风险）
 *   2. 前缀被吃光的退化形态 —— `</ calls>` / `</invoke>`
 *   3. 只剩后半截的 —— 独占一行的 `voke>`（`invoke>` 掉了头）
 * 正文里正常讨论 XML 时通常写在代码围栏或行内代码里，形态与这三条不同。
 */
export function stripStrayToolMarkup(text: string): string {
  if (!text) return text
  if (!/voke\s*>|calls?\s*>|tool_calls?\s*>|function_calls?\s*>|DSML/i.test(text)) return text
  return text
    // 0) DSML 前缀的**裸包裹标签**（开或闭都算）。实测（2026-09-12 用户截图）：
    //    模型吐过一个退化的 `<|DSML|calls>` + `</|DSML|invoke>` + `</|DSML|calls>`，
    //    里面没有任何 invoke → 不是调用块 → 被当正文透出。DSML 是私有标记，正文里不会正常出现。
    .replace(
      //    `dsml-` 连字符变体（`<dsml-calls>`）也要算 —— 本文件其它地方已声明兼容该变体。
      new RegExp(
        `<\\/?\\s*(?:(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)|dsml-)(?:dsml-)?(?:${WRAPPER_NAMES}|invoke)\\s*>`,
        'gi',
      ),
      '',
    )
    .replace(
      new RegExp(`<\\/\\s*(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?(?:dsml-)?(?:${WRAPPER_NAMES}|invoke)\\s*>`, 'gi'),
      '',
    )
    .replace(/<\/\s+(?:tool_calls?|function_calls|calls|invoke)\s*>/gi, '')
    .replace(/(^|\n)[ \t]*(?:in)?voke\s*>\s*(?=\n|$)/gi, '$1')
}

/**
 * 流式工具调用过滤器。
 * - 普通正文：立即透传（仅 hold back 末尾少量字符以观测跨包的调用标记）
 * - 命中调用标记（JSON 或 XML 两套）：进入捕获态，收全后转成 tool-call 请求，标记本身不外泄
 * - 解析失败：把捕获内容当普通正文吐出（降级但可见，绝不静默丢内容）
 * - 调用后面的剩余文本继续按普通正文处理（含围栏收尾清理）
 */
export class ToolCallStreamFilter {
  private pending = ''
  private capture: { mode: 'json' | 'xml'; buffer: string } | null = null
  private abandoned: { raw: string; mode: 'json' | 'xml'; reason?: 'unbalanced' | 'unparsable' | 'oversize' | 'echo' } | null = null
  private readonly knownTools?: ReadonlySet<string>

  constructor(knownTools?: ReadonlySet<string>) {
    this.knownTools = knownTools
  }

  push(text: string): FilterOutput {
    const out: FilterOutput = { text: '', calls: [] }
    if (text) {
      if (this.capture) this.capture.buffer += text
      else this.pending += text
    }
    this.drain(out)
    return out
  }

  flush(): FilterOutput {
    const out: FilterOutput = { text: '', calls: [] }
    if (this.capture) {
      // 流结束时仍未收全：先尝试宽容解析（转义修复 + 结构性补括号 + 缺闭合标签抢救）。
      const captured = this.capture
      const calls =
        captured.mode === 'xml' ? parseXmlToolCalls(captured.buffer) : parseSalvagedToolCallJson(captured.buffer)
      if (calls) out.calls.push(...calls)
      else if (looksLikeToolCallBlock(captured.mode, captured.buffer))
        this.abandoned ??= { raw: captured.buffer, mode: captured.mode, reason: classifyFailure(captured.mode, captured.buffer) }
      // 不像调用（只是正文里提到 `<invoke>` 这类词）→ 照常透出，
      // ⚠️ 但必须先剥残片：实测过 `<|DSML|calls>` + 闭合标签这种退化块会从这里漏到正文（2026-09-12）。
      else out.text += stripStrayToolMarkup(captured.buffer)
      this.capture = null
    }
    // 流结束：把 hold 住的尾巴吐出去之前先剥掉孤立残片 —— 它们会在这里"逃逸"成正文
    out.text += stripStrayToolMarkup(this.pending)
    this.pending = ''
    if (this.abandoned) out.rejected = this.abandoned
    return out
  }

  private drain(out: FilterOutput): void {
    for (;;) {
      if (this.capture) {
        const captured = this.capture
        if (captured.mode === 'xml') {
          const end = findXmlToolCallEnd(captured.buffer)
          if (end === -1) {
            if (captured.buffer.length > MAX_CAPTURE_CHARS) {
              // 超长仍未收全：是调用就丢弃（不吐乱码），只是正文提及则照常透出
              if (looksLikeToolCallBlock('xml', captured.buffer))
                this.abandoned ??= { raw: captured.buffer, mode: 'xml', reason: 'oversize' }
              else out.text += stripStrayToolMarkup(captured.buffer)
              this.capture = null
              continue
            }
            return
          }
          const block = captured.buffer.slice(0, end)
          const calls = parseXmlToolCalls(block)
          if (calls) out.calls.push(...calls)
          else if (looksLikeToolCallBlock('xml', block)) this.abandoned ??= { raw: block, mode: 'xml', reason: 'unparsable' }
          else out.text += stripStrayToolMarkup(block)
          this.capture = null
          this.pending = captured.buffer.slice(end).replace(FENCE_HEAD_RE, '') + this.pending
          continue
        }
        const balanced = extractBalancedJson(captured.buffer)
        if (!balanced) {
          if (captured.buffer.length > MAX_CAPTURE_CHARS) {
            // 超过上限仍没配平：放弃，但**不吐成正文**（那是乱码，不是回答）
            this.abandoned ??= { raw: captured.buffer, mode: 'json', reason: 'oversize' }
            this.capture = null
            continue
          }
          return
        }
        const calls = parseToolCallJson(balanced.json)
        if (calls) {
          // 未知工具名也照常透出：由运行器给出「未知工具」结果，模型可自行纠正。
          out.calls.push(...calls)
          this.capture = null
          this.pending = captured.buffer.slice(balanced.end).replace(FENCE_HEAD_RE, '') + this.pending
          continue
        }
        // 形状不符：能进到捕获态就说明 MARKER_RE 命中过（`{"tool_calls":`），
        // 因此这是**坏掉的调用**而不是正文 → 丢弃 + 告警（泄漏成正文才是真正的乱码来源）。
        const head = captured.buffer.slice(0, balanced.end)
        if (looksLikeToolCallBlock('json', head)) this.abandoned ??= { raw: head, mode: 'json', reason: 'unparsable' }
        else out.text += head
        this.capture = null
        this.pending = captured.buffer.slice(balanced.end) + this.pending
        continue
      }

      // 找最早的完整标记（JSON 或 XML）
      const jsonMarker = MARKER_RE.exec(this.pending)
      const xmlMarker = XML_STARTER_RE.exec(this.pending)
      const jsonIndex = jsonMarker?.index ?? -1
      const xmlIndex = xmlMarker?.index ?? -1
      const useXml = xmlIndex !== -1 && (jsonIndex === -1 || xmlIndex < jsonIndex)
      const index = useXml ? xmlIndex : jsonIndex
      if (index !== -1) {
        let head = this.pending.slice(0, index)
        const fence = FENCE_TAIL_RE.exec(head)
        if (fence) head = head.slice(0, fence.index)
        out.text += head
        this.capture = { mode: useXml ? 'xml' : 'json', buffer: this.pending.slice(index) }
        this.pending = ''
        continue
      }

      // 未见完整标记：先把夹在正文里的孤立残片剥掉，再保留末尾可能的标记前缀
      this.pending = stripStrayToolMarkup(this.pending)
      if (this.pending.length <= HOLD_BACK_CHARS) return
      const hold = partialMarkerSuffixLength(this.pending)
      if (hold > 0) {
        out.text += this.pending.slice(0, this.pending.length - hold)
        this.pending = this.pending.slice(this.pending.length - hold)
        return
      }
      out.text += this.pending
      this.pending = ''
      return
    }
  }
}

// ── 转写回声守卫 ──────────────────────────────────────────

/**
 * 剥离模型模仿的「系统标记」（`<ds_system>…</ds_system>` / `<system>…</system>`）。
 *
 * 实测（deepseek-web）：模型会在正文里吐出成串的伪系统标记，**模仿它见过的协议格式**。
 * 这与「转写回声」是同一类问题，但形态是 XML 标签而不是 `[Tool Result]` 行，
 * 所以单独一层处理。围栏代码块内不剥（正常回答可能讨论这些标记）。
 *
 * ## 标签清单（只列**有现场证据**的，不做通配）
 *
 * ⚠️ 刻意**不用** `<[a-z_]+>` 这种通配：用户的正常回答可能就是一段讨论这些标签的文档，
 * 通配会把它们一起吃掉。每加一个名字都要有现场 + 穷搜证据。
 *
 * | 标签 | 现场 |
 * | --- | --- |
 * | `ds_system` | 2026-09-11：一条正文里 13 个 `<ds_system>Tool result for call_1a2b3c</ds_system>`，调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…） |
 * | `system` | 同批现场 |
 * | `ide_result_status` | 2026-09-12（会话 `15ac4c56`）：正文里冒出 `<ide_result_status>Tool ran without output or errors</ide_result_status>`。⚠️ 该串在**DSH 的 `app.asar`（0 处）、全部已装插件（0 处）、`~/.dsh` 全树（0 处）**里都搜不到，且会话日志里**只出现在模型的输出字段**（212 条 `tool/result`、用户消息、系统消息里一处都没有）→ 判定是**模型自己编的**，不是 DSH 提供的 |
 *
 * @returns 剥离后的文本；`stripped` = 是否剥掉了至少一个标记（用于日志/告警）。
 */
const IMITATED_MARKER_TAGS = ['ds_system', 'system', 'ide_result_status'] as const

/**
 * 需要「正文够长」才剥的**跨行**标记。
 *
 * `tool_result`（2026-09-13 现场，会话 `15ac4c56` 记录 `[1480]`）：模型把 SSH 插件一次
 * 读取工具的结果**整段复述**进正文，形如
 *   `<tool_result>Path: …` + 换行 + `<path>…</path>` + 换行 + `<type>file</type>` + 换行 + `<content>` …
 * 它比 `ds_system` 那批更「可讨论」——用户正在开发**产出它的那个插件**，正常回答里
 * 可能出现简短示例。所以要求正文 ≥ 120 字才剥：真实回声是整份文件（实测那处上千字），
 * 随口举例不会有那么长。围栏代码块内同样不剥。
 */
const LONG_MARKER_TAGS: readonly { tag: string; minBody: number }[] = [{ tag: 'tool_result', minBody: 120 }]

const LONG_MARKER_ALT = LONG_MARKER_TAGS.map((entry) => entry.tag).join('|')
/** 跨行闭合形态（`[\s\S]` 而不是逐行匹配 —— 真实回声的正文是跨行的）。 */
const LONG_CLOSED_MARKER_RE = new RegExp(
  `<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
  'g',
)
/** 跨行未闭合形态（流被截断在标记中间）。 */
const LONG_OPEN_MARKER_RE = new RegExp(`<(${LONG_MARKER_ALT})\\b[^>]*>([\\s\\S]*)$`, 'g')

function minBodyFor(tag: string): number {
  return LONG_MARKER_TAGS.find((entry) => entry.tag === tag)?.minBody ?? 0
}

/**
 * 代码围栏区间（成对的 ``` 或 ~~~）。
 * 跨行替换没法像逐行处理那样顺手跟踪 inFence，所以先算出区间再判断命中点是否落在里面。
 */
function fencedRanges(text: string): Array<[number, number]> {
  const marks: number[] = []
  const re = /^[ \t]*(?:```|~~~)/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) marks.push(match.index)
  const ranges: Array<[number, number]> = []
  for (let i = 0; i + 1 < marks.length; i += 2) ranges.push([marks[i], marks[i + 1]])
  return ranges
}

function insideFence(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([from, to]) => index >= from && index < to)
}

/** 任一伪标记的开头是否出现（快速退出用，省掉对每段正文跑逐行循环）。 */
function hasImitatedMarker(text: string): boolean {
  if (IMITATED_MARKER_TAGS.some((tag) => text.includes(`<${tag}`))) return true
  return LONG_MARKER_TAGS.some((entry) => text.includes(`<${entry.tag}`))
}

/**
 * 闭合形态 `<tag …>…</tag>`：用**反向引用**要求首尾同名，
 * 避免 `<a>…</b>` 这种错配被当成一对连内容一起吃掉。
 */
const CLOSED_MARKER_RE = new RegExp(
  `<(${IMITATED_MARKER_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'g',
)
/** 未闭合形态：流在标记中间被截断 —— 半截标记同样是垃圾。 */
const OPEN_MARKER_RE = new RegExp(`<(${IMITATED_MARKER_TAGS.join('|')})\\b[^>]*>[\\s\\S]*$`, 'g')

export class SystemMarkerStreamFilter {
  private pending = ''
  private captured = ''
  private tag = ''
  private fence = ''
  private fenceSize = 0
  private readonly limit = 1024 * 1024
  push(text: string): { text: string; stripped: boolean } {
    this.pending += text
    return this.drain(false)
  }
  flush(): { text: string; stripped: boolean } { return this.drain(true) }
  private drain(final: boolean): { text: string; stripped: boolean } {
    let out = '', stripped = false
    const names = [...IMITATED_MARKER_TAGS, ...LONG_MARKER_TAGS.map(x => x.tag)]
    const opener = new RegExp('<(' + names.join('|') + ')\\b[^>]*>')
    while (this.pending.length) {
      const nl = this.pending.indexOf('\n')
      if (nl < 0 && !final) {
        // ⚠️ 逐行模式在没有换行时会一直缓冲到轮末。安全前缀：所有被识别的标记都以 `<`
        // 开头、围栏也必须在行首，所以「不在围栏内 + 不在捕获中 + 剩余部分既无 `<`
        // 也不是围栏候选开头」时直接吐出去，不可能漏掉标记、也不影响围栏状态判定。
        //
        // 效果边界（2026-09-13 实测，别高估它）：真正决定"上屏节奏"的是上游的
        // `TranscriptEchoGuard` —— 它同样逐行分类，无换行的回答会被它先扣到轮末，
        // 所以**整段没有换行**时这里再快也收不到东西（adapter 只会在轮末拿到一段）。
        // 这条优化保证的是：本层不再比上游更早地扣住文本（有换行的段落照旧逐行走，
        // 最后一个不完整行的前段也不必等到换行）。
        if (
          this.fence === '' &&
          !this.tag &&
          !this.pending.includes('<') &&
          !/^[ \t]{0,3}[`~]/.test(this.pending)
        ) {
          out += this.pending
          this.pending = ''
        }
        break
      }
      let line = nl < 0 ? this.pending : this.pending.slice(0, nl + 1)
      this.pending = nl < 0 ? '' : this.pending.slice(nl + 1)
      if (!this.tag) {
        const mark = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
        if (this.fence) {
          out += line
          if (mark && mark[1][0] === this.fence && mark[1].length >= this.fenceSize &&
              !line.slice(mark[0].length).trim()) this.fence = ''
          continue
        }
        if (mark) { this.fence = mark[1][0]; this.fenceSize = mark[1].length; out += line; continue }
      }
      while (line) {
        if (!this.tag) {
          const match = opener.exec(line)
          if (!match) { out += line; break }
          out += line.slice(0, match.index)
          this.tag = match[1]
          this.captured = match[0]
          line = line.slice(match.index + match[0].length)
        }
        const close = '</' + this.tag + '>'
        const at = line.indexOf(close)
        if (at < 0) { this.captured += line; line = ''; break }
        this.captured += line.slice(0, at + close.length)
        line = line.slice(at + close.length)
        const openEnd = this.captured.indexOf('>') + 1
        const bodySize = this.captured.length - openEnd - close.length
        const long = LONG_MARKER_TAGS.find(x => x.tag === this.tag)
        if (!long || bodySize >= long.minBody) stripped = true
        else out += this.captured
        this.captured = ''; this.tag = ''
      }
    }
    if (this.pending.length + this.captured.length > this.limit) {
      throw new Error('系统标记缓冲超过 1 MiB，拒绝静默截断正文')
    }
    if (final && this.tag) {
      const long = LONG_MARKER_TAGS.find(x => x.tag === this.tag)
      const bodySize = this.captured.length - this.captured.indexOf('>') - 1
      if (!long || bodySize >= long.minBody) stripped = true
      else out += this.captured
      this.captured = ''; this.tag = ''
    }
    return { text: out, stripped }
  }
}

export function stripSystemMarkers(text: string): { text: string; stripped: boolean } {
  if (!hasImitatedMarker(text)) return { text, stripped: false }

  // 第一遍：**跨行**长标记。逐行循环匹配不到跨行的闭合形式，所以先在全文上做一次
  //（围栏区间先算好，落在围栏里的命中跳过，与逐行那遍的保护策略一致）。
  const ranges = fencedRanges(text)
  let strippedLong = false
  let source = text
    .replace(LONG_CLOSED_MARKER_RE, (match, tag, body, offset) => {
      if (String(body).length < minBodyFor(String(tag))) return match
      if (insideFence(offset, ranges)) return match
      strippedLong = true
      return ''
    })
    .replace(LONG_OPEN_MARKER_RE, (match, tag, body, offset) => {
      if (String(body).length < minBodyFor(String(tag))) return match
      if (insideFence(offset, ranges)) return match
      strippedLong = true
      return ''
    })

  text = source
  let out = ''
  let inFence = false
  let stripped = strippedLong
  let i = 0
  while (i < text.length) {
    const lineEnd = text.indexOf('\n', i)
    const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd + 1)
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) inFence = !inFence
    if (!inFence) {
      out += line
        .replace(CLOSED_MARKER_RE, () => {
          stripped = true
          return ''
        })
        .replace(OPEN_MARKER_RE, () => {
          // 流在标记中间被截断：半截标记同样是垃圾
          stripped = true
          return ''
        })
    } else {
      out += line
    }
    i = lineEnd === -1 ? text.length : lineEnd + 1
  }
  return { text: out, stripped }
}

// ── 网页端免责声明剥离 ────────────────────────────────────

/**
 * DeepSeek 网页端在**每一轮回复末尾**自动追加的免责声明（不是模型回答的一部分）。
 *
 * 实测（2026-09-11，27 个 DSH 会话里命中 43 处，形态唯一）：
 *   `本回答由 AI 生成，内容仅供参考，请仔细甄别`
 * 它会以 SSE 增量形式到达，甚至被拆成「 AI」「 生成」「，」「内容」这样的小包。
 *
 * 为什么必须剥掉：
 *   - 它卡在两条回答中间（自动续写的缝就在它后面），用户会以为「模型怎么突然插了这句话」；
 *   - 结尾是「甄别」这种汉字 → `looksMidSentence` 恒为真 → **每一轮都被误判成「句中被截」**，
 *     于是无限触发自动续写（续写轮又追加一遍声明，再被判成截断……）。
 */
const WEB_DISCLAIMER = '本回答由 AI 生成，内容仅供参考，请仔细甄别'

/**
 * 一次性剥离网页端免责声明（非流式）。
 *
 * 轮末残余必须用它再过一遍：`BoilerplateFilter` 的流式扣留只管它**收到**的文本，
 * 而过滤器扣住的最后 ≤24 个字符还没经过它 —— 声明恰好 23 字，实测就整段从尾巴漏出去
 * （会话 `6c0dbc47` 里它是一个只有单个 delta 的独立 text 块，跟在工具调用后面）。
 */
export function stripWebDisclaimer(text: string): { text: string; stripped: boolean } {
  if (!text.includes(WEB_DISCLAIMER)) return { text, stripped: false }
  return { text: text.split(WEB_DISCLAIMER).join(''), stripped: true }
}

/**
 * 轮末收尾：把三层缓冲扣住的残余按**真实顺序**吐净，并补跑只作用于上屏前的两道清理。
 *
 * ⚠️ 为什么不能只把三层 flush 结果拼起来：
 *   - 吐净顺序必须是流水线**反序**（越深的层扣住的文本越早）—— 否则最后几段文字前后颠倒；
 *   - 浅层（过滤器）扣住的字符**从没经过**「剥声明」这一层，而声明就爱待在最后几个字符里；
 *   - 同理，伪系统标记也可能整段藏在尾巴里。
 * 轮末没有后续输入了，所以这里可以直接做一次性替换，不需要流式扣留。
 *
 * `cleanMarkers`（2026-09-13，审计 N03）：是否在**这里**用无状态的 `stripSystemMarkers`
 * 补剥伪系统标记。streamImpl 现在传 `false` —— 因为它已经用有状态的
 * `SystemMarkerStreamFilter` 处理残余了，两遍都跑只会重复劳动；
 * 默认 `true` 保留原语义，供单测与其它调用方使用。
 */
export function drainTextPipeline(
  filter: ToolCallStreamFilter,
  boilerplate: BoilerplateFilter,
  guard: TranscriptEchoGuard,
  cleanMarkers = true,
): {
  text: string
  echoed: boolean
  disclaimers: number
  calls: FilterOutput['calls']
  rejected: FilterOutput['rejected']
} {
  const tailGuarded = guard.flush()
  const tailBoiled = boilerplate.flush()
  const tail = filter.flush()
  const raw = tailGuarded.text + tailBoiled.text + tail.text
  const dedisclaimered = stripWebDisclaimer(raw)
  const cleaned = cleanMarkers ? stripSystemMarkers(dedisclaimered.text) : {text: dedisclaimered.text, stripped:false}
  return {
    text: cleaned.text,
    echoed: tailGuarded.echoed,
    disclaimers: boilerplate.count + (dedisclaimered.stripped ? 1 : 0),
    calls: tail.calls,
    rejected: tail.rejected,
  }
}

/**
 * 流式剥离网页端免责声明。
 *
 * 逐包调用：命中即整段丢弃。
 *
 * ⚠️ 扣留策略必须是「**恒定扣住最后 |声明|-1 个字符**」，不能只扣「声明的前缀」：
 * 声明会被 SSE 切成任意小包（实测有「 AI」「 生成」「，」「内容」这种），
 * 一旦切点落在声明中间，前半截已经不是「前缀」了 —— 只扣前缀就会把它放出去，
 * 后半截到齐时再也拼不回来（2026-09-11 实测漏过一次）。
 * 扣 22 个字符的代价是上屏延迟 22 字，肉眼不可见。
 */
export class BoilerplateFilter {
  private pending = ''
  private hits = 0
  private stripped = false
  private readonly holdChars = WEB_DISCLAIMER.length - 1

  push(text: string): { text: string; stripped: boolean } {
    this.pending += text
    let out = ''
    for (;;) {
      const at = this.pending.indexOf(WEB_DISCLAIMER)
      if (at !== -1) {
        out += this.pending.slice(0, at)
        this.pending = this.pending.slice(at + WEB_DISCLAIMER.length)
        this.hits += 1
        this.stripped = true
        continue
      }
      const hold = Math.min(this.pending.length, this.holdChars)
      out += this.pending.slice(0, this.pending.length - hold)
      this.pending = this.pending.slice(this.pending.length - hold)
      return { text: out, stripped: this.stripped }
    }
  }

  flush(): { text: string; stripped: boolean } {
    const rest = this.pending
    this.pending = ''
    return { text: rest, stripped: this.stripped }
  }

  /** 本次流剥掉了几处声明（用于留痕）。 */
  get count(): number {
    return this.hits
  }
}

/**
 * 转写格式标记 —— 也就是 `serializePrompt` 写进 prompt 的那套行首标记。
 *
 * 模型会**照着 prompt 里的转写格式模仿**，把工具结果 / 系统标记当回答吐出来。
 * 这与「工具调用标记泄漏」是**两个独立的泄漏源**：`ToolCallStreamFilter` 只防后者。
 *
 * 实测（2026-09-10，deepseek-web / deepseek-reasoner）可见正文里出现：
 *   `[Tool Result for call_xxx]` + 真实工具输出 + `[status: running]`
 * 以及成串的 `User: …` / `Assistant: …` 转写行。
 * 2026-09-11 补：还有一种更隐蔽的形态 —— 给回声行加 `Assistant: ` 前缀
 * （`Assistant: [Tool Result for call_xxx]`），必须按「行内含转写标记」判，见 ECHO_INLINE_SIGNATURES。
 */
const ECHO_SIGNATURES: readonly RegExp[] = [
  /^\[\s*Tool Result\b/i,
  /^\[\s*status\s*:\s*[a-z_]+\s*\]$/i,
  /^\[\s*(?:System|Assistant)\s*\]$/i,
]
/** 转写轮次行：单行可能只是正文，成串出现才是回声。 */
const ECHO_TURN_RE = /^(?:User|Assistant)\s*:/

/**
 * 转写特征出现在**行内任意位置**（不要求行首）。
 *
 * 实测（2026-09-11 17:07，install-plugin 工作区）：模型输出的回声长这样 ——
 *   `Assistant: [Tool Result for call_7b1a7d39a2e54bc0b8f1]`
 *   `direct ERR fetch failed`
 * 它给回声加了 `Assistant: ` 前缀，于是行首不再匹配 ECHO_SIGNATURES，
 * 被当成「正文里偶尔出现的 User: 字样」放行（还顺带把后面那行也带了出来）。
 * 所以只要一行里**含有**这些标记，就当回声处理。
 */
/**
 * 行内转写特征 —— **拆成强弱两档**，因为两者的可信度完全不同。
 *
 * 弱档：模型在**正常回答里引用一次**工具结果当证据是很常见的写法。
 *   实测（2026-09-16 17:35，1ceshi 工作区会话 e17f4ccf）：它正是在正文里引 `[Tool Result …]`
 *   来证明 `subagent_fork` 的继承范围与文档不符 —— 旧判据"行内命中即从该行起砍到结尾"把
 *   整段回答（问题项 4、5 + 结论）一起吞了，用户只看到"话说到一半就停了"。
 *   ⇒ 单独出现**不足以判定**是回声：只扣住，等后文再看（见 TranscriptEchoGuard.heldKind）。
 *
 * 强档：`truncated]` / `Assistant truncated` / `[N chars omitted]` 是 **prompt 自己的截断占位符**，
 *   正常回答几乎不会引用它们 ⇒ 仍按回声立即处理
 *   （实测 2026-09-11 17:2x：会话超长后模型原样复读这些占位符）。
 */
const ECHO_INLINE_WEAK_SIGNATURES: readonly RegExp[] = [
  /\[\s*Tool Result\b/i,
  /\[\s*status\s*:/i,
  /\[\s*(?:System|Assistant)\s*\]/i,
]

const ECHO_INLINE_STRONG_SIGNATURES: readonly RegExp[] = [
  /\[\s*truncated\s*\]/i,
  /assistant\s+truncated/i,
  /\[\s*\d+\s*chars?\s+omitted\s*\]/i,
]

/** 任一档（用于「该行是否含行内标记」的组合判断，如轮次前缀 + 行内标记）。 */
const ECHO_INLINE_SIGNATURES: readonly RegExp[] = [
  ...ECHO_INLINE_WEAK_SIGNATURES,
  ...ECHO_INLINE_STRONG_SIGNATURES,
]

/**
 * 行内弱特征行被扣住后，还要看到几行**普通内容**才敢判它是正文。
 *
 * 取 2：真回声紧跟着的还是转写内容（行首标记 / 轮次行 / 又一处引用），两行都干净就基本不是回放。
 */
const WEAK_HOLD_LINES = 2

/** 扣住的行最多再缓冲几行就强制放行（防止"只有空行"时无限期扣住）。 */
const MAX_HELD_TAIL = 6

/** 光秃秃的 `Assistant:` / `User:`（冒号后没有内容）—— 模型正在起一行假转写。 */
const ECHO_BARE_TURN_RE = /^(?:User|Assistant)\s*:\s*$/

/** 回声标记的**半截前缀**（流在行中间被截断时出现）——同样是垃圾，不能上屏。 */
const ECHO_PREFIXES = ['[tool result', '[status:', '[system]', '[assistant]']

/** 该行是否是某个回声标记的开头片段。 */
function looksLikeEchoPrefix(line: string): boolean {
  const t = line.trim().toLowerCase()
  return t.length > 0 && ECHO_PREFIXES.some((p) => p.startsWith(t))
}

/**
 * 逐行守卫：命中回声特征后，**从该行起全部丢弃**。
 *
 * 为什么这样设计：
 *  - 回声几乎总出现在末尾（模型在「续写转写」），前面才是真回答 → 截断比整段丢弃更保内容；
 *  - 围栏代码块内不判定 —— 正常回答里也可能引用这些标记（比如讨论本插件时）；
 *  - 逐行缓冲、保留末尾未完成的半行 → 流式下也不会先把垃圾推给用户再吞回去。
 */
export class TranscriptEchoGuard {
  private pending = ''
  private inFence = false
  /**
   * 已扣住、尚未判定的一行（等后文决定它是回声还是正文）。
   * 两种来源：转写轮次行（`User:` / `Assistant:` 后有内容）、行内弱特征行（正文里引用了一次 `[Tool Result …]`）。
   */
  private heldLine: string | null = null
  private heldKind: 'turn' | 'weak' | null = null
  /** 弱特征行之后已看到的**非空白**普通行数（够 `WEAK_HOLD_LINES` 行仍无回声 → 判为正文、放行）。 */
  private heldSeen = 0
  /**
   * 扣住期间**后续行也要缓冲**，否则它们会抢在被扣的那行之前上屏（顺序错乱）。
   * 放行时按原顺序一次性吐出；判回声时整段丢弃。
   */
  private heldTail: string[] = []
  private fired = false

  /**
   * @returns `text` = 可以安全上屏的部分；`echoed` = 本轮是否出现过回声（那部分已被丢弃）。
   */
  push(text: string): { text: string; echoed: boolean } {
    if (this.fired) return { text: '', echoed: true }
    this.pending += text
    let out = ''
    for (;;) {
      const nl = this.pending.indexOf('\n')
      if (nl === -1) break
      const line = this.pending.slice(0, nl + 1)
      this.pending = this.pending.slice(nl + 1)
      const verdict = this.classify(line)
      if (verdict === 'echo') {
        this.fired = true
        this.pending = ''
        this.heldLine = null
        this.heldKind = null
        this.heldTail = []
        return { text: out, echoed: true }
      }
      if (verdict === 'turn' || verdict === 'weak') {
        // 单行可能只是正常正文（正文里写 `User: admin`、或引用一次 `[Tool Result …]` 当证据），
        // **先扣住**，等后文判定 —— 否则第一行会先泄漏上屏。
        // 已经持有一行时说明两者**相邻出现** ⇒ 判回声（"连续两行才算回放"的判据）。
        if (this.heldLine !== null) {
          this.fired = true
          this.pending = ''
          this.heldLine = null
          this.heldKind = null
          this.heldTail = []
          return { text: out, echoed: true }
        }
        this.heldLine = line
        this.heldKind = verdict
        this.heldSeen = 0
        continue
      }
      // 普通行/围栏行：
      //  - 扣住的是转写轮次行 ⇒ 只要这一行**非空白**，就说明那只是正文里的 `User:` 字样 → 放行
      //  - 扣住的是行内弱特征行 ⇒ 再看 `WEAK_HOLD_LINES` 行普通内容才敢放行
      //    （引用一次工具结果是极常见的写法；而真回声紧跟着的还是转写内容 —— 多等两行能把两者分开）
      if (this.heldLine !== null) {
        // ⚠️ 扣住期间后续行**也必须缓冲**：否则它们会先上屏、被扣的那行后上屏，正文顺序就乱了。
        this.heldTail.push(line)
        const blank = line.trim() === ''
        const release =
          (this.heldKind === 'turn' ? !blank : !blank && ++this.heldSeen >= WEAK_HOLD_LINES) ||
          // 兜底：一直只有空行时别无限扣（最多扣 `MAX_HELD_TAIL` 行就开始放行）
          this.heldTail.length >= MAX_HELD_TAIL
        if (release) {
          out += this.heldLine
          for (const held of this.heldTail) out += held
          this.heldLine = null
          this.heldKind = null
          this.heldTail = []
        }
        continue
      }
      out += line
    }
    return { text: out, echoed: false }
  }

  flush(): { text: string; echoed: boolean } {
    if (this.fired) return { text: '', echoed: true }
    let out = ''
    // 只有孤零零一行待判定行 → 判定为正文，放行（连同扣住期间缓冲的后续行）
    if (this.heldLine !== null) {
      out += this.heldLine
      for (const held of this.heldTail) out += held
      this.heldLine = null
      this.heldKind = null
      this.heldTail = []
    }
    const rest = this.pending
    this.pending = ''
    // 流在行中间断掉：完整的回声判不出来，但半截标记前缀同样是垃圾，一律丢弃
    if (rest && (this.classify(rest) === 'echo' || looksLikeEchoPrefix(rest))) {
      this.fired = true
      return { text: out, echoed: true }
    }
    return { text: out + rest, echoed: false }
  }

  private classify(line: string): 'echo' | 'turn' | 'weak' | 'fence' | 'plain' {
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      this.inFence = !this.inFence
      return 'fence'
    }
    if (this.inFence) return 'plain'
    for (const re of ECHO_SIGNATURES) if (re.test(t)) return 'echo'
    // 截断占位符被拦腰切开后剩下的残片（如单独一行 `truncated]`）
    if (/^\]?\s*truncated\s*\]?\s*$/i.test(t)) return 'echo'
    // 强档行内特征（prompt 的截断占位符）：正常回答几乎不会引用 ⇒ 照旧立即判回声
    for (const re of ECHO_INLINE_STRONG_SIGNATURES) if (re.test(t)) return 'echo'
    // 冒号后没内容的 `Assistant:` —— 真回答里几乎不会出现，放过它就等着看回放
    if (ECHO_BARE_TURN_RE.test(t)) return 'echo'
    if (ECHO_TURN_RE.test(t)) {
      // 转写轮次前缀 **+** 行内标记 = 两个证据叠加
      // （2026-09-11 现场形态：`Assistant: [Tool Result for call_…]`）⇒ 判回声
      for (const re of ECHO_INLINE_WEAK_SIGNATURES) if (re.test(t)) return 'echo'
      return 'turn'
    }
    // 只有行内弱特征 ⇒ 可能只是正文里引用了一次工具结果，交给 push 扣住、等后文再判
    for (const re of ECHO_INLINE_WEAK_SIGNATURES) if (re.test(t)) return 'weak'
    return 'plain'
  }
}
