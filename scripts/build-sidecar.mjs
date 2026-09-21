/**
 * sidecar 构建：dist/cli.mjs + node.exe → src-tauri/binaries/dsweb-proxy-node-<target-triple>.exe
 * 用 Node 官方 SEA（single executable applications）。
 */
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const triple = 'x86_64-pc-windows-msvc'
const outName = `dsweb-proxy-node-${triple}.exe`
const outDir = join(root, 'src-tauri', 'binaries')

console.log('[1/4] 生成 SEA blob')
execSync('node --experimental-sea-config sea-config.json', { cwd: root, stdio: 'inherit' })

console.log('[2/4] 复制 node.exe')
const nodeExe = process.execPath
const target = join(outDir, outName)
mkdirSync(outDir, { recursive: true })
rmSync(target, { force: true })
copyFileSync(nodeExe, target)

console.log('[3/4] 定位 postject')
// postject 由 npx 临时拉取（首次联网，之后走缓存）
console.log('[4/4] 注入 blob')
const blob = join(root, 'sea-prep.blob')
const code = `NODE_SEA_BLOB=${JSON.stringify(blob)} NODE_SEA_EXE=${JSON.stringify(target)}`
execSync(`npx --yes postject ${JSON.stringify(target)} NODE_SEA_BLOB ${JSON.stringify(blob)} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { cwd: root, stdio: 'inherit' })

rmSync(blob, { force: true })
console.log(`sidecar 完成 → ${target}`)
