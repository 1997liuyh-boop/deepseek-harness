

import type { DesktopMessages } from './locale.ts'
import { orbCoordinateModeFor, type OrbCoordinateMode } from './millifraction-coordinates.ts'


export type MillifractionConfirmMessages = Pick<
  DesktopMessages,
  | 'millifractionConfirmTitle'
  | 'millifractionConfirmMessage'
  | 'millifractionConfirmDetail'
  | 'millifractionConfirmOk'
  | 'millifractionConfirmCancel'
>


export type MillifractionApplyResult =
  | { readonly applied: false }
  | { readonly applied: true; readonly enabled: boolean }


export interface MillifractionConfirmDialog {





  show(options: {
    readonly title: string
    readonly message: string
    readonly detail: string
    readonly confirm: string
    readonly cancel: string
  }): Promise<boolean>
}







export async function applyMillifractionCoordinates(input: {
  readonly requestedEnabled: boolean
  readonly currentEnabled: boolean
  readonly messages: MillifractionConfirmMessages
  readonly dialog: MillifractionConfirmDialog
  readonly persist: (enabled: boolean) => void
  readonly pushHost: (mode: OrbCoordinateMode) => void
  readonly createOverlaySession: () => void
}): Promise<MillifractionApplyResult> {
  if (input.requestedEnabled === input.currentEnabled) return { applied: false }
  const confirmed = await input.dialog.show({
    title: input.messages.millifractionConfirmTitle,
    message: input.messages.millifractionConfirmMessage,
    detail: input.messages.millifractionConfirmDetail,
    confirm: input.messages.millifractionConfirmOk,
    cancel: input.messages.millifractionConfirmCancel,
  })
  if (!confirmed) return { applied: false }
  input.persist(input.requestedEnabled)
  input.pushHost(orbCoordinateModeFor(input.requestedEnabled))
  input.createOverlaySession()
  return { applied: true, enabled: input.requestedEnabled }
}
