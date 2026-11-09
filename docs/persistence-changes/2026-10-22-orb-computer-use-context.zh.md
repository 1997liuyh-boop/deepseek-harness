---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-orb-computer-use-context

[English](2026-10-22-orb-computer-use-context.md) | 中文

## 概述

基于新版上游会话词汇记录 Computer Use 坐标模式事件和 computer-use 上下文来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-orb-computer-use-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "399bafbee5cb490d9fa236edbbbec949e5fcc7195b2caf6c00636481e4400af6"
    decision: same-version
  - root: "event:computer-use/coordinate-mode"
    previous: null
    after: "43c99dbb47176eec46640f2acc94ed8a23238551bfb8ec9b8507f69d95f4da94"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "c0bb38c92e9dde1fcb8eafcb6653ff22b9eb8d4c7e8a60cf5b9921bbd6393fc9"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "42faa0397d347757fb62b8d5a50d4fc0a079b29a968d0422b35df652b60ba18b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "cfd54c887bc7c3a2b706d3e05b810cc92d527caf3f2d16a5816f8d8effc0a5b5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

写入格式仍为 v4。已有判别字段的含义不变，当前读取器接受不含这些新增项的日志。坐标模式使用独立且必需的事件判别字段；不认识该事件的读取器会拒绝日志，避免按其他模式解释坐标。computer-use 来源沿用 kind 与 form 判别字段。不重写已提交的历史代次或用户日志。模型选择投影缓存使用 stateVersion 4，缓存版本不同时从相同日志重建。

<a id="verification"></a>
## 验证

Computer Use 定向运行的 27 项工具测试通过，包含同进程两个会话的千分比和像素工具声明组装。Agent 模型选择定向测试通过，明确选择从日志恢复，备用请求头单独保留。此前定向运行 600 项中通过 593 项；其余七项已通过适配移除的测试接口、挂载原生执行器、使用新版分支种子头断言，以及获得宿主权限重跑文件系统测试解决。

<a id="dev-note"></a>
## 开发备注

无。
