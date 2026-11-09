# Agent Note: 划词工具栏的付费文章处理与固定模型选择

Status: implemented

[English](2026-11-06-selection-toolbar-paid-articles-and-model-choice.md) | 中文

## 问题

划词工具栏的抓取公众号动作用裸 Node `fetch` 下载文章：没有 Cookie，也没有浏览器身份。付费文章的服务器返回 HTTP 200 与免费试读（页面脚本里 `is_pay_subscribe: '1'`、`is_paid: '0'`、`preview_percent: '10'`），结果窗把 10% 的片段当成抓取成功，唯一的提醒只是一行静态提示。购买状态绑定微信身份，`mp.weixin.qq.com` 没有读者网页登录，桌面端任何请求都拿不到已购正文。

翻译与解读沿用主窗口当前会话的模型，否则退回宿主默认模型。在「设置 → 模型」里配好第三方供应商的用户，只能把主聊天切到那个模型才能用上。

## 决策

`fetchWechatPage` 发送桌面端的浏览器 User-Agent（`app.userAgentFallback`，模块默认值为桌面 Chrome 标识）以及 `accept`、`accept-language` 头：微信对非浏览器标识直接 302 到验证页，结果窗此前把它报告为「要求完成验证」。每跳最长 60 秒，正文上限 8 MB，因为实测文章页面超过 3 MB。

`apps/desktop/src/selection-archive.ts` 在 Turndown 之前解析原始页面脚本：`wechatPaywall` 在 `is_pay_subscribe` 或 `appmsg_needpay` 为 1 且 `is_paid` 不为 1 时报告付费，并从 `pay_subscribe_info` 读取 `preview_percent` 与 `fee`（分）。`extractWechatPaywalled` 只返回公开元数据（标题、作者、日期）与试读 Markdown。`selection-assistant.ts` 的 `fetch` 操作改为返回 `{ paywalled }` 而不是稿件，不动已导入的草稿；结果窗显示付费面板（试读比例与售价），保存保持禁用，并提供**导入已复制正文**：新的 `import-paywalled` 操作读取用户在微信里填进剪贴板的内容（HTML 或纯文本），合并公开元数据，并对不比试读更长的导入给出提醒。剪贴板为空是结构化失败 `clipboard-empty`。

`selection-toolbar.json` 新增可选的 `model`（`provider`、`model`、`reasoningEffort?`，由 `parseOrbAgentModelSelection` 校验）。`SelectionSessionTask.run` 以第五个参数接收它：固定模型优先，其次主窗口会话的模型，最后宿主默认。固定模型被拒绝时任务以 `failure: 'model-unavailable'` 结束。结果窗列出宿主目录（`session/modelCatalog`，经 `models` 操作裁剪），首项为「跟随主窗口当前会话」；悬浮球右键菜单新增由 `floatingSelectionModelItems` 构建的第三个子菜单。两处都经 `SelectionToolbarController.setModel` 写入。

## 考虑过的替代方案

**在应用内登录微信并用该会话抓取。** 否决：DeepSeek 访问验证使用的持久分区模式在这里没有对应物，因为微信在 `mp.weixin.qq.com` 上不提供读者登录；购买校验发生在微信客户端内部。

**接受微信客户端复制出的带授权参数长链接（`key`、`pass_ticket`、`uin`）。** 暂缓：服务器是否据此放行付费正文无法在没有客户端的情况下验证，而且这些参数几分钟内就会过期。

**改调第三方翻译 API 而不是模型。** 暂缓：需要新的凭据存储与请求代码；复用宿主目录即可零配置地用上第三方供应商。

**让划词动作复用悬浮球的 overlay 或后台模型。** 否决：那两处服务于不同的 agent；划词的固定选择必须能够保持跟随主会话模型。

## 后果

换来：付费文章不再被当成抓取成功；用户能看到试读比例与售价，并有一键路径导入自己复制的已购正文；翻译与解读可以跑在目录里的任何供应商上。代价：付费识别依赖 2026-11-05 在一张页面上观察到的字段名，微信改名后退化为旧行为；电脑版微信产生的剪贴板内容未在此验证；模型列表在窗口打开时读取，菜单改选不会刷新已打开的窗口。

## 测试

`apps/desktop/tests/selection-archive.spec.ts`、`selection-assistant.spec.ts`、`selection-result-renderer.spec.ts`、`selection-session.spec.ts`、`selection-toolbar-config.spec.ts`、`selection-toolbar-controller.spec.ts`、`floating-agent-menu.spec.ts`、`floating-window.spec.ts`、`orb-agent-models.spec.ts`。
