/**
 * 构建：src/cli.ts → dist/cli.cjs（单文件 bundle，SEA 要求自包含）。
 * 用 esbuild：tsdown(rolldown) 的 chunk 拆分不受 inlineDynamicImports 控制（实测 18:36），
 * esbuild 一个 bundle:true 就够。
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',      // 只打包本地代码；node: 内置与 npm 包保持 external
  sourcemap: false,
  minify: false,
  legalComments: 'none',
})
console.log('build done → dist/cli.cjs (single file)')
