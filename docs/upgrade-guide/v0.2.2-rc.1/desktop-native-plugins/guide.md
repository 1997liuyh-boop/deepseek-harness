---
kind: upgrade-guide
description: "Desktop floating ball, selection toolbar and capture features require separately installed native plugin bundles."
---

# Desktop native feature plugins

English | [中文](guide.zh.md)

## Change

The floating ball, selection toolbar, and screenshot and recording features previously started inside the Desktop shell. They now load from three independent Cordis bundles. Existing installations need the corresponding plugins to retain those features. Sessions and feature configuration files keep their existing locations.

These plugins require this Desktop fork's extension API 1. The upstream dsh version range alone does not establish compatibility. They do not run in a Web-only profile.

## Migration

1. Update Desktop to the build that provides extension API 1, then open its plugin manager.
2. Install and enable the desired Git bundles: `https://github.com/1997liuyh-boop/dsh-floating-ball`, `https://github.com/1997liuyh-boop/dsh-selection-toolbar`, and `https://github.com/1997liuyh-boop/dsh-capture`.
3. Restart Desktop if the plugin manager requests it. Confirm the floating ball appears, selection opens the toolbar on supported platforms, and the application menu offers screenshot and recording when that plugin is enabled. Capture does not require the floating ball.
4. Disable a plugin and confirm its windows and native listeners stop. Re-enable it to reuse its saved settings. Translation remains independent; floating-ball actions and recording attachments require the corresponding companion plugin.

For source installations, the desktop build exports each package into `apps/desktop/plugins/`. Each directory contains its own build instructions and can be installed from that local directory. See [Desktop native feature plugins](../../../../apps/desktop/README.md#native-feature-plugins).
