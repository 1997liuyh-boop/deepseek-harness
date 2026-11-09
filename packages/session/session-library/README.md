---
description: "Local account-owned conversation libraries with verified import backups and ownership restore."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-library

English | [中文](README.zh.md)

## Summary

Group local conversations by the stable DeepSeek account identity without uploading history. View official and third-party conversations in the same account library while logged model sources keep their real provider identities. `custom` is only the Client library label.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The base bundle configures `root` under Harness home. Models settings switches between unbound local history and the current account. Account history becomes available after reading a stable user ID; identity readiness is also published in local mode. A failed read preserves local history. Existing conversations remain unbound until explicitly selected for import; complete parent/child groups must move together. New children inherit their parent's ownership.

Import waits for exclusive session maintenance, flushes logs and attachments into ZIP backups, verifies their SHA-256 digests and source revisions, and atomically commits all selected ownership entries. Restore verifies backups and refuses changed ownership; it only restores ownership, retaining newer messages, titles, attachments, session IDs and studio bindings. The original records are never overwritten by either operation.

<a id="understand-the-implementation"></a>
## Understand the implementation

`index.v1.json` has an independent version and revision; it does not alter Session log versions. Account keys hash the account origin and stable user ID. `backups/` contains archives and `operations/` contains interrupted-operation records. A heartbeat maintenance lease prevents concurrent ownership commits. Interrupted operations without a committed index are marked failed when a later writer obtains the lease.

All business reads use `sessions.access`. Account/library changes cancel old reads, clear Client caches and stop active conversations. Raw persistence remains available to maintenance and backup owners. Credentials and account tokens are excluded from the index and archives.

<a id="further-exploration"></a>
## Further Exploration

See [session data](../../../docs/subsystems/session.md) and [session persistence](../session-persistence-jsonl/README.md).

<a id="model-experience"></a>
## Model Experience

### Account-owned history

#### What the model sees

The `sessions.access` policies limit which conversations query tools can read. Account credentials never enter prompts, and ownership changes do not rewrite the logs or true provider sources.

#### Token effect

Ownership changes make no model requests and contribute no tokens.

#### KV Cache effect

Ownership changes do not modify the conversation's model-visible prefix or provider cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- History remains on this computer. Account mode requires a stable signed-in identity. Maintenance needs writable local storage and idle conversations; it does not merge two edited histories or decrypt provider-bound reasoning.

<a id="dev-note"></a>
### Dev Note

None.
