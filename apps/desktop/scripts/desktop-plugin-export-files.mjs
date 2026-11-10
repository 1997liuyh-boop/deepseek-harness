/** 收集插件独立构建所需的源码和普通资源。 */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

/** @param {string} source 原文件。 @param {string} target 目标文件。 */
export async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

/** @param {string} path 入口。 @param {string} root 导出目录。 @param {string} repository 源码根。 @param {Set<string>} seen 已收集文件。 */
export async function copySource(path, root, repository, seen = new Set()) {
  if (seen.has(path)) return
  seen.add(path)
  const text = await readFile(path, 'utf8')
  await copy(path, join(root, 'source', relative(repository, path)))
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue
    const imported = resolve(dirname(path), statement.moduleSpecifier.text)
    if (!relative(repository, imported).startsWith('..') && /\.[cm]?[jt]sx?$/u.test(imported)) await copySource(imported, root, repository, seen)
  }
}
