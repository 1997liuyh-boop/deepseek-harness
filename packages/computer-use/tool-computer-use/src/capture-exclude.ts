/** 通过异步局部存储传递本次观察必须排除的窗口标识，避免并发截图互相覆盖。 */






import { AsyncLocalStorage } from 'node:async_hooks'

const captureExclude = new AsyncLocalStorage<readonly number[]>()






/**
 * 读取当前异步操作要求从截图排除的窗口。
 * @returns 当前排除列表；未设置时返回空列表。
 */
export function activeCaptureExcludeWindowIds(): readonly number[] {
  return captureExclude.getStore() ?? []
}







/**
 * 在独立异步上下文中执行操作，并向其下游传递截图排除窗口。
 * @param excludeWindowIds - 本次操作必须排除的窗口标识。
 * @param fn - 在该排除列表下执行的操作。
 * @returns 操作的原始返回值，包括其 Promise。
 */
export function runWithCaptureExcludeWindowIds<T>(
  excludeWindowIds: readonly number[],
  fn: () => T,
): T {
  return captureExclude.run(excludeWindowIds, fn)
}
