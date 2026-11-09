/** 接口与凭据变化只影响请求投影，不能覆盖旧记录。 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { projectReplayIdentity } from '../src/replay.ts'

function request(redacted = false): GenerateOptions {
  return { provider: 'custom', model: 'model', messages: [createAssistantMessage({
    source: { provider: 'custom', model: 'model', replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: 'custom', model: 'model', stopReason: 'stop', identity: 'a'.repeat(64) },
      blocks: [{ type: 'reasoning', thinkingSignature: 'native-signature', redacted }],
    } }, content: [{ type: 'reasoning', text: redacted ? '' : 'readable reasoning' }],
  })] }
}

describe('provider replay identity', () => {
  it('retains native signatures only for the matching identity', () => {
    const original = request()
    expect(projectReplayIdentity(original, 'a'.repeat(64)).messages[0]).toBe(original.messages[0])
    expect(projectReplayIdentity(original, 'new-backend-or-credential').messages[0]?.source).not.toHaveProperty('replayState')
    expect(original.messages[0]?.source).toHaveProperty('replayState')
  })
  it('uses readable content when legacy history has no verifiable request identity', () => {
    const original = request()
    const projected = projectReplayIdentity(original, undefined)
    expect(projected.messages[0]?.content).toEqual([{ type: 'reasoning', text: 'readable reasoning' }])
    expect(projected.messages[0]?.source).not.toHaveProperty('replayState')
  })
  it('refuses opaque reasoning instead of silently dropping it', () => {
    expect(() => projectReplayIdentity(request(true), 'another-identity')).toThrow(/provider-bound encrypted reasoning/)
  })
})
