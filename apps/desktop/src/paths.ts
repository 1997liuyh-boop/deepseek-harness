

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'


export const ORB_WORKSPACE_NAME = 'dsh_orb'


export interface DesktopPaths {
  readonly profile: string

  readonly orbWorkspace: string
  readonly lock: string
}






export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    orbWorkspace: join(dshHome, ORB_WORKSPACE_NAME),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}
