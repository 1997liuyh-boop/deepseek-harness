---
description: "按账号归属的本机会话库、校验迁入备份和归属恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-library

[English](README.md) | 中文

## 概述

根据稳定的 DeepSeek 账号身份归属本机会话，不上传历史。在当前账号库查看官方与第三方会话时，日志中的模型来源仍保留真实供应商。`custom` 仅为客户端的历史库标识。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

基础 bundle 将 `root` 配置在 Harness home 下。模型设置可切换未绑定本机历史与当前账号。账号入口在稳定用户 ID 读取成功后启用，本机模式也会发布身份就绪通知；读取失败时保留本机历史。已有会话在明确选择迁入前仍未绑定，完整父子会话组必须一并迁入，新子会话继承父会话归属。

迁入等待会话的独占维护，刷新日志和附件后导出 ZIP 备份，校验 SHA-256 摘要与源记录版本，再原子提交全部选中归属。恢复校验备份并拒绝已变更归属，只恢复归属，保留较新的正文、标题、附件、会话 ID 与工作室绑定。两种操作都不会覆盖原始记录。

<a id="understand-the-implementation"></a>
## 理解实现

`index.v1.json` 使用独立版本与修订号，不改变 Session 日志版本。账号键由账号服务来源与稳定用户 ID 的摘要组成。`backups/` 保存归档，`operations/` 保存中断操作记录。带心跳的维护租约防止并发归属提交，后续写入方取得租约时，会将没有已提交索引的中断操作标记失败。

全部业务读取使用 `sessions.access`。账号或历史库变化会取消旧读取、清空客户端缓存并停止活动会话。原始持久化接口仍供维护和备份使用，索引及归档不保存凭据或账号令牌。

<a id="further-exploration"></a>
## 进一步探索

参见[会话数据](../../../docs/subsystems/session.zh.md)和[会话持久化](../session-persistence-jsonl/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 账号历史归属

#### 模型看到什么

`sessions.access` 策略限制会话查询工具能读取的会话。账号凭据不会进入提示词，归属变更不重写日志或真实供应商来源。

#### Token 影响

归属变更不发送模型请求，也不贡献 Token。

#### KV Cache 影响

归属变更不修改会话的模型可见前缀或供应商缓存身份。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 历史只保存在此电脑。账号模式需要稳定的已登录身份，维护需要可写本机存储和空闲会话，不合并两份分别编辑的历史，也不解密绑定供应商的推理。

<a id="dev-note"></a>
### 开发备注

无。
