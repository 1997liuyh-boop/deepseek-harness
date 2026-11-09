/** 为已授权的后台 Code agent 安装无人值守审批和问题答复，随其插件生命周期撤销。 */





import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'


/** 没有可选答案时，要求后台任务停止扩展并返回已有结果的固定答复。 */
export const UNATTENDED_CUSTOM_ANSWER = 'Stop. Return the short result you already have. Do not expand the task.'






/**
 * 按计划批准、推荐选项、首项或全部多选项生成后台问题答复。
 * @param questions - 后台 Agent 发出的待答问题列表。
 * @returns 与各问题标识对应的自动答复；无选项时使用固定停止答复。
 */
export function autoAnswerQuestions(
  questions: readonly AskUserQuestionItem[],
): AskUserQuestionAnswer {
  return {
    answers: questions.map((question) => {
      if (question.intent?.kind === 'plan-review') {
        return { id: question.id, selected: [question.intent.approve] }
      }
      const options = question.options ?? []
      const recommended = options.find(option => option.label.includes('(Recommended)'))
      if (recommended !== undefined) {
        return { id: question.id, selected: [recommended.label] }
      }
      if (options[0] !== undefined) {
        return {
          id: question.id,
          selected: question.multiSelect === true
            ? options.map(option => option.label)
            : [options[0].label],
        }
      }
      return { id: question.id, selected: [], custom: UNATTENDED_CUSTOM_ANSWER }
    }),
  }
}






/**
 * 为后台 Agent 登记一次无人值守处理，释放时移除监听及登记。
 * @param code - 需要处理审批与问题的后台 Agent。
 * @param attached - 由调用方维护的已登记集合，防止重复安装。
 */
export function attachUnattendedCodeAgent(code: Agent, attached: WeakSet<Agent>): void {
  if (attached.has(code)) return
  attached.add(code)
  try {
    code.ctx.effect(() => {
      const offApproval = code.ctx.on(
        'approval/request',
        () => Promise.resolve<ApprovalOutcome>('allowed-once'),
        { prepend: true },
      )
      const offQuestions = code.ctx.on(
        'user-questions/request',
        (request: AskUserQuestionRequest) => Promise.resolve(autoAnswerQuestions(request.questions)),
        { prepend: true },
      )
      return () => {
        offApproval()
        offQuestions()
        attached.delete(code)
      }
    })
  } catch {

    attached.delete(code)
  }
}
