/** 用量插件补丁只修改官方余额分支，保留其他平台的处理。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { patchUsageBalance } from './patch-usage-balance.mjs'

/** 与已安装插件同形的最小夹具：含补丁需要的全部锚点行。 */
const INDEX_FIXTURE = [
  "import path from 'node:path'",
  'let ctx = { get: () => undefined }',
  'export function setContext(value) { ctx = value }',
  'export function queryOther(parsed) {',
  '        if (parsed.statusCode !== 200) { return "other-failure" }',
  '}',
  'export async function queryBalance(provider, parsed, key) {',
  'const modelProfile = null',
  'const resolveBalanceEndpoint = () => "official"',
  'const hit={name:"OFFICIAL_KEY",source:"file",route:"deepseek-official",value:key||"sk-0123456789abcdefghij"};',
  'const balanceFailure=(provider,error,fields)=>({ok:false,error,...fields});',
  '        const credentialCandidates = []',
  '        const endpoint = resolveBalanceEndpoint(provider.id, modelProfile && modelProfile.baseURL)',
  '        if (parsed.statusCode !== 200) {',
  '          const authHint = "generic";',
  '          return {error:authHint};',
  '        }',
  'return {ok:true};',
  '}',
  'function configuredModelProvider(provider) {',
  "        if (!provider || provider.queryMode !== 'direct') return null",
  "        if (provider.id !== 'siliconflow') { return null }",
  '}',
].join('\n')
const CLIENT_FIXTURE = [
  '(res && res.error) || t("查询失败");',
  'selected.unsupported ? "x" : t("请确认凭据类型正确、权限包含余额/账单读取，且网络可访问服务商官方 API。");',
  '({hint: t("DEEPSEEK_API_KEY（推理 Key）")});',
  'var zh = {"note.deepseek": "数据来自 DeepSeek 官方 /user/balance 接口。"};',
  'var en = {"note.deepseek": "Data from the official DeepSeek /user/balance endpoint."};',
].join('\n')

async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-usage-patch-'))
  const root = join(profile, 'node_modules/@feiyang666/dsh-usage-plugin')
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.18.0' }))
  await writeFile(join(root, 'lib/index.js'), INDEX_FIXTURE)
  await writeFile(join(root, 'lib/client.js'), CLIENT_FIXTURE)
  return { profile, root, indexPath: join(root, 'lib/index.js') }
}

test('补丁绑定余额凭据查询，不误改同文件其他HTTP分支；重复运行不累积代码', async () => {
  const { profile, root, indexPath } = await fixture()
  try {
    await patchUsageBalance(profile)
    const first = await readFile(indexPath, 'utf8')
    await patchUsageBalance(profile)
    assert.equal(await readFile(indexPath, 'utf8'), first)
    const plugin = await import(pathToFileURL(indexPath).href)
    assert.equal(plugin.queryOther({ statusCode: 401 }), 'other-failure')
    const failure = await plugin.queryBalance({ id: 'deepseek' }, { statusCode: 401, body: 'sensitive response' })
    assert.equal(failure.errorCode, 'invalid-api-key')
    assert.doesNotMatch(failure.error, /sensitive/)
    assert.deepEqual(await plugin.queryBalance({ id: 'siliconflow' }, { statusCode: 401 }), { error: 'generic' })
    assert.deepEqual(await plugin.queryBalance({ id: 'deepseek' }, { statusCode: 200 }), { ok: true })
    const client = await readFile(join(root, 'lib/client.js'), 'utf8')
    assert.match(client, /note\.deepseekAccount/)
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '99.0.0' }))
    await assert.rejects(patchUsageBalance(profile), /版本已变化/)
    assert.equal(await readFile(indexPath, 'utf8'), first)
  } finally { await rm(profile, { recursive: true, force: true }) }
})

test('登录令牌不发起官方请求，已登录账号时余额走账号接口；旧版补丁的引入行会被升级', async () => {
  const { profile, root, indexPath } = await fixture()
  try {
    // 先模拟早期补丁留下的引入行，升级后不能出现重复引入。
    await writeFile(indexPath, "import { officialBalanceProfile, officialBalanceFailure } from './dsh-balance-compat.mjs'\n" + INDEX_FIXTURE)
    await patchUsageBalance(profile)
    const source = await readFile(indexPath, 'utf8')
    assert.equal(source.split("from './dsh-balance-compat.mjs'").length, 2)
    const plugin = await import(pathToFileURL(indexPath).href)
    const shape = await plugin.queryBalance({ id: 'deepseek' }, { statusCode: 200 }, '3f6b2c1e-8a4d-4f1b-9c2e-7d5a1b2c3d4e')
    assert.equal(shape.errorCode, 'not-open-platform-key')
    assert.match(shape.error, /sk- 开头/)
    assert.doesNotMatch(shape.error, /3f6b2c1e/)
    assert.equal(shape.credentialName, 'OFFICIAL_KEY')
    plugin.setContext({ get: name => name === 'deepseekAccount' ? {
      getState: async () => ({ status: 'credential-stored' }),
      getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '12.50' }], bonusWallets: [{ currency: 'CNY', balance: '3' }] }),
    } : undefined })
    const viaAccount = await plugin.queryBalance({ id: 'deepseek', name: 'DeepSeek' }, { statusCode: 401 }, 'not-a-key')
    assert.equal(viaAccount.ok, true)
    assert.equal(viaAccount.credentialSource, 'deepseek-account-platform')
    assert.equal(viaAccount.totalBalance, '12.50')
    assert.equal(viaAccount.sourceNoteKey, 'note.deepseekAccount')
    plugin.setContext({ get: name => name === 'deepseekAccount' ? { getState: async () => ({ status: 'signed-out' }), getBalance: async () => null } : undefined })
    assert.equal((await plugin.queryBalance({ id: 'deepseek' }, { statusCode: 200 })).ok, true)
    assert.equal((await plugin.queryBalance({ id: 'deepseek' }, { statusCode: 200 }, 'not-a-key')).errorCode, 'not-open-platform-key')
    assert.doesNotMatch(await readFile(join(root, 'lib/dsh-balance-compat.mjs'), 'utf8'), /^\s*$/)
  } finally { await rm(profile, { recursive: true, force: true }) }
})
