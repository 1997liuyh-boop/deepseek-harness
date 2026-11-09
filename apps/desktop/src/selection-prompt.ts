





export const DESKTOP_SELECTION_PREAMBLE =
  'Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.'


export type SelectionTranslateLanguage = string

/** 校验磁盘与 IPC 中的目标语言名称。 */
export function isSelectionLanguage(value: unknown): value is SelectionTranslateLanguage {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
    && !/[\x00-\x1f]/u.test(value)
}






export function selectionSearchUrl(text: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}







export function composeSelectionTranslatePrompt(
  text: string,
  language: SelectionTranslateLanguage,
): string {
  const target = language === 'en' ? 'English' : language === 'zh' ? 'Chinese' : language.trim()
  return `${DESKTOP_SELECTION_PREAMBLE}\n\nTranslate the following into ${target}:\n\n${text}`
}








export function composeSelectionSendPrompt(instruction: string, selection: string): string {
  return `${instruction}\n\n${selection}`
}
