/** 识别桌面划词转入聊天的消息，供桌面工具策略限制该回合的操作。 */





import type { ContentBlock } from '@deepseek-ai/dsh-llm'





/** 桌面划词消息的固定前缀，要求只在当前聊天回答。 */
export const DESKTOP_SELECTION_PREAMBLE =
  'Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.'

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}






/**
 * 检查是否有用户消息以桌面划词前缀开始，不采用其他来源的相同文字。
 * @param messages - 当前待处理的消息内容与来源列表。
 * @returns 至少一条直接用户消息带有该前缀时为 true。
 */
export function isDesktopSelectionTurn(
  messages: readonly { readonly content: readonly ContentBlock[]; readonly source: { readonly kind: string } }[],
): boolean {
  return messages.some(message =>
    message.source.kind === 'user' && textOf(message.content).startsWith(DESKTOP_SELECTION_PREAMBLE))
}
