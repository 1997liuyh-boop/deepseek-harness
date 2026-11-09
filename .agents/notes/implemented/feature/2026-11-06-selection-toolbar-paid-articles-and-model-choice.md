# Agent Note: Selection toolbar paid-article handling and fixed model choice

Status: implemented

English | [中文](2026-11-06-selection-toolbar-paid-articles-and-model-choice.zh.md)

## Problem

The selection toolbar's WeChat action downloaded articles with a bare Node `fetch`: no cookies, no browser identity. For a paid article the server answers HTTP 200 with the free preview (`is_pay_subscribe: '1'`, `is_paid: '0'`, `preview_percent: '10'` in the page script), so the window presented a 10% excerpt as a successful fetch and the only warning was a static hint. Purchase state is bound to the WeChat identity; `mp.weixin.qq.com` has no reader web login, so no desktop request can obtain a purchased body.

Translate and Explain copied the model of the main window's current session, or fell back to the host default. A user who had configured a third-party provider in Settings → Models could use it only by switching the main chat to that model.

## Decision

`fetchWechatPage` sends the desktop's browser User-Agent (`app.userAgentFallback`, with a desktop Chrome string as the module default) plus `accept` and `accept-language` headers: WeChat answers a non-browser agent with a 302 to its captcha page, which the window had reported as "verification required". Each hop may take 60 s and the body cap is 8 MB, because article pages measured over 3 MB.

`apps/desktop/src/selection-archive.ts` parses the raw page script before Turndown runs: `wechatPaywall` reports a paywall when `is_pay_subscribe` or `appmsg_needpay` equals 1 and `is_paid` does not, reading `preview_percent` and `fee` (分) from `pay_subscribe_info`. `extractWechatPaywalled` returns only public metadata (title, author, date) and the preview Markdown. The `fetch` operation in `selection-assistant.ts` answers `{ paywalled }` instead of an article, leaves any imported draft untouched, and the result window shows a paywall panel with the preview share and price, keeps saving disabled, and offers **Import copied body**: the new `import-paywalled` operation reads the clipboard the user filled inside WeChat (HTML or text), merges the public metadata, and flags an import that is not longer than the preview. An empty clipboard is the structured failure `clipboard-empty`.

`selection-toolbar.json` gains an optional `model` (`provider`, `model`, `reasoningEffort?`, validated by `parseOrbAgentModelSelection`). `SelectionSessionTask.run` takes it as the fifth argument: fixed model first, then the main window session's model, then the host default. A rejected fixed model ends the task with `failure: 'model-unavailable'`. The result window lists the host catalog (`session/modelCatalog`, trimmed by the `models` operation) with a "follow the main window session" first option; the floating ball context menu gets a third submenu built by `floatingSelectionModelItems`. Both write through `SelectionToolbarController.setModel`.

## Alternatives considered

**Log the user into WeChat inside the app and fetch with that session.** Rejected: the Open Platform-style persistent partition used for DeepSeek access has no counterpart here, because WeChat exposes no reader login on `mp.weixin.qq.com`; purchase checks happen inside the WeChat client.

**Accept auth-bearing long links copied from the WeChat client (`key`, `pass_ticket`, `uin`).** Deferred: whether the server honours them for paid bodies cannot be verified without the client, and the parameters expire within minutes.

**Call a third-party translation API instead of a model.** Deferred: it needs new credential storage and request code; reusing the host catalog gives third-party providers with zero new configuration.

**Reuse the Orb overlay or background model for selection actions.** Rejected: those picks serve different agents; a fixed selection choice must be able to stay on the main session's model.

## Consequences

Bought: a paid article is never presented as fetched; the user sees the preview share and price and has a one-click path to import the purchased body they copied; translate and explain can run on any catalogued provider. Cost: paywall detection depends on field names observed on one page (2026-11-05) and degrades to the old behaviour if WeChat renames them; the clipboard payload desktop WeChat produces was not verified here; the model list is read when the window opens, so a menu change does not refresh an open window.

## Testing

`apps/desktop/tests/selection-archive.spec.ts`, `selection-assistant.spec.ts`, `selection-result-renderer.spec.ts`, `selection-session.spec.ts`, `selection-toolbar-config.spec.ts`, `selection-toolbar-controller.spec.ts`, `floating-agent-menu.spec.ts`, `floating-window.spec.ts`, `orb-agent-models.spec.ts`.
