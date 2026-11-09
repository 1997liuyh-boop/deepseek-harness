---
description: "Direct selection and bounded sequential provider failover for Agent conversations."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-routing

English | [中文](README.zh.md)

## Summary

Route conversations through existing provider adapters. Choose direct mode or an ordered failover queue in Models settings, including its default candidate and recovery budget. Credentials remain with each provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The base bundle mounts this service. Select **Follow system** in a conversation to use its default; a manually selected queue member starts that queue, while a model outside the queue stays direct. Direct mode never changes providers automatically.

Select **Aggregate mode** in a conversation to use the configured queue even when the system default is direct. This selection is local to that conversation and does not change system settings. Both routing choices are available only when the queue contains candidates.

Aggregate mode captures the queue for a turn. Eligible request failures advance through finite retries and later candidates; the successful candidate stays active for subsequent tool steps. A new turn starts from the selected/default candidate again. Changing settings affects later turns. Stopping or unloading cancels pending recovery.

When the conversation carries images, recovery skips candidates that explicitly reject images without dispatching to them or recording a switch. Images remain in the conversation. If skipping exhausts the queue and the failure was transient (transport, timeout, server, rate limit, empty response), routing walks the queue again from its first candidate, at most twice more and within the recovery budget; a persistent failure then ends the turn with that real cause instead of the last candidate's image rejection. The settings page marks image-capable candidates and warns when the queue holds only one.

<a id="understand-the-implementation"></a>
## Understand the implementation

`agent/resolve-model` selects the real model before prompt assembly. Recovery uses `agent/request-error` and durable `llm/retry` events, reassembles the prompt and repeats pre-step preparation. Provider retry execution is suppressed for aggregate requests while specialized context recovery remains available. `llm/validate-input` checks the prepared adapter generation and rejects explicitly unsupported images before projection. Failed partial replies never enter usable assistant history.

<a id="further-exploration"></a>
## Further Exploration

See [LLM streaming](../../../docs/subsystems/llm-streaming.md) and [provider retries](../llm-retry/README.md).

<a id="model-experience"></a>
## Model Experience

### Provider failover

#### What the model sees

The actual candidate receives its prompt, tools and readable history. Model changes enter the history as `model-selection` notices; failed partial output and retry diagnostics do not.

#### Token effect

Each attempted candidate can incur provider charges. Retry events themselves contribute no tokens.

#### KV Cache effect

Changing provider or model can invalidate provider caches. The original log retains real provider identities and failed attempts.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only explicitly classified transport, quota, credential, unavailable-model and modality failures trigger failover. Invalid user input and incompatible encrypted history remain terminal. The recovery budget limits scheduling; each adapter owns request timeouts. Helpers such as title generation keep their own fixed route.

<a id="dev-note"></a>
### Dev Note

None.
