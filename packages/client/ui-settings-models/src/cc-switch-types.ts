/** CC Switch 导入的脱敏预览与提交结果；原始凭据仅留在 Host。 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** 一次 Host 扫描的临时标识，不作为凭据保存。 */
export type ImportScanToken = Branded<'CcSwitchImportScan'>
/** 同次扫描中的供应商来源标识。 */
export type ImportCandidateId = Branded<'CcSwitchImportCandidate'>

/** 一条不含凭据原文的供应商预览。 */
export interface ImportCandidate {
  id: ImportCandidateId
  app: string
  name: string
  providerId: string
  baseURL: string
  api: string
  models: string[]
  hasCredential: boolean
  status: 'ready' | 'incomplete' | 'unsupported' | 'existing'
}

/** 一次有时限、可核对来源变动的预览。 */
export interface ImportScan {
  token: ImportScanToken
  directory: string
  candidates: ImportCandidate[]
  protocols: string[]
}

/** 用户允许导入的字段，不接收来源脚本或任意设置路径。 */
export interface ImportSelection {
  id: ImportCandidateId
  providerId: string
  baseURL: string
  api: string
  /** 空数组表示导入时查询供应商，非空数组按此列表导入。 */
  models: string[]
  apiKey?: string | undefined
}

/** 每条记录独立提交，成功项在后续重试中保留。 */
export interface ImportResult {
  id: ImportCandidateId
  providerId: string
  status: 'imported' | 'existing' | 'failed'
  reason: string
}
