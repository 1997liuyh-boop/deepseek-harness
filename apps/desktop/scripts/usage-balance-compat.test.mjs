/** 官方余额的凭据选择及错误信息回归。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountBalance, isOpenPlatformKey, keyShapeFailure, officialBalanceFailure, officialBalanceProfile } from './usage-balance-compat.mjs'

test('只有 sk- 开头的开放平台密钥通过形态检查，登录令牌和空值不通过', () => {
  assert.equal(isOpenPlatformKey('sk-0123456789abcdefghij'), true)
  assert.equal(isOpenPlatformKey(' sk-0123456789abcdefghij '), true)
  assert.equal(isOpenPlatformKey('sk-live'), true)
  for (const value of ['3f6b2c1e-8a4d-4f1b-9c2e-7d5a1b2c3d4e', 'sk-', 'sk live', '', undefined, null, 42]) assert.equal(isOpenPlatformKey(value), false, String(value))
  const failure = keyShapeFailure()
  assert.equal(failure.errorCode, 'not-open-platform-key')
  assert.match(failure.error, /sk- 开头/); assert.match(failure.error, /设置 → 账号/)
  assert.match(failure.errorEn, /sk- prefix|start with sk-/)
})

test('已登录账号时余额来自账号接口；未登录、无服务或查询失败时退回密钥路径', async () => {
  const provider = { id: 'deepseek', name: 'DeepSeek' }
  const account = (state, balance) => ({ get: name => name === 'deepseekAccount' ? { getState: async () => state, getBalance: async () => balance } : undefined })
  const ready = await accountBalance(account({ status: 'credential-stored' }, { status: 'ready', value: [{ currency: 'USD', balance: '1.5' }, { currency: 'CNY', balance: '20' }], bonusWallets: [] }), provider)
  assert.equal(ready.ok, true); assert.equal(ready.currency, 'CNY'); assert.equal(ready.totalBalance, '20'); assert.equal(ready.infos.length, 2)
  assert.equal(ready.credentialSource, 'deepseek-account-platform'); assert.equal(ready.sourceNoteKey, 'note.deepseekAccount')
  assert.equal(await accountBalance(account({ status: 'signed-out' }, null), provider), null)
  assert.equal(await accountBalance(account({ status: 'credential-stored' }, { status: 'failed' }), provider), null)
  assert.equal(await accountBalance({ get: () => undefined }, provider), null)
  assert.equal(await accountBalance({ get: () => { throw new Error('no service') } }, provider), null)
  assert.equal(await accountBalance(undefined, provider), null)
})

test('默认使用官方密钥引用，忽略第三方同名提供商', async () => {
  const calls = []
  const profile = await officialBalanceProfile({ describe: options => { calls.push(options); return [{ ns: 'llm-deepseek', value: {} }, { ns: 'llm-pi-ai', value: { providers: { deepseek: { apiKeyEnv: 'THIRD_PARTY' } } } }] } })
  assert.deepEqual(calls, [{ redactSecrets: true }])
  assert.equal(profile.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(profile.route, 'deepseek-official')
})

test('官方模型修改凭据引用后立即跟随，不退回旧 Key', async () => {
  const profile = await officialBalanceProfile({ describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'NEW_OFFICIAL_KEY', baseURL: 'https://api.deepseek.com/anthropic' } }] })
  assert.equal(profile.apiKeyEnv, 'NEW_OFFICIAL_KEY')
})

for (const baseURL of ['https://proxy.example/v1', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.example', 'https://user:pass@api.deepseek.com']) {
  test('拒绝非官方余额凭据来源：' + baseURL, async () => {
    await assert.rejects(officialBalanceProfile({ describe: () => [{ ns: 'llm-deepseek', value: { baseURL } }] }), /已停止余额查询/)
  })
}

test('官方模型不存在时停止查询，不回退到旧的通用Key', async () => {
  await assert.rejects(officialBalanceProfile({ describe: () => [] }), /未找到 DeepSeek 官方模型/)
})

test('401明确要求更新Key，不误报成权限问题或反射服务端响应', () => {
  const failure = officialBalanceFailure(401)
  assert.equal(failure.errorCode, 'invalid-api-key')
  assert.match(failure.error, /设置 → 模型 → DeepSeek/)
  assert.match(failure.errorEn, /HTTP 401/)
  assert.doesNotMatch(failure.error, /网络|账单读取权限/)
  assert.equal(officialBalanceFailure(403).errorCode, 'access-denied')
})
