/** CC Switch 导入界面的语言字典。 */
export const en = {
  title: 'Import from CC Switch', hint: 'Read local providers, select what to import, then use them in direct or aggregate mode. Your default model stays unchanged.',
  open: 'Choose providers', directory: 'CC Switch data directory', automatic: 'Automatically locate .cc-switch', browse: 'Choose folder', read: 'Read configuration',
  all: 'All applications', select: 'Select', selected: 'Import selected', close: 'Close', busy: 'Working…', empty: 'No providers found',
  provider: 'Provider ID', endpoint: 'API endpoint', protocol: 'Protocol', models: 'Models (one per line)', key: 'API key (optional replacement)', discover: 'Query models',
  ready: 'Ready', incomplete: 'Complete required fields', unsupported: 'Unsupported configuration or login type', existing: 'Already configured', imported: 'Imported', failed: 'Not imported',
  modelHint: 'Models follow this CC Switch snapshot. Leave blank to query the provider during import; conversations can then follow the system routing policy.',
  automaticModels: 'Automatically query the provider', summary: '{imported} imported · {existing} already configured · {failed} failed',
  credentialFound: 'Credential detected', credentialMissing: 'Credential missing', details: 'Review configuration', success: 'Import results', selectAll: 'Select compatible providers',
  readError: 'Cannot read CC Switch. Check the directory and database, then retry.', expired: 'This preview expired. Read the configuration again.',
  changed: 'The source changed. Read it again before importing.', conflict: 'The dsh settings changed. Read the configuration again.',
  selection: 'Check the provider ID, endpoint, protocol and models.', credential: 'Add an API key before importing.', duplicate: 'This Provider ID is already in use.',
  write: 'Save failed. Your existing providers were kept; retry this item.', cleanup: 'Save failed and an unused credential could not be removed. Check local credentials before retrying.',
  unavailable: 'The model settings or credential service is unavailable.', limit: 'Too many providers. Increase the configured scan limit.', format: 'This database format is unsupported.',
  queryError: 'Could not query models. Check the endpoint and protocol, or enter model IDs manually.', unknown: 'The operation could not be confirmed. Read the configuration again before retrying.',
} as const
/** 导入界面的可用翻译键。 */
export type ImportKey = keyof typeof en
/** 导入界面的中文文本，与英文键一一对应。 */
export const zh: Record<ImportKey, string> = {
  title: '从 CC Switch 导入', hint: '读取本机供应商，勾选后导入，即可用于直连或聚合模式；当前默认模型保持不变',
  open: '选择要导入的供应商', directory: 'CC Switch 数据目录', automatic: '自动定位 .cc-switch', browse: '选择文件夹', read: '读取配置',
  all: '全部应用', select: '选择', selected: '导入所选', close: '关闭', busy: '正在处理…', empty: '没有找到供应商',
  provider: 'Provider ID', endpoint: '接口地址', protocol: '协议', models: '模型（每行一个）', key: 'API Key（可选，替换来源凭据）', discover: '查询模型',
  ready: '可导入', incomplete: '需要补全', unsupported: '暂不支持的配置或登录类型', existing: '已配置', imported: '已导入', failed: '未导入',
  modelHint: '模型沿用本次 CC Switch 配置；留空会在导入时自动查询供应商。导入后，会话可选择“跟随系统”使用路由策略',
  automaticModels: '留空自动查询供应商模型', summary: '已导入 {imported} 项 · 已配置 {existing} 项 · 失败 {failed} 项',
  credentialFound: '已检测到凭据', credentialMissing: '缺少凭据', details: '检查与补全', success: '导入结果', selectAll: '勾选兼容项',
  readError: '无法读取 CC Switch，请检查目录和数据库后重试', expired: '本次预览已过期，请重新读取配置', changed: '来源配置已变化，请重新读取后导入', conflict: 'dsh 配置已变化，请重新读取后导入',
  selection: '请检查供应商标识、接口、协议和模型', credential: '请补充 API Key 后导入', duplicate: '该 Provider ID 已被使用',
  write: '保存失败，已有供应商已保留，可重试此项', cleanup: '保存失败且未能清理闲置凭据，请检查本机凭据后重试', unavailable: '模型设置或凭据服务暂不可用', limit: '供应商数量超出配置的读取上限', format: '暂不支持此数据库格式',
  queryError: '模型查询失败，请检查接口与协议，或手动填写模型标识', unknown: '暂时无法确认操作结果，请重新读取后检查，避免重复提交',
}
