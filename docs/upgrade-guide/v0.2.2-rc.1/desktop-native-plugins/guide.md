---
kind: upgrade-guide
description: "Desktop native feature plugins 0.2.0 require the separately installed runtime instead of the custom Desktop extension API."
---

# Desktop native feature plugins

English | [中文](guide.zh.md)

## Change

Floating ball, selection toolbar, and screenshot and recording load from independent Cordis bundles. Their 0.1.0 packages require the custom Desktop extension API 1 and cannot load in official Desktop. Feature versions 0.2.1 use the separately installed `dsh-desktop-runtime` 0.1.1 and official Host services. They do not replace or modify the official application and do not run in a Web-only profile.

Git installations remain locked to their installed revision; pushing source commits does not update installed copies. The floating ball selects its own conversations instead of following the official main window. Custom-fork coordinate modes and background code-agent settings are unavailable. Existing sessions, saved settings, notes, and recordings are retained.

## Migration

1. Open **Add plugin** in official Desktop's plugin manager. Install and enable `https://github.com/1997liuyh-boop/dsh-desktop-runtime.git#0.1.1` first. Allow Electron's installation script if prompted, or configure the runtime's `electronExecutable` with a compatible local Electron 44 executable.
2. Use **Add plugin** to install or replace the desired feature bundles with their new tags: `https://github.com/1997liuyh-boop/dsh-floating-ball.git#v0.2.1`, `https://github.com/1997liuyh-boop/dsh-selection-toolbar.git#v0.2.1`, and `https://github.com/1997liuyh-boop/dsh-capture.git#v0.2.1`. A published archive for the same version is also supported. Do not delete the Desktop profile or its lockfile.
3. Restart the Host when requested. Confirm the installed runtime and feature versions in the plugin manager and check that the extension API 1 error is gone. Then exercise the floating conversation, selection translation, and the helper tray's screenshot and recording entries on the target OS. Capture does not require the floating ball; translation does not require either companion.
4. Disable and re-enable one feature to confirm its windows and native listeners stop and its saved data remains. Disabling the shared runtime stops every dependent native feature. Build and protocol checks alone do not establish GUI acceptance.

Source builds export the runtime and features under `apps/desktop/plugins/`; each directory contains its own build instructions and supports local installation. See [Desktop native feature plugins](../../../../apps/desktop/README.md#native-feature-plugins).
