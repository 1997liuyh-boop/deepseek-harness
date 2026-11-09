import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

/** 使用 Tailwind 生成隔离的 CSS Modules，保留宿主的基础样式。 */
export async function buildOrbStyles(packageDir, name) {
  const source = join(packageDir, 'src/client', name + '.tw.css')
  const target = join(packageDir, 'src/client', name + '.module.css')
  const result = await postcss([tailwind()]).process(await readFile(source, 'utf8'), { from: source, to: target })
  await writeFile(target, result.css)
}
