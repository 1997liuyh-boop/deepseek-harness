


export type TccRight = 'screen' | 'accessibility'


export type TccRightState = 'missing' | 'granted' | 'needsRelaunch'


export interface TccStatus {

  readonly applicable: boolean

  readonly appName: string
  readonly screen: TccRightState
  readonly accessibility: TccRightState
}


export const TCC_SETTINGS_URL = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const




export interface TccHost {
  readonly platform: NodeJS.Platform

  appName(): string

  screenGranted(): boolean

  accessibilityGranted(): boolean




  openExternal(url: string): Promise<unknown>
}






export function tccReady(status: TccStatus): boolean {
  return !status.applicable || (status.screen === 'granted' && status.accessibility === 'granted')
}






export function isTccRight(value: unknown): value is TccRight {
  return value === 'screen' || value === 'accessibility'
}

function rightState(granted: boolean, opened: boolean): TccRightState {
  if (granted) return 'granted'
  return opened ? 'needsRelaunch' : 'missing'
}





export class TccController {
  private readonly opened = new Set<TccRight>()




  constructor(private readonly host: TccHost) {}





  status(): TccStatus {
    const appName = this.host.appName()
    if (this.host.platform !== 'darwin') {
      return { applicable: false, appName, screen: 'granted', accessibility: 'granted' }
    }
    return {
      applicable: true,
      appName,
      screen: rightState(this.host.screenGranted(), this.opened.has('screen')),
      accessibility: rightState(this.host.accessibilityGranted(), this.opened.has('accessibility')),
    }
  }





  async open(right: TccRight): Promise<void> {
    if (this.host.platform !== 'darwin') return
    this.opened.add(right)
    await this.host.openExternal(TCC_SETTINGS_URL[right])
  }
}
