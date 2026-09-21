/**
 * 句中截断启发式（从 DSH adapter.ts 原样移植 —— 判据与注释一并保留）。
 */
const MID_SENTENCE_TAIL = new Set(['，', '、', '；', '：', ',', ';', ':'])

/**
 * 出现在末尾即视为「正常收尾」的标点。
 *
 * ⚠️ `…` 放在这里是**刻意的取舍**：省略号既可能是"话没说完"，也可能是作者有意的收束语气，
 * 两种都常见。判 true 会让一句正常收尾的话被要求"接着写"（模型容易重复一遍），
 * 感知上比偶发漏判更打扰，所以保守放行。真被服务端切断（无 FINISHED）时走 `cutByServer`，
 * 不依赖这条判据。
 */
const COMPLETE_TAIL = new Set(['。', '！', '？', '!', '?', '…', '）', ')', '】', '》', '」', '』', '"', '”', '’'])

/**
 * 启发式：正文是否「在句中被截」。
 * 判据（尾部最后一个非空白字符）：
 *  - 是 CJK 汉字/字母/数字（没有任何标点收尾）→ 大概率被截；
 *  - 是 markdown 强调标记（`**` / `__`）→ 被截在标记中间；
 *  - 是逗号/顿号/分号/冒号 → 明显未完。
 *  正常结束的正文几乎总以句号/问号/感叹号/右引号/右括号/代码块收尾/表格行结尾出现。
 *
 * ⚠️ 这是启发式，**只在"明显没写完"时才敢返回 true**：误判 true 只是白发一次续写请求，
 * 误判 false 却是用户直接丢内容 —— 两种代价不同，所以判据本身要能读懂「分隔符 vs 终止符」。
 */
function looksMidSentence(text: string): boolean {
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return false
  // F29：短文本（< 40 字）不判「句中被截」——"我在""在吗"这类**完整短答**天然以汉字收尾，
  // 旧判据对它恒真，会白打 1~2 次续写请求。服务端真截断（cutByServer，无 FINISHED）不走
  // 这条判据、仍会续写，所以这里收窄只影响「有 FINISHED 但尾部是汉字」的场景。
  if (trimmed.length < 40) return false
  const last = trimmed[trimmed.length - 1]
  // markdown 标记收尾：`*` `_` `#` `~` `` ` `` 本身可能是「标记被截」，只有成对的一半才算
  if (last === '*' || last === '_' || last === '#' || last === '~' || last === '`') {
    return trimmed.endsWith('**') || trimmed.endsWith('__')
  }
  if (MID_SENTENCE_TAIL.has(last)) return true
  if (COMPLETE_TAIL.has(last)) return false
  // 字母/数字/汉字/其他非标点字符收尾 → 大概率被截
  return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last)
}


export { looksMidSentence }
