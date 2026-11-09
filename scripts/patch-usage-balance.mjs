/** 为已安装的用量插件应用有版本约束的余额兼容修正；不改动凭据或用量记录。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @param {string} profile 目标配置目录。 @returns {Promise<boolean>} 是否安装了需要修正的插件。 */
export async function patchUsageBalance(profile) {
  const root = join(profile, 'node_modules/@feiyang666/dsh-usage-plugin')
  let manifest
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (manifest.version !== '1.18.0') throw new Error('用量插件版本已变化，请重新核对余额兼容修正：' + manifest.version)
  const replace = (source, before, after) => {
    if (source.includes(after)) return source
    if (!source.includes(before)) throw new Error('用量插件代码已变化，余额兼容修正未应用')
    return source.replace(before, after)
  }
  const indexPath = join(root, 'lib/index.js'), clientPath = join(root, 'lib/client.js')
  let index = await readFile(indexPath, 'utf8'), client = await readFile(clientPath, 'utf8')
  // 早期补丁只引入两个函数；升级时先移除旧的引入行，再写入完整引入，避免重复声明。
  const legacyImport = "import { officialBalanceProfile, officialBalanceFailure } from './dsh-balance-compat.mjs'\n"
  const compatImport = "import { officialBalanceProfile, officialBalanceFailure, accountBalance, isOpenPlatformKey, keyShapeFailure } from './dsh-balance-compat.mjs'\n"
  if (index.includes(legacyImport) && !index.includes(compatImport)) index = index.replace(legacyImport, '')
  index = replace(index, "import path from 'node:path'", compatImport + "import path from 'node:path'")
  index = replace(index, "        if (!provider || provider.queryMode !== 'direct') return null", "        if (!provider || provider.queryMode !== 'direct') return null\n        if (provider.id === 'deepseek') return officialBalanceProfile(ctx.get('settings'))")
  // 已登录 DeepSeek 账号时余额走账号接口，不再拿开放平台密钥去官方接口。
  index = replace(index, '        const credentialCandidates = []', "        if (provider.id === 'deepseek') {\n          const viaAccount = await accountBalance(ctx, provider)\n          if (viaAccount) return viaAccount\n        }\n        const credentialCandidates = []")
  // 已保存的值不是 sk- 密钥（例如登录令牌）时直接说明，不发起必然 401 的请求。
  const endpointLine = '        const endpoint = resolveBalanceEndpoint(provider.id, modelProfile && modelProfile.baseURL)'
  index = replace(index, endpointLine, endpointLine + "\n        if (provider.id === 'deepseek' && !isOpenPlatformKey(hit.value)) {\n          const shape = keyShapeFailure()\n          return balanceFailure(provider, shape.error, { ...shape, credentialName: hit.name, credentialSource: hit.source, modelProviderRoute: hit.route, endpoint })\n        }")
  index = replace(index, "        if (provider.id !== 'siliconflow') {", "        if (provider.id !== 'siliconflow' && provider.id !== 'deepseek') {")
  const authBlock = [
    "        if (provider.id === 'deepseek' && (parsed.statusCode === 401 || parsed.statusCode === 403)) {",
    '          const failure = officialBalanceFailure(parsed.statusCode)',
    '          return balanceFailure(provider, failure.error, { ...failure, statusCode: parsed.statusCode,',
    '            credentialName: hit.name, credentialSource: hit.source, modelProviderRoute: hit.route, endpoint })',
    '        }',
  ].join('\n')
  index = index.replace(authBlock + '\n', '')
  const authCheck = "        if (parsed.statusCode !== 200) {\n          const authHint ="
  index = replace(index, authCheck, authBlock + '\n' + authCheck)
  client = replace(client, '(res && res.error) || t("查询失败")', '(__LANG === "en" && res && res.errorEn) || (res && res.error) || t("查询失败")')
  client = replace(client, ': t("请确认凭据类型正确、权限包含余额/账单读取，且网络可访问服务商官方 API。")', [
    ': provider === "deepseek"',
    '                  ? (__LANG === "en" ? "Uses the API key saved in Settings → Models → DeepSeek. This is separate from DeepSeek Account sign-in." : "使用“设置 → 模型 → DeepSeek”保存的 API Key，与“DeepSeek 账号”的网页登录授权独立。")',
    '                  : t("请确认凭据类型正确、权限包含余额/账单读取，且网络可访问服务商官方 API。")',
  ].join('\n'))
  client = replace(client, '"note.deepseek": "数据来自 DeepSeek 官方 /user/balance 接口。"', '"note.deepseek": "数据来自 DeepSeek 官方 /user/balance 接口。","note.deepseekAccount": "数据来自 DeepSeek 账号登录（platform.deepseek.com 用户摘要），与开放平台 API Key 无关。"')
  client = replace(client, '"note.deepseek": "Data from the official DeepSeek /user/balance endpoint."', '"note.deepseek": "Data from the official DeepSeek /user/balance endpoint.","note.deepseekAccount": "Data from the DeepSeek account sign-in (platform.deepseek.com user summary), independent of any Open Platform API key."')
  client = replace(client, 'hint: t("DEEPSEEK_API_KEY（推理 Key）")', 'hint: (__LANG === "en" ? "Open Platform API key saved in Settings → Models → DeepSeek" : "设置 → 模型 → DeepSeek 中保存的开放平台 API Key"), actionUrl: "https://platform.deepseek.com/api_keys", actionLabel: (__LANG === "en" ? "Open DeepSeek API keys" : "打开 DeepSeek API 密钥")')
  const helper = await readFile(new URL('../apps/desktop/scripts/usage-balance-compat.mjs', import.meta.url), 'utf8')
  // 全部匹配检查成功后才更新已安装插件；重复执行保持相同结果。
  await writeFile(join(root, 'lib/dsh-balance-compat.mjs'), helper)
  await writeFile(indexPath, index)
  await writeFile(clientPath, client)
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('请提供 dsh profile 目录')
  console.log(await patchUsageBalance(resolve(process.argv[2])) ? '余额兼容修正已应用' : '未安装用量插件，无需修正')
}
