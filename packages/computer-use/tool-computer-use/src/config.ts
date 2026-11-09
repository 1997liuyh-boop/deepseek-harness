/** 声明并解析桌面操作后的等待配置，在加载时拒绝无效时间值。 */





import z from '@deepseek-ai/schemastery'


/** 桌面控制插件的可选部署配置。 */
export interface Config {




  /** 桌面操作完成后，等待窗口稳定再观察和截图的毫秒数；默认 600。 */
  readonly postActionWaitMs?: number
}


/** 已补齐默认值并校验的桌面控制配置，供执行阶段直接使用。 */
export interface ResolvedComputerUseConfig {
  readonly postActionWaitMs: number
}


/** 桌面控制插件的可选部署配置。 */
export const Config: z<Config> = z.object({
  postActionWaitMs: z.number().default(600),
})

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number ≥ 0`)
  }
  return value
}






/**
 * 补齐操作后的默认等待时间，并校验其为有限非负数。
 * @param config - 用户提供的可选桌面控制配置。
 * @returns 包含确定等待毫秒数的已解析配置。
 * @throws 等待时间为负数或非有限值时抛出错误。
 */
export function resolveComputerUseConfig(config: Config = {}): ResolvedComputerUseConfig {
  return {
    postActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, 'postActionWaitMs'),
  }
}
