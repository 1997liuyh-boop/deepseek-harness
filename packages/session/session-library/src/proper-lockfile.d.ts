/** 上游 JavaScript 依赖在本包使用的同步租约接口。 */
declare module 'proper-lockfile' {
  interface Options {
    stale: number
    lockfilePath: string
    onCompromised?: (error: Error) => void
  }
  const lockfile: {
    checkSync(file: string, options: Options): boolean
    lockSync(file: string, options: Options): () => void
  }
  export default lockfile
}
