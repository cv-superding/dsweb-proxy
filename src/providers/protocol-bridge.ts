/**
 * protocol-bridge —— OpenAI 消息形态 ⇄ DSH protocol.ts 消息形态的适配层。
 *
 * DSH 的 serializePrompt 吃的是宿主块状消息（content 是块数组：text / tool-call /
 * tool-result / image）。本反代的 NormalizedRequest 已在 server 层把 OpenAI 消息
 * 归一化成同样的块状形态，这里只做两件事：
 *  1. 原样再导出 protocol.ts 的流式过滤器与解析器（行为与 DSH 插件逐字节一致）；
 *  2. 提供 looksMidSentence（续写判据，从 adapter.ts 移植到独立模块）。
 */
export {
  TOOL_PROTOCOL_INSTRUCTIONS,
  ToolCallStreamFilter,
  SystemMarkerStreamFilter,
  BoilerplateFilter,
  TranscriptEchoGuard,
  drainTextPipeline,
  looksLikeUnexecutedToolProgram,
  serializePromptParts,
  collectImageRefs,
  imageUploadName,
  type ToolSchemaLike,
} from '../core/protocol.ts'

export { looksMidSentence } from './looks-mid-sentence.ts'
