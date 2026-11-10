---
kind: upgrade-guide
description: "Desktop 原生功能插件 0.2.0 需要单独安装共享运行时，不再依赖定制 Desktop 扩展 API。"
---

# Desktop 原生功能插件

[English](guide.md) | 中文

## 变更

悬浮球、划词工具栏、截图和录屏从独立 Cordis bundle 加载。其 0.1.0 安装包依赖定制 Desktop 扩展 API 1，无法在官方 Desktop 中加载。功能插件 0.2.1 通过单独安装的 `dsh-desktop-runtime` 0.1.1 使用官方 Host 服务，不替换或修改官方应用，也无法在纯 Web profile 中运行。

Git 安装会锁定已安装的提交；推送源码不会更新本机副本。悬浮球独立选择对话，不跟随官方主窗口的当前对话。定制分支的坐标模式和后台代码代理配置不可用。已有会话、保存的设置、笔记及录屏文件均保留。

## 迁移

1. 在官方 Desktop 插件管理器中打开**添加插件**，先安装并启用 `https://github.com/1997liuyh-boop/dsh-desktop-runtime.git#0.1.1`。提示构建授权时允许 Electron 安装脚本，也可通过运行时的 `electronExecutable` 配置指定本机兼容的 Electron 44 可执行文件。
2. 通过**添加插件**按需安装或替换为新的功能标签：`https://github.com/1997liuyh-boop/dsh-floating-ball.git#v0.2.1`、`https://github.com/1997liuyh-boop/dsh-selection-toolbar.git#v0.2.1`、`https://github.com/1997liuyh-boop/dsh-capture.git#v0.2.1`。也可安装同版本的已发布归档。不要删除 Desktop profile 或其中的锁文件。
3. 按提示重启 Host。在插件管理器中确认运行时及功能插件版本，并检查扩展 API 1 错误消失。随后在目标系统实际操作悬浮球对话、划词翻译，以及辅助进程托盘中的截图和录屏入口。截图录屏无需悬浮球，翻译无需另外两个配套插件。
4. 停用并重新启用一个功能，确认窗口和原生监听停止、已保存数据仍在。停用共享运行时会停止所有依赖的原生功能。构建和协议检查通过不等于 GUI 验收通过。

源码构建会将运行时和各功能导出到 `apps/desktop/plugins/`；每个目录包含独立构建说明，并支持本地安装。详见 [Desktop 原生功能插件](../../../../apps/desktop/README.zh.md#native-feature-plugins)。
