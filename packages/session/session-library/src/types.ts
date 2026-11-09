/** 本机历史库的客户端安全类型，不包含账号凭据。 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 可本地化的历史维护失败原因。 */
export type LibraryFailureReason = 'account' | 'busy' | 'selection' | 'group' | 'missing' | 'backup' | 'conflict' | 'storage'

/** 可恢复的归属迁入记录。 */
export interface LibraryBackup {
  id: string
  createdAt: number
  count: number
  restored: boolean
}

/** 当前账号与本机历史入口的状态。 */
export interface LibraryState {
  mode: 'local' | 'account'
  accountAvailable: boolean
  library: 'local' | 'custom' | null
  backups: LibraryBackup[]
}

/** 用户可以明确选择迁入的未绑定会话。 */
export interface LibraryCandidate {
  sessionId: SessionId
  createdAt: number
  cwd: string
}
