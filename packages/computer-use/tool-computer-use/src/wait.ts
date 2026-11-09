/** 提供可取消的等待，在计时结束或取消后清理监听器与计时器。 */











/**
 * 等待指定毫秒数，取消时立即拒绝；非正时长仍检查取消状态。
 * @param ms - 需要等待的毫秒数。
 * @param signal - 取消该次等待的信号。
 * @throws 信号已取消或等待期间取消时抛出取消原因。
 */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal.throwIfAborted()
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('computer-use: wait aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) {
      clearTimeout(timer)
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
