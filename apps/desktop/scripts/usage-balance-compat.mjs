/** 官方余额查询仅复用官方模型的凭据，不读取网页登录令牌或同名第三方供应商。 */

/** @param {object} settings 宿主设置服务。 @returns {Promise<object>} 官方模型的凭据引用和端点。 */
export async function officialBalanceProfile(settings) {
  const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-deepseek')
  if (!descriptor) throw new Error('未找到 DeepSeek 官方模型配置，请先在“设置 → 模型”启用官方模型。')
  const profile = descriptor.value
  const baseURL = profile?.baseURL || 'https://api.deepseek.com'
  const url = new URL(baseURL)
  if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port || url.username || url.password) {
    throw new Error('DeepSeek 官方模型配置了非官方端点，已停止余额查询。请检查“设置 → 模型 → DeepSeek”。')
  }
  const apiKeyEnv = profile?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  if (typeof apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error('DeepSeek 官方模型的 API Key 引用无效，请在“设置 → 模型 → DeepSeek”中重新保存。')
  }
  return { route: 'deepseek-official', apiKeyEnv, baseURL }
}

/** 开放平台密钥形态：sk- 前缀加字母数字；只区分形态，不限定长度。网页登录令牌是 UUID 形，拿它请求 api.deepseek.com 只会得到 401。 @param {unknown} value 已保存的凭据值。 @returns {boolean} */
export function isOpenPlatformKey(value) {
  return typeof value === 'string' && /^sk-[A-Za-z0-9_-]+$/.test(value.trim())
}

/** @returns {object} 已保存的值不是开放平台密钥时的中英文错误，不回显密钥。 */
export function keyShapeFailure() {
  return {
    errorCode: 'not-open-platform-key',
    error: '已保存的 DeepSeek 密钥不是开放平台 API Key（应以 sk- 开头），看起来是网页登录令牌，未向官方接口发起请求。请到 platform.deepseek.com → API keys 创建密钥，并在“设置 → 模型 → DeepSeek”保存；网页登录的账号余额请看“设置 → 账号”。',
    errorEn: 'The saved DeepSeek key is not an Open Platform API key (they start with sk-); it looks like a browser sign-in token, so no request was sent. Create a key at platform.deepseek.com → API keys and save it in Settings → Models → DeepSeek. Account balance for browser sign-in is under Settings → Account.',
  }
}

/**
 * 已登录 DeepSeek 账号时改用账号接口查余额（x-dsh-auth-token），不依赖开放平台密钥。
 * @param {object} ctx 插件上下文。 @param {object} provider 余额供应商描述（id、name）。
 * @returns {Promise<object|null>} 账号余额结果；未登录、账号服务缺失或查询失败时返回 null，由密钥路径继续。
 */
export async function accountBalance(ctx, provider) {
  let account
  try { account = ctx && typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined }
  catch (error) { return null }
  if (!account || typeof account.getState !== 'function' || typeof account.getBalance !== 'function') return null
  try {
    const state = await account.getState()
    if (!state || state.status !== 'credential-stored') return null
    const balance = await account.getBalance({ version: 'dsh-usage-plugin', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 })
    if (!balance || balance.status !== 'ready' || !Array.isArray(balance.value) || balance.value.length === 0) return null
    const wallets = balance.value.map(wallet => ({ currency: String(wallet.currency || 'CNY'), totalBalance: String(wallet.balance ?? '0'), grantedBalance: '0', toppedUpBalance: String(wallet.balance ?? '0') }))
    const bonus = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
    const primary = wallets.find(wallet => wallet.currency === 'CNY') || wallets[0]
    return {
      ok: true, provider: provider.id, providerName: provider.name, queriedAt: Date.now(),
      currency: primary.currency, isAvailable: null, totalBalance: primary.totalBalance, infos: wallets,
      details: [
        ...wallets.map(wallet => ({ labelKey: 'toppedUp', value: wallet.totalBalance, hintKey: 'actualTopUp' })),
        ...bonus.map(wallet => ({ labelKey: 'granted', value: String(wallet.balance ?? '0'), hintKey: 'platformGift' })),
      ],
      sourceNoteKey: 'note.deepseekAccount', credentialName: 'DeepSeek 账号登录', credentialSource: 'deepseek-account-platform', modelProviderRoute: 'deepseek-account',
    }
  } catch (error) { return null }
}

/** @param {number} status 官方 HTTP 状态。 @returns {object} 不回显服务端正文或密钥的中英文错误。 */
export function officialBalanceFailure(status) {
  if (status === 401) return {
    errorCode: 'invalid-api-key',
    error: 'DeepSeek 官方接口拒绝了已保存的 API Key（HTTP 401）。请在“设置 → 模型 → DeepSeek”更新开放平台 API Key（sk- 开头）后重试；若粘贴的是网页登录令牌，请改用开放平台密钥，登录账号的余额在“设置 → 账号”查看。',
    errorEn: 'DeepSeek rejected the saved API key (HTTP 401). Update the Open Platform API key (sk- prefix) in Settings → Models → DeepSeek and retry; if you pasted a browser sign-in token, use an Open Platform key instead. Account balance for browser sign-in is under Settings → Account.',
  }
  return {
    errorCode: 'access-denied',
    error: 'DeepSeek 官方接口拒绝访问（HTTP 403）。请先在开放平台确认密钥和账号状态；网页登录成功不代表 API Key 有效。',
    errorEn: 'DeepSeek denied access (HTTP 403). Check the key and account status in the Open Platform. A successful browser sign-in does not validate an API key.',
  }
}
