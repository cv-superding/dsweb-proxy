/** token 估算（从 DSH adapter.ts 原样移植，供 usage 上报用）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x3000 && code <= 0x9fff) cjk += 1
  }
  const ascii = text.length - cjk
  return Math.ceil(cjk / 1.5 + ascii / 4)
}
