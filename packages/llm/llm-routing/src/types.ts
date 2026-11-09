/** 路由配置的客户端安全类型。 */

/** 一个明确的供应商与模型配对。 */
export interface Route {
  /** 已注册的真实供应商标识。 */
  provider: string
  /** 该供应商中的明确模型标识。 */
  model: string
}

/** 一次请求恢复期间保持不变的路由配置。 */
export interface RoutingPolicy {
  /** 直连或按候选队列顺序恢复。 */
  mode: 'direct' | 'aggregate'
  /** 默认项之后按此顺序尝试其他候选。 */
  routes: readonly Route[]
  /** 默认候选在队列中的下标。 */
  defaultIndex: number
  /** 每个候选的额外重试次数。 */
  retriesPerRoute: number
  /** 每次恢复前的最短等待毫秒数。 */
  delayMs: number
  /** 一次步骤恢复的总调度预算，单位毫秒。 */
  budgetMs: number
}
