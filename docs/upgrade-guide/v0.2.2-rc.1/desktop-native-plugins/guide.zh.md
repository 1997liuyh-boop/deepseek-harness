---
kind: upgrade-guide
description: "Desktop 悬浮球、划词工具栏及截图录屏需要分别安装独立原生插件 bundle。"
---

# Desktop 原生功能插件

[English](guide.md) | 中文

## 变更

悬浮球、划词工具栏、截图和录屏此前随 Desktop 壳启动，现在分别从三个独立 Cordis bundle 加载。已有安装需要安装相应插件才能继续使用这些功能。会话及功能配置文件保持原有位置。

这些插件需要此 Desktop 分支的扩展 API 1。仅满足上游 dsh 版本范围并不能保证兼容，也无法在纯 Web profile 中运行。

## 迁移

1. 将 Desktop 更新到提供扩展 API 1 的构建，再打开插件管理器。
2. 按需安装并启用 Git bundle：`https://github.com/1997liuyh-boop/dsh-floating-ball`、`https://github.com/1997liuyh-boop/dsh-selection-toolbar`、`https://github.com/1997liuyh-boop/dsh-capture`。
3. 插件管理器要求重启时重启 Desktop。确认悬浮球出现、受支持平台划词后显示工具栏，启用截图录屏插件后应用菜单出现对应入口。截图录屏无需悬浮球。
4. 停用一个插件，确认其窗口及原生监听停止。重新启用后继续使用已保存设置。翻译独立运行；悬浮球相关操作及录屏附件分别需要对应的配套插件。

源码安装时，桌面构建会将各个包导出到 `apps/desktop/plugins/`。每个目录包含独立构建说明，也可从本地目录安装。详见 [Desktop 原生功能插件](../../../../apps/desktop/README.zh.md#native-feature-plugins)。
