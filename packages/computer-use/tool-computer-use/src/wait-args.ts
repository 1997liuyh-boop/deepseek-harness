/** 定义桌面短等待与长等待允许的时长，并校验外部工具参数。 */






/** 普通等待工具使用的固定秒数。 */
export const WAIT_SECONDS = 1


/** 长等待工具允许选择的离散秒数。 */
export const LONG_WAIT_SECONDS = [10, 30, 60, 120] as const


/** 长等待工具允许的秒数类型。 */
export type LongWaitSeconds = (typeof LONG_WAIT_SECONDS)[number]







/**
 * 要求外部等待参数恰好属于允许的整数秒数。
 * @param raw - 工具 JSON 输入中的等待秒数。
 * @returns 通过校验的长等待秒数。
 * @throws 类型、整数性或取值不符合要求时抛出错误。
 */
export function requireLongWaitSeconds(raw: unknown): LongWaitSeconds {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !isLongWaitSeconds(raw)) {
    throw new Error('wait_seconds must be 10, 30, 60, or 120')
  }
  return raw
}

function isLongWaitSeconds(value: number): value is LongWaitSeconds {
  return (LONG_WAIT_SECONDS as readonly number[]).includes(value)
}
