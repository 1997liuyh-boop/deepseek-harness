




import type { Context } from '@deepseek-ai/cordis'


export interface OrbCodeAgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}


export interface OrbCodeAgentModel {

  currentSelection(): OrbCodeAgentModelSelection | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {

    orbCodeAgentModel: OrbCodeAgentModel
  }
}


export const name = 'computer-use-orb-code-agent-model'

let selection: OrbCodeAgentModelSelection | undefined





export function setOrbCodeAgentModelSelection(next: OrbCodeAgentModelSelection): void {
  selection = {
    provider: next.provider,
    model: next.model,
    ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
  }
}





export function clearOrbCodeAgentModelSelection(): void {
  selection = undefined
}





export function apply(ctx: Context): void {
  ctx.provide('orbCodeAgentModel', {
    currentSelection: () => selection,
  })
}
