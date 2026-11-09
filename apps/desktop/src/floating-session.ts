

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


export const FLOATING_SESSION_FILE = 'floating-session.json'






export function readFloatingSessionId(profileDir: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, FLOATING_SESSION_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const sessionId = (value as { sessionId?: unknown }).sessionId
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  } catch {

    return undefined
  }
}






export function writeFloatingSessionId(profileDir: string, sessionId: string): void {
  writeFileSync(
    join(profileDir, FLOATING_SESSION_FILE),
    `${JSON.stringify({ sessionId }, undefined, 2)}\n`,
  )
}






export function ensureOrbWorkspaceDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}
