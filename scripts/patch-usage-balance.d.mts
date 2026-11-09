/** 对已安装的指定版本用量插件应用官方余额兼容修正。
 * @param profile 目标配置目录。
 * @returns 是否安装了需要修正的插件。
 */
export function patchUsageBalance(profile: string): Promise<boolean>
