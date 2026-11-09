import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'

/**
 * 为桌面浮动结果生成 GFM，原始 HTML 作为文本显示，危险链接协议被禁用。
 * @param text - 模型输出或文章预览的 Markdown 原文。
 * @returns 可插入结果容器的 HTML；复制和归档仍使用原文。
 */
export function renderMarkdown(text: string): string {
  return micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false, allowDangerousProtocol: false }).trim()
}
