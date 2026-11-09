---
kind: upgrade-guide
description: Provider-bound reasoning without a verifiable matching replay identity can no longer be continued silently across routes.
---

# Provider-bound reasoning history

English | [中文](guide.zh.md)

## Change

Native replay data now requires a matching provider, model, endpoint and credential identity. Readable assistant text and tool calls remain portable. Opaque reasoning from another identity, including older records without an identity, produces `REPLAY_INCOMPATIBLE` rather than sending unverifiable private data or silently dropping it. Original sessions remain unchanged.

## Migration

1. Keep the original provider, endpoint and credential when continuing sessions containing provider-bound reasoning. A matching recorded identity preserves native replay.
2. If continuation reports incompatible reasoning, open the conversation menu and choose **New conversation from readable history**. This explicit action creates a linked copy with readable messages and tool history; it leaves the original session intact.
3. Continue in the copy and confirm the reply uses the intended provider/model. Older opaque records cannot acquire a verified identity retroactively; keep the original for reference.
