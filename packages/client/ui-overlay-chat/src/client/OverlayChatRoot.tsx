
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import css from './OverlayChatRoot.module.css'


export type OverlayChatRootProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation.view' | 'conversation.input.overlay'>

function ignoreView(_view: string, _focus: string): void {}

function ignoreRequest(): void {}






export function OverlayChatRoot({
  renderSlot, SessionProvider, useSessions,
}: OverlayChatRootProps) {
  const sessionId = useSessions(state => state.ids.find(id => (state.byId[id]?.retainedBy.mainView ?? 0) > 0))
  return (
    <div className={css.shell} data-conversation-scroll="" data-overlay-chat="">
      <SessionProvider empty={() => null}>
        {sessionId === undefined
          ? null
          : (
            <>
              {renderSlot('conversation.view', {
                inspectCall: undefined,
                viewRequest: null,
                openView: ignoreView,
                completeViewRequest: ignoreRequest,
              }, { only: 'chat' })}
              <div className={css.inputOverlay}>{renderSlot('conversation.input.overlay', {})}</div>
            </>
          )}
      </SessionProvider>
    </div>
  )
}
