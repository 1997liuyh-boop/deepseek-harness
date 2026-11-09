---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-orb-computer-use-context

English | [中文](2026-10-22-orb-computer-use-context.zh.md)

## Summary

Records the Computer Use coordinate-mode event and the computer-use context source against the updated upstream Session vocabulary.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The writer remains format v4. Existing discriminators retain their meanings and the current reader accepts logs without these additions. The coordinate mode uses a distinct required event discriminator; a reader without that event refuses the log rather than interpreting coordinates in another mode. The computer-use source uses the existing kind and form discriminators. No committed generation or existing user log is rewritten. The model-selection projection cache uses stateVersion 4 and is rebuilt from the same log when its cache version differs.

<a id="verification"></a>
## Verification

The focused Computer Use run passed 27 tool tests, including two-session millifraction and pixel schema assembly. The focused Agent model-selection tests passed with explicit selection restored from the log and fallback request headers retained separately. The preceding focused run passed 593 of 600 tests; the seven failures were resolved by updating removed test APIs, mounting the native executor, using the new seeded-fork header assertion, and rerunning filesystem tests with host permission.

<a id="dev-note"></a>
## Dev Note

None.
