/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
  /** 本机供应商导入的输入限制和预览有效期。 */
  ccSwitchImport: {
    /** 单次扫描允许读取的供应商数量上限。 */
    maxProviders: number
    /** 单个配置文件允许读取的字节数上限。 */
    maxConfigBytes: number
    /** 导入预览的有效期，单位为毫秒。 */
    scanTtlMs: number
    /** 导入时查询供应商模型列表的超时，单位为毫秒。 */
    modelQueryTimeoutMs: number
  }
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  credentialOnboarding: z.boolean().default(true),
  ccSwitchImport: z.object({
    maxProviders: z.natural().min(1).max(10000).default(1000),
    maxConfigBytes: z.natural().min(1024).default(2000000),
    scanTtlMs: z.natural().min(1000).max(3600000).default(300000),
    modelQueryTimeoutMs: z.natural().min(1000).max(120000).default(15000),
  }).default({}),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'
