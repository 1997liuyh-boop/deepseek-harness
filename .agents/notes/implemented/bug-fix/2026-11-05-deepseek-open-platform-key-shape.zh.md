# Agent Note: DeepSeek 凭据形态与账号余额优先

Status: implemented

[English](2026-11-05-deepseek-open-platform-key-shape.md) | 中文

## 问题

DeepSeek 官方供应商卡片把任何非空字符串都当作 API Key 接受。用户粘贴网页登录令牌（UUID 形）后保存成功；随后每个官方请求，包括用量插件启动时的余额查询，都以 HTTP 401 失败，而错误信息又把用户指回刚保存的密钥。用量插件也只通过开放平台密钥查余额，即使账号已经通过 DeepSeek 账号服务登录。

## 决策

对取值形态设两道门，对余额来源定一条规则：

- `packages/client/ui-settings-models/src/client/apiKey.ts` 导出 `deepSeekKeyFailure`。`deepseek` 布局下非空草稿不匹配 `/^sk-[A-Za-z0-9_-]+$/` 时报告 `keyNotOpenPlatform`，编辑器拒绝保存。规则只检查前缀与字符集，不限定长度。保存时的供应商校验（`verifyOfficialKey`）在其之后执行。
- `apps/desktop/scripts/usage-balance-compat.mjs` 由 `scripts/patch-usage-balance.mjs` 复制进插件作为 `lib/dsh-balance-compat.mjs`，以 `isOpenPlatformKey` 导出同一判断。已保存的 DeepSeek 凭据不通过时，补丁后的 `queryBalance` 不发 HTTP 请求，直接返回 `keyShapeFailure()`（`errorCode: 'not-open-platform-key'`）。
- 补丁后的 `queryBalance` 在读取凭据前先调用 `accountBalance(ctx, provider)`。`ctx.get('deepseekAccount')` 报告 `credential-stored` 时，其 `getBalance` 返回的钱包映射为插件的 DeepSeek 结果，`sourceNoteKey: 'note.deepseekAccount'`、`credentialSource: 'deepseek-account-platform'`。其他状态或失败返回 `null`，密钥路径继续。

补丁会替换早期版本留下的引入行，并在 1.18.0 版本锁下保持幂等。401 文案说明粘贴的登录令牌需要换成开放平台密钥，账号余额在「设置 → 账号」查看。

## 考虑过的替代方案

**只在保存前向供应商校验密钥，不做形态判断。** 作为唯一门槛被否决：校验依赖网络且只能报告笼统的拒绝，而形态判断在任何请求之前就能说明错误所在。

**通过账号服务把登录令牌当开放平台密钥接受。** 否决：开放平台与账号站点签发的是不同凭据。账号服务已经暴露余额，所以只有余额查询转到它那里。

**要求精确的 DeepSeek 密钥长度。** 否决：长度没有被记录为稳定值，短的 `sk-` 值对第三方端点和现有夹具都是合法的。前缀足以区分 UUID 令牌。

## 后果

换来：粘贴的登录令牌在保存时被拒绝并给出本地化解释，永远不会到达官方端点；已登录用户无需开放平台密钥即可看到账号余额。代价：用量插件仍靠字符串替换打补丁，版本变化时必须重新核对；账号结果的 `grantedBalance` 报告为零，因为账号钱包接口不区分，赠送钱包只作为明细行出现。

## 测试

`apps/desktop/scripts/usage-balance-compat.test.mjs`、`scripts/patch-usage-balance.test.mjs` 与 `packages/client/ui-settings-models/tests/api-key.client.spec.ts`。
