
/** Browser-safe request, result, and lifecycle vocabulary for the Session Remote service. */

import type {} from '@deepseek-ai/dsh-agent/types'
import type { NativeFileApplication } from '@deepseek-ai/dsh-native-command/types'
import type {
  ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { LlmModelBadge, TextBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap, SessionProjectionSummaryExcluded, SessionProjectionSummaryValues } from '@deepseek-ai/dsh-session-projection/types'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { LibraryFailureReason } from '@deepseek-ai/dsh-session-library/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Eligible latest failed turn/end for an empty prompt, or null. */
    conversationContinuation: SessionSeq | null
    /** Persisted facts used to summarize a Session without activating it. */
    sessionListMetadata: SessionListMetadata
    /**
     * Image-intake limits enforced by the Session prompt endpoint. Boot
     * constant, excluded from Session summary payloads: every Session shares
     * it, so a list row would repeat one host-wide fact.
     */
    imageLimits: SessionProjectionSummaryExcluded<ImageAttachmentLimits>
  }
}


/** Persisted hints used to summarize a cold Session. */
export interface SessionListMetadata {

  readonly blank: boolean

  readonly lastPromptAt: number | null
}

/**
 * Summary wire values a Session-list row carries. A `sequenced` block carries
 * every summary key computed at its `asOfSeq`; a `cached` block carries the
 * values the persisted cache holds and may omit keys or trail the Session.
 * The block omits the keys whose unit declares `summary: false`. `kind` and `asOfSeq` are independent facts: `kind` says
 * which sequence space `asOfSeq` belongs to, and therefore how a client may
 * merge the block; `asOfSeq` is the producer's watermark in that space.
 */
export interface SessionProjectionHints {







  readonly kind: 'cached' | 'sequenced'

  readonly asOfSeq: number
  /** Provider-validated summary values present in the block; omitted keys remain unknown. */
  readonly values: Partial<SessionProjectionSummaryValues>
}


/** Complete projection values at an exact Session event cursor. */
export interface SessionProjectionBaseline {
  readonly asOfSeq: number

  readonly values: SessionProjectionValues
}


/** Typed known projections plus JSON-safe values contributed outside this compilation face. */
export type SessionProjectionValues = Partial<SessionProjectionMap>
  & Readonly<Record<string, SessionProjectionValue>>

/**
 * Browser-submitted prompt content; the Host promotes image bytes to durable
 * references. File parts carry the opaque receipt returned by a preceding
 * upload on the same Session; the receipt of an image upload enters the
 * message as that image.
 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }
  | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }


/** Complete model selection for one Session. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One adapter-owned reasoning effort for an exact model route. */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}


/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[]
  readonly defaultEffort?: string
}


/** 单条可路由模型的展示信息、思考选项及已声明的输入能力。 */
export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: ModelReasoning
  /** 模型声明的输入模态（如 text、image）；未声明时为 undefined，表示能力未知。 */
  readonly inputModalities?: readonly string[]
  /** Provider-authored label shown beside the name; display data only. */
  readonly badge?: LlmModelBadge
}


/** One provider and its successfully loaded model catalog. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
}


/** One provider whose model catalog lookup failed. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}


/** Host-generation model catalog and the default used by unconfigured Sessions. */
export interface ModelCatalog {
  readonly default: ModelSelection

  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}


/** One client-requested mutation of a still-pending queue item. */
export type QueueAction =
  | {
    readonly kind: 'edit'

    readonly content: readonly TextBlock[]
  }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }


/** One Session list entry. */
export interface SessionSummary {

  readonly agentAvailable: boolean

  readonly formatStatus?: 'current' | 'migration-required'
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: SessionProjectionHints
}


/** One session-content search result. */
export interface SessionSearchItem {
  readonly sessionId: SessionId
  readonly snippet: string
}


/** Maximum number of Sessions returned by one search. */
export const SESSION_SEARCH_RESULT_LIMIT = 20


/** Maximum search snippet length in Unicode code points. */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session/library-operation-failed': { reason: LibraryFailureReason }
    'session/routing-unavailable': Record<string, never>
    'session/library-unavailable': Record<string, never>
    /** A wait observation ended before a stopping state; the caller should reread. */
    'session/observation-ended': Record<string, never>
    /** No state arrived before the deadline; a timeout after a state returns its value instead. */
    'session/wait-timeout': Record<string, never>
    'session/provider-credentials-unavailable': Record<string, never>
    'session/provider-models-unavailable': { readonly provider: string }
    'session/model-unavailable': { readonly provider: string; readonly model: string }
    'session/conflict': {
      readonly sessionId: SessionId
      readonly requestedCwd: string
      readonly existingCwd?: string
    }
    'session/projections-unavailable': Record<string, never>
    'session/writer-held': { readonly sessionId: SessionId }
    'session/agent-busy': { readonly reason: string }
    'session/invalid-time-zone': { readonly value: string }
    'session/workspace-attach-failed': { readonly sessionId: SessionId; readonly workspaceId: string }
    'agent-preset/conflict': {
      readonly sessionId: SessionId
      readonly requestedPreset: string
    }
    'session/attachment-invalid': { readonly reason: string }
    'session/queue-item-not-found': { readonly itemId: MessageId }
    'session/steer-unavailable': { readonly itemId: MessageId }
    'session/title-invalid': { readonly sessionId: SessionId }
    'session/fork-unavailable': { readonly sessionId: SessionId }
    'session/migration-required': { readonly sessionId: SessionId }
    'subagent/not-found': {
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
    }
    'subagent/catalog-diagnostic': {
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
      readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    }
  }
}


/** Session-addressed request for the human-invocable skill catalog. */
export interface SkillListRequest {
  readonly sessionId: SessionId
}


/** One skill available to the Session's human-facing composer. */
export interface SkillEntry {

  readonly path?: string

  readonly name: string

  readonly description: string

  readonly whenToUse?: string

  readonly modelInvocable: boolean
}


/** Human-invocable skills visible through one Session's composition. */
export interface SkillListValue {
  readonly skills: readonly SkillEntry[]
}


/** Session list request. */
export interface SessionListRequest {
  readonly cursor?: string
}


/** Session list response value. */
export interface SessionListValue {
  readonly items: readonly SessionSummary[]
}


/** Session search request. */
export interface SessionSearchRequest {
  readonly query: string
}


/** Session search response value. */
export interface SessionSearchValue {
  readonly items: readonly SessionSearchItem[]
  readonly hasMore: boolean
}


/** Request for a Session for a new conversation. */
export interface SessionCreateRequest {

  readonly workspaceId?: WorkspaceId

  readonly cwd?: string

  readonly sessionId?: SessionId

  readonly agentPreset?: string
}


/** Session creation response value. */
export interface SessionCreateValue {

  readonly sessionId: SessionId

  readonly agentPreset?: string
}


/** 指定会话的模型选择及可选思考程度的切换请求。 */
export interface SessionSelectModelRequest extends ModelSelection {
  /** 是否同时保存为全局默认模型；悬浮球会话使用 false。 */
  readonly saveAsDefault?: boolean
  readonly sessionId: SessionId
}


/** Accepted model selection after Host resolution. */
export interface SessionSelectModelValue {
  readonly selected: ModelSelection
}


/** Session rename request. */
export interface SessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}


/** Normalized title and the durable event position that committed it. */
export interface SessionRenameValue {
  readonly title: string
  readonly seq: number
}


/** 按指定日志前缀创建会话副本的请求，可明确授权迁移或生成可读历史。 */
export interface SessionForkRequest {
  readonly sessionId: SessionId

  readonly atSeq?: number

  readonly allowMigration?: boolean
  /** 明确创建可读副本：副本移除原生回放签名和没有正文的推理块，原件保留。 */
  readonly readableHistory?: boolean
}


/** Identity of a newly forked Session. */
export interface SessionForkValue {
  readonly sessionId: SessionId
}


/** Session prompt request. */
export interface SessionPromptRequest {
  /** Client-minted identity persisted on the accepted inbox input, including empty continuation. */
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  /** Non-whitespace text or attachments; an empty array continues an eligible failed idle Session. */
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}


/** Receipt after one prompt enters the target Agent inbox. */
export interface SessionPromptValue {
  readonly accepted: true
}


/** Durable image read request. */
export interface SessionAttachmentRequest {
  /** Gateway permission scope only; neither Session existence nor its image references are checked. */
  readonly sessionId: SessionId
  readonly attachment: ImageAttachmentRef
}


/** Durable image read response value. */
export interface SessionAttachmentValue {
  /** Supplied reference after ID, format, byte length, and dimensions verification; display fields are preserved. */
  readonly attachment: ImageAttachmentRef
  readonly data: string
}


/** Pending queue mutation request. */
export interface SessionUpdateQueueRequest {
  readonly sessionId: SessionId
  readonly itemId: MessageId
  readonly action: QueueAction
}


/** Receipt after one pending queue mutation commits. */
export interface SessionUpdateQueueValue {
  readonly accepted: true
}


/** Active-turn cancellation request. */
export interface SessionCancelRequest {
  readonly sessionId: SessionId
}


/** Receipt after cancellation is admitted to the live Agent. */
export interface SessionCancelValue {
  readonly accepted: true
}


/** Request to open one path prepared by a Session-aware caller on the Host desktop. */
export interface SessionOpenWorkspacePathRequest {

  readonly action?: 'reveal'

  readonly application?: string

  readonly path: string
}


/** Confirmation that the Host handed a workspace path to its native opener. */
export interface SessionOpenWorkspacePathValue {
  readonly opened: true
}


/** Client-minted prompt identity used to reconcile optimistic and durable messages. */
export type SessionRequestId = Branded<'session-request-id'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {





    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal }
    /** Empty retry user message with browser prompt correlation and caller metadata. */
    'retry-rpc': { kind: 'retry'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal }
  }
}


/** Durable identity selecting an ordinary Session or one direct subagent child. */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly mode: 'one-shot' | 'continuable' | 'unknown'
  }


/** One non-activating Session projection read. */
export interface SessionProjectionsRequest {
  readonly sessionId: SessionId
}


/** Exact projections carry their event cut; required migration returns sequence-free cache hints. Null means absent. */
export type SessionProjectionsValue =
  | (SessionProjectionBaseline & { readonly kind: 'sequenced' })
  | { readonly kind: 'migration-required'; readonly values: SessionProjectionValues }
  | null


/** One raw Session event in the Remote journal. */
export interface SessionEventEntry {
  readonly type: 'event'
  readonly event: SessionWireEvent
}


/** Current logical Session metadata carried on the browser wire. */
export interface SessionWireHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId

  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}


/** Browser wire surface operation; replacement endpoints are earlier event seqs in surface order. */
export type SessionWireSurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }


/** One history-page record with compact Assistant streams embedded inside events. */
export type SessionHistoryRecord = SessionEventEntry






/**
 * Exact Session event envelope accepted by the Client journal adapter.
 * Surface events require surfaceOp; only non-Assistant surface events may cite earlier sources.
 * Durable readers own recognition of merge-extensible event names.
 */
export interface SessionWireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly ignorable?: true

  readonly sourceEventSeqs?: JsonValue

  readonly surfaceOp?: JsonValue
}


/** One message-aligned backwards-history request. */
export interface SessionPageRequest {
  readonly address: SessionAddress
  /**
   * Inclusive log cut; omission selects the observed log end. A follow opening
   * reports the cut it covered so a caller can pin the same point.
   */
  readonly throughSeq?: number
  readonly beforeSeq?: number
  readonly maxMessages?: number

  readonly turnWindow?: {

    readonly minMessages: number

    readonly minTurns: number
  }
}


/** One live event request for a durable Session address. */
export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
  readonly address: SessionAddress
  /** Request background activation; omission leaves the read passive. */
  readonly activate?: boolean
  /** Include process-local assistant presentation frames for the Web client. */
  readonly assistantStream?: true
}


/** One active assistant attempt in a reconnect opening snapshot. */
export interface SessionAssistantStreamAttempt {
  readonly attemptId: LlmAttemptId

  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number

  readonly nextIndex: number

  readonly stream: readonly JsonValue[]
}


/** Complete process-local assistant state at one follow opening. */
export interface SessionAssistantStreamBaseline {
  readonly revision: number
  readonly activeAttempt?: SessionAssistantStreamAttempt
}


/** Browser wire form of one process-local assistant frame. */
export type SessionAssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly startedAfterSeq: SessionSeqCursor
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: JsonValue
  }
  | {
    readonly type: 'end'
    readonly attemptId: LlmAttemptId
    readonly revision: number

    readonly index: number
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
      | { readonly kind: 'abandoned' }
  }


/** One contiguous backwards page of a Session log. */
export interface SessionPage {
  readonly records: readonly SessionHistoryRecord[]
  readonly hasMore: boolean
}


/** Complete opening window followed by ordered durable events and opted-in assistant frames. */
export type SessionFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly header: SessionWireHeader
    readonly cursor: number
    readonly records: readonly SessionHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: SessionProjectionBaseline
    readonly assistantStream?: SessionAssistantStreamBaseline
  }
  | SessionEventEntry
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }


/** Complete live control baseline emitted once per control stream generation. */
export interface SessionControlBaseline {
  readonly projections: Readonly<Record<SessionId, SessionProjectionBaseline>>
}

/**
 * Projection changes caused by one committed Session event; the Host emits one
 * update per event that changed at least one client-visible projection view.
 */
export interface SessionProjectionUpdate {
  readonly sessionId: SessionId
  /** Seq of the committed event that caused every listed change. */
  readonly seq: number
  /**
   * One entry per client-visible key whose view the event changed, in
   * registration order without duplicate keys, with the key's new value as
   * `val`. A key absent from `changes` is unchanged; unlike a baseline, absence
   * does not mean an absent capability.
   */
  readonly changes: readonly { readonly key: string; readonly val: SessionProjectionValue }[]
}


/** Host-wide live state stream. Each generation starts with exactly one baseline. */
export type SessionControlFrame =
  | { readonly type: 'baseline'; readonly value: SessionControlBaseline }
  | ({ readonly type: 'projection' } & SessionProjectionUpdate)

/** One pending live-Agent inbox item, preserving placement and content order. */
export interface SessionQueuedItem {
  readonly id: MessageId
  readonly placement: 'queued' | 'steering' | 'context'
  readonly rpcId?: SessionRequestId
  readonly content: readonly JsonValue[]
}

/** State-owned classification of pending forwarded Remote events. */
export type SessionPendingInput = 'approval' | 'question' | 'other'

/** Passive Session state; a missing live Agent has no readable queue. */
export interface SessionState {
  readonly cursor: number
  readonly active: boolean
  readonly running: boolean
  readonly queue: readonly SessionQueuedItem[] | null
  /**
   * Pending Remote requests sampled when this state was read. A pending change alone does not
   * trigger `observeState`; `wait` refreshes on its own interval.
   */
  readonly pendingInput: readonly SessionPendingInput[]
}

/** Session identity for a passive state read or subscription. */
export interface SessionStateRequest {
  readonly sessionId: SessionId
}

/** Wait bounds and assistant output window; timeout omission uses the fixed 30-second default. */
export interface SessionWaitRequest extends SessionStateRequest {
  readonly timeoutMs?: number
  /** Exclusive output cursor; omission includes all available assistant records. */
  readonly afterSeq?: number
  /** Positive assistant-record limit; omission uses the history message budget. */
  readonly maxMessages?: number
}

/** Assistant messages after afterSeq through the stopping state's cursor, newest first. */
export interface SessionWaitOutput {
  readonly records: readonly SessionHistoryRecord[]
  /** More eligible assistant messages exist in the selected interval. */
  readonly truncated: boolean
}

/** A stopping condition, the last complete passive state and its bounded assistant output. */
export interface SessionWaitValue {
  readonly reason: 'idle' | 'input-required' | 'timeout'
  readonly state: SessionState
  readonly output: SessionWaitOutput
}

/**
 * One `session.events` page (or its deprecated `page` alias) with its inclusive cut:
 * the supplied `throughSeq`, otherwise the log end it was read at.
 */
export interface SessionEventsPage extends SessionPage {
  readonly cursor: number
}

/** Address for a passive event subscription. */
export interface SessionObserveEventRequest {
  readonly address: SessionAddress
}

/** Readiness confirms subscription only; event continuity starts with the first delivered event. */
export type SessionEventFrame =
  | { readonly type: 'ready' }
  | SessionEventEntry

/** Projection changes caused by one committed event of the observed Session. */
export type SessionProjectionChange = { readonly type: 'projection' } & Omit<SessionProjectionUpdate, 'sessionId'>

/** Subscription readiness without a baseline, followed by one change frame per committed event. */
export type SessionProjectionFrame =
  | { readonly type: 'ready' }
  | SessionProjectionChange

declare module '@deepseek-ai/cordis' {
  interface Events {






    /**
     * 会话变为可见，或其 Agent 创建、释放后，发布当前列表摘要供消费者更新。
     * @mode emit
     * @param summary - 会话当前的运行与可用状态摘要。
     */
    'api-session/added'(summary: SessionSummary): void





    /**
     * 会话离开当前 Host 的活动注册表。
     * @mode emit
     * @param sessionId - 被移除的会话身份。
     */
    'api-session/removed'(sessionId: SessionId): void






    /**
     * 一个 Agent 的运行状态发生变化。
     * @mode emit
     * @param sessionId - Agent 所属的会话身份。
     * @param running - Agent 当前是否正在运行。
     */
    'api-session/status'(sessionId: SessionId, running: boolean): void






    /**
     * 用户编写的持久化消息推进了会话列表的活动时间。
     * @mode emit
     * @param sessionId - 活动时间发生变化的会话身份。
     * @param updatedAt - 用于列表排序的持久化消息时间。
     */
    'api-session/activity'(sessionId: SessionId, updatedAt: number): void






    /**
     * 一个 Agent 在没有持久化轮次位置的情况下报告失败。
     * @mode emit
     * @param sessionId - Agent 所属的会话身份。
     * @param message - 可向用户展示的失败原因链。
     */
    'api-session/error'(sessionId: SessionId, message: string): void
  }
}


/** JSON-compatible projection value accepted by list consumers. */
export type SessionProjectionValue = JsonValue


/** Application metadata returned by the serving desktop for one file. */
export type SessionWorkspacePathApplication = NativeFileApplication
