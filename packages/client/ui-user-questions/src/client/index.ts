











import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InboxWireState } from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type { AskUserQuestionItem, PendingUserQuestion, UserQuestionProjectionView } from '@deepseek-ai/dsh-user-questions/types'

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { UserQuestionPanels, UserQuestionRecord } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createWaterfallRequest, PendingQuestion, type QuestionRpcChannel } from './contract/slots.ts'
import { createQuestionDraftStore } from './draft-store.ts'
import { QuestionComposer } from './QuestionComposer.tsx'
import { answeredQuestionDefinition, questionReplyDefinition } from './question-reply.ts'
import { QuestionReplyView } from './QuestionReplyView.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type QuestionKey } from './locales.ts'

export type {
  PendingQuestion, PlanReview, QuestionAnswer, QuestionComposerProps, QuestionWait,
} from './contract/slots.ts'
export type { QuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {

    question: QuestionKey
  }
}


const NS = 'question'

type QuestionListener = TypertClientEventListener<'user-questions/request'>
type ClientQuestionRequest = Parameters<QuestionListener>[0]
type ClientQuestionNext = Parameters<QuestionListener>[1]
type ClientQuestionAnswer = Awaited<ReturnType<QuestionListener>>


export const inject = ['sessions', 'remote', 'remote.userQuestions', 'uiSession', 'slots', 'locale', 'uiConversation']


interface QuestionCard {
  readonly pending: PendingQuestion

  readonly hide: () => void

  readonly reveal: () => void

  readonly remove: () => void

  readonly trackRequest: (completion: Promise<void>) => () => void

  readonly hasRequest: () => boolean
}










class QuestionCards {
  readonly #cards = new Map<string, QuestionCard>()

  constructor(private readonly publish: PendingInteractionPublisher<PendingQuestion>) {}

  byCallId(sessionId: SessionId, callId: string): QuestionCard | undefined {
    return this.#cards.get(PendingQuestion.keyOf(sessionId, callId))
  }


  source(key: string): PendingQuestion | undefined {
    return this.#cards.get(key)?.pending
  }

  values(): readonly QuestionCard[] {
    return [...this.#cards.values()]
  }


  keysFor(sessionId: SessionId): readonly string[] {
    return this.values().filter(card => card.pending.sessionId === sessionId).map(card => card.pending.key)
  }





  ensure(sessionId: SessionId, questions: readonly AskUserQuestionItem[], callId: ToolCallId | undefined): QuestionCard {
    if (callId !== undefined) {
      const existing = this.byCallId(sessionId, callId)
      if (existing !== undefined) return existing
    }
    return this.#create(new PendingQuestion(sessionId, questions, callId, () => this.keysFor(sessionId)))
  }


  #create(pending: PendingQuestion): QuestionCard {
    const requests = new Set<Promise<void>>()
    const delegate = async (): Promise<void> => {
      pending.delegate()
      await Promise.all(requests)
    }


    let unpublish: (() => void) | undefined = this.publish(pending, delegate)
    const card: QuestionCard = {
      pending,
      hide: () => {
        unpublish?.()
        unpublish = undefined
      },
      reveal: () => {
        unpublish?.()
        unpublish = this.publish(pending, delegate)
      },
      remove: () => {
        /* v8 ignore next -- a card leaves the registry once; no caller holds a card the registry already replaced. */
        if (this.#cards.get(pending.key) !== card) return
        this.#cards.delete(pending.key)
        pending.close()
        unpublish?.()
        unpublish = undefined
      },
      trackRequest: (completion) => {
        requests.add(completion)
        return () => { requests.delete(completion) }
      },
      hasRequest: () => requests.size > 0,
    }


    pending.attachSeat({ hide: pending.review === undefined ? card.hide : card.remove })
    this.#cards.set(pending.key, card)
    return card
  }








  reveal(sessionId: SessionId, callId: string): boolean {
    const card = this.byCallId(sessionId, callId)
    if (card === undefined) return false
    card.reveal()
    return true
  }











  review(sessionId: SessionId, callId: string, record: UserQuestionRecord): boolean {
    const card = this.byCallId(sessionId, callId) ?? this.#create(new PendingQuestion(
      sessionId,
      record.questions,
      brandString<ToolCallId>(callId),
      () => this.keysFor(sessionId),
      record.answers,
    ))
    card.reveal()
    return true
  }






  dispose(): void {
    for (const card of this.values()) {
      card.pending.delegate()
      card.remove()
    }
  }
}


async function answerQuestion(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientQuestionRequest,
  next: ClientQuestionNext,
  cards: QuestionCards,
): Promise<ClientQuestionAnswer> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
  const callId = request.wait?.callId
  const card = cards.ensure(sessionId, request.questions, callId)
  const claimLifetime = new AbortController()
  const claimSignal = request.signal === undefined ? claimLifetime.signal
    : AbortSignal.any([claimLifetime.signal, request.signal])
  let claim: ReturnType<typeof ctx.remote.userQuestions.attachWait> | undefined
  let claimEnded: Promise<never> | undefined
  let delegateRequest: (() => void) | undefined
  const releaseClaim = request.wait?.timed === true && callId !== undefined
    ? ctx.effect(() => {
      claim = ctx.remote.userQuestions.attachWait(sessionId, callId, claimSignal)
      return async () => {
        delegateRequest?.()
        claimLifetime.abort()
        claim?.dispose()
        if (claimEnded !== undefined) await Promise.allSettled([claimEnded])
      }
    }, 'ui-user-questions: foreground claim')
    : undefined
  const completed = Promise.withResolvers<void>()
  const finishRequest = card.trackRequest(completed.promise)
  try {
    const iterator = claim?.[Symbol.asyncIterator]()
    const opening = iterator === undefined ? undefined : await iterator.next()
    if (opening?.done === true) return await next()
    const waterfall = createWaterfallRequest(
      opening === undefined ? undefined : Date.now() + opening.value.remainingMs,
      claimSignal,
      (channel) => { card.pending.detachWaterfall(channel) },
    )


    if (claimSignal.aborted) return await waterfall.result
    delegateRequest = () => { waterfall.channel.delegate() }
    card.pending.attachWaterfall(waterfall.channel)
    if (iterator !== undefined) {
      claimEnded = (async () => {
        await iterator.next()
        throw new Error('the foreground question wait ended')
      })()
    }
    try {
      return await (claimEnded === undefined ? waterfall.result : Promise.race([waterfall.result, claimEnded]))
    } catch (error) {
      if (waterfall.isDelegation(error)) {
        await releaseClaim?.()
        return await next()
      }
      throw error
    }
  } finally {
    if (releaseClaim === undefined) claimLifetime.abort()
    else if (claimEnded === undefined) await releaseClaim()
    else {


      void Promise.allSettled([claimEnded]).then(() => { void releaseClaim() })
    }

    if (callId === undefined) card.remove()
    completed.resolve()
    finishRequest()
  }
}





function publishContinuedQuestions(ctx: ClientContext, cards: QuestionCards): () => void {
  const sessions = ctx.sessions
  const stopProjections = new Map<SessionId, () => void>()

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const rpcFor = (sessionId: SessionId, callId: ToolCallId): QuestionRpcChannel => ({
    answer: async answer => unwrap(await ctx.remote.userQuestions.answer(sessionId, callId, answer)),
  })

  const reconcile = (): void => {
    const snapshot = sessions.list.getSnapshot()
    const bound = new Map(Object.values(snapshot.byId).flatMap((summary) => {
      const binding = sessions.binding(summary.id)
      return binding === undefined ? [] : [[summary.id, binding] as const]
    }))
    for (const [sessionId, stop] of stopProjections) {
      if (bound.has(sessionId)) continue
      stop()
      stopProjections.delete(sessionId)
    }
    for (const [sessionId, binding] of bound) {
      if (stopProjections.has(sessionId)) continue
      const stopQuestions = binding.session.projections.faceOf('userQuestions').subscribe(reconcile)
      const stopInbox = binding.session.projections.faceOf('inbox').subscribe(reconcile)
      stopProjections.set(sessionId, () => { stopQuestions(); stopInbox() })
    }
    const rows = new Map<string, { sessionId: SessionId; row: PendingUserQuestion }>()
    for (const [sessionId, binding] of bound) {
      const projected = binding.session.projections.faceOf('userQuestions').getSnapshot() as
        UserQuestionProjectionView | undefined
      const inbox = binding.session.projections.faceOf('inbox').getSnapshot() as InboxWireState | undefined
      const queued = new Set<string>()
      for (const message of [...(inbox?.['next-step'] ?? []), ...(inbox?.['next-turn'] ?? [])]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        const source = message.source
        if (typeof source !== 'object' || source === null || Array.isArray(source)) continue
        if (source.kind === 'user-question-reply' && typeof source.callId === 'string') queued.add(source.callId)
      }
      for (const row of projected?.active ?? []) {
        if (row.state === 'continued' && queued.has(row.callId)) continue
        rows.set(PendingQuestion.keyOf(sessionId, row.callId), { sessionId, row })
      }
    }
    for (const { sessionId, row } of rows.values()) {
      if (row.state === 'continued') {
        const card = cards.ensure(sessionId, row.questions, row.callId)
        card.pending.attachRpc(rpcFor(sessionId, row.callId))
        card.pending.setState('continued')
        continue
      }
      cards.byCallId(sessionId, row.callId)?.pending.setState('open')
    }
    for (const card of cards.values()) {

      if (card.pending.callId === undefined
        || card.pending.review !== undefined
        || rows.has(card.pending.key)
        || card.hasRequest()
        || card.pending.hasWaterfall()) continue
      card.remove()
    }
  }

  reconcile()
  const stopList = sessions.list.subscribe(reconcile)
  return () => {
    stopList()
    for (const stop of stopProjections.values()) stop()
    stopProjections.clear()
  }
}








export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-user-questions: dictionaries')
  const questionDraftStore = createQuestionDraftStore()
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingQuestion>(
    pending => pending.kind === 'plan-review' ? 2 : 1,
  )
  const cards = new QuestionCards(registerPendingInteraction)
  ctx.effect(() => () => { cards.dispose() }, 'ui-user-questions: cards')
  const disposePanels = ctx.reflect.provide('userQuestionPanels', {
    reveal: (sessionId, callId) => cards.reveal(sessionId, callId),
    review: (sessionId, callId, record) => cards.review(sessionId, callId, record),
  } satisfies UserQuestionPanels)
  ctx.effect(() => disposePanels, 'ui-user-questions: answer panels')
  ctx.effect(() => publishContinuedQuestions(ctx, cards), 'ui-user-questions: continued questions')
  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      select: ({ pendingInteraction }: ComposerChainProps): PendingQuestion | null =>
        pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
      locale: NS,
      store: questionDraftStore,
      inject: () => ({ keyedHooks: { questionCard: (key: string) => cards.source(key) } }),
      children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
    },
    QuestionComposer,
  ))
  ctx.uiConversation.events.register(questionReplyDefinition)
  ctx.uiConversation.events.register(answeredQuestionDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'question-reply',
    locale: NS,
  }, QuestionReplyView))
  ctx.remote.$on('user-questions/request', function (request, next) {
    if (ctx.sessions.surface === 'overlay') return next()
    return answerQuestion(ctx, this, request, next, cards)
  })
}
