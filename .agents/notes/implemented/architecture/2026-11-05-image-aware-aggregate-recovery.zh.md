# Agent Note: 感知图片的聚合恢复与思考强度携带

Status: implemented

[English](2026-11-05-image-aware-aggregate-recovery.md) | 中文

## 问题

聚合路由在主模型瞬时失败后沿队列切到下一候选。会话含图片而下一候选声明只接受文本时，`llm/validate-input` 以 `ROUTING_INPUT_UNSUPPORTED` 拒绝它；本轮随即以这个拒绝结束，而不是主模型的真实失败（上报案例中是 `TRANSPORT`），设置页也没有提示队列里只有一个支持图片的模型。

「跟随系统」时选中的思考强度在直连路径上被丢弃，在聚合路径上则被转发给每个候选。候选未声明该档位时核心层以 `UNSUPPORTED_REASONING_EFFORT` 拒绝，路由无法从中恢复。

## 决策

`@deepseek-ai/dsh-llm-routing` 在本轮状态上记录请求是否含图片；其 `llm/validate-input` 监听器在模态检查前置位。恢复期间，解析出的 `inputModalities` 不含 `image` 的候选原地跳过：不发请求、不等待、不写 `llm/retry` 事件。若因跳过而用尽队列且失败码属于瞬时类型（`TRANSPORT`、`TIMEOUT`、`SERVER`、`RATE_LIMIT`、`EMPTY_RESPONSE`），恢复从队首重新开始，每步最多两次，仍受 `budgetMs` 与 `delayMs` 约束；否则队尾即终点，本轮上报最后一次真实失败。`llm/retry` 的 `retry` 在一步内跨遍累计，`maxRetries = routes × (retriesPerRoute + 1) × 3 − 1`。模态未知或能力查询失败按支持图片处理，交由请求时校验与预检恢复决定。

选中的 `reasoningEffort` 只在目标候选就是所选模型本身、或其 `reasoning.efforts` 声明了该档位标识时才由 `withEffort` 附带。该规则同时作用于直连「跟随系统」路径和每个聚合候选。

`ModelCatalogModel` 携带 `inputModalities`。路由设置页标出支持图片的候选，聚合模式下只有一个候选接受图片时显示状态提示。聊天中 `ROUTING_INPUT_UNSUPPORTED` 的失败文案注明拒绝的供应商与模型。

## 考虑过的替代方案

**每次队列用尽都重走一遍。** 否决：没有跳过任何候选时每个模型都已失败一次，额外的遍数只会让尝试次数超出 `retriesPerRoute`。原有「每个候选失败一次即停止」的行为保留。

**回到最后一个发过请求的候选而不是队首。** 否决：那只是重试碰巧最后失败的模型。从队首重走保持用户排序，也让 `maxRetries` 成为精确的遍数。

**对只支持文本的候选剥离图片。** 否决：悄悄删除用户内容会改变答案；用户选择的是「重试主模型」方案。

**把所选强度转发给每个候选，交给核心层拒绝。** 否决：这种拒绝对本轮是终止性的，而不带强度的同一请求本可成功。

## 后果

换来：含图片的会话里主模型的瞬时失败在有限的额外尝试后以真实原因结束，设置页能说明队列为何无法切换。代价：每步最多对可用候选额外重走两遍；未声明该档位的模型上，强度选择会静默退回候选默认值。

## 测试

`packages/llm/llm-routing/tests/routing.spec.ts` 固定了跳到可用候选、以真实终止码结束的有界重走、非瞬时失败或预算用尽时不重走、以及强度携带。`packages/client/ui-settings-models/tests/routing-section.client.spec.tsx` 固定了徽标与提示。
