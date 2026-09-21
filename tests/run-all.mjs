/**
 * 离线测试总入口：node tests/run-all.mjs
 * 全部跑在 node --experimental-strip-types 上（Node 24 原生支持，无需构建）。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const suites = [
  'check-openai-format.mjs',
  'check-normalize.mjs',
  'check-provider-fake-stream.mjs',
  'check-http-e2e.mjs',
]

let failed = 0
for (const suite of suites) {
  const path = join(here, suite)
  const result = spawnSync(process.execPath, ['--experimental-strip-types', path], {
    stdio: 'inherit',
    cwd: join(here, '..'),
    env: { ...process.env, NODE_OPTIONS: '' },
  })
  if (result.status !== 0) {
    failed += 1
    console.error(`✗ ${suite} 失败`)
  } else {
    console.log(`✓ ${suite}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个测试文件失败`)
  process.exit(1)
}
console.log('\n全部离线测试通过')
