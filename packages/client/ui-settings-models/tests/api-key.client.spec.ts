/** 官方 Provider 的密钥形态判断：登录令牌不能当开放平台密钥保存。 */
import { describe, expect, it } from 'vitest'
import { apiKeyFailure, deepSeekKeyFailure } from '../src/client/apiKey.ts'

describe('deepSeekKeyFailure', () => {
  it('接受 sk- 开头的开放平台密钥，空值交给通用判断', () => {
    expect(deepSeekKeyFailure('sk-0123456789abcdef0123')).toBeUndefined()
    expect(deepSeekKeyFailure('  sk-0123456789abcdef0123  ')).toBeUndefined()
    expect(deepSeekKeyFailure('')).toBeUndefined()
    expect(apiKeyFailure('sk-0123456789abcdef0123')).toBeUndefined()
  })
  it('UUID 形的登录令牌与缺少 sk- 前缀的字符串都不是开放平台密钥', () => {
    expect(deepSeekKeyFailure('3f6b2c1e-8a4d-4f1b-9c2e-7d5a1b2c3d4e')).toBe('keyNotOpenPlatform')
    expect(deepSeekKeyFailure('sk-')).toBe('keyNotOpenPlatform')
    expect(deepSeekKeyFailure('sk-live')).toBeUndefined()
    expect(deepSeekKeyFailure('DeepSeekHarnessToken')).toBe('keyNotOpenPlatform')
  })
})
