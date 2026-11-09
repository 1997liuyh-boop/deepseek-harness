# Agent Note: Image-aware aggregate recovery and reasoning effort carry-over

Status: implemented

English | [中文](2026-11-05-image-aware-aggregate-recovery.zh.md)

## Problem

Aggregate routing recovered a transient failure of the primary model by walking the queue to the next candidate. When the conversation carried images and the next candidate declared text-only input, the `llm/validate-input` check rejected it with `ROUTING_INPUT_UNSUPPORTED`. The turn then ended with that rejection instead of the primary's real failure (a `TRANSPORT` error in the reported case), and the settings page gave no hint that the queue held only one image-capable model.

A reasoning effort chosen while "following system" was dropped on the direct path and, on the aggregate path, forwarded to every candidate. The core rejects an effort the candidate does not declare with `UNSUPPORTED_REASONING_EFFORT`, which routing cannot recover from.

## Decision

`@deepseek-ai/dsh-llm-routing` records on the turn state whether the request carries images; its `llm/validate-input` listener sets the flag before the modality check. During recovery, candidates whose resolved `inputModalities` exclude `image` are skipped in place: no request, no wait, no `llm/retry` event. If skipping exhausts the queue and the failure code is transient (`TRANSPORT`, `TIMEOUT`, `SERVER`, `RATE_LIMIT`, `EMPTY_RESPONSE`), recovery restarts from the first candidate, at most twice per step and still inside `budgetMs` and `delayMs`; otherwise the end of the queue is final and the turn reports the last real failure. `llm/retry` counts `retry` per step across passes with `maxRetries = routes × (retriesPerRoute + 1) × 3 − 1`. Unknown modalities or a failed capability lookup count as image-capable, so the request-time check and preflight recovery decide.

A selected `reasoningEffort` is attached by `withEffort` only when the target candidate is the selected model itself or declares that effort id in `reasoning.efforts`. The rule applies to the direct "follow system" route and to every aggregate candidate.

`ModelCatalogModel` carries `inputModalities`. The routing settings page marks image-capable candidates and, in aggregate mode, shows a status hint when exactly one candidate accepts images. The chat failure text for `ROUTING_INPUT_UNSUPPORTED` names the rejecting provider and model.

## Alternatives considered

**Re-walk the queue after every exhaustion.** Rejected: with no skipped candidate every model already failed once, and extra passes only multiply attempts beyond `retriesPerRoute`. The existing "stops after every candidate fails once" behaviour stays.

**Return to the last dispatched candidate instead of the queue head.** Rejected: it retries whichever model happened to fail last. Restarting from the head keeps the user's order and makes `maxRetries` an exact pass count.

**Strip images from the request for text-only candidates.** Rejected: silently removing user content changes the answer; the user chose the "retry the primary model" option.

**Forward the selected effort to every candidate and let the core reject it.** Rejected: the rejection is terminal for the turn, while the same request without the effort would have been served.

## Consequences

Bought: a transient primary failure in an image-bearing conversation ends with its real cause after bounded extra attempts, and the settings page shows why a queue cannot fail over. Cost: up to two extra passes over the usable candidates per step, and an effort selection silently degrades to the candidate's default on models that do not declare that level.

## Testing

`packages/llm/llm-routing/tests/routing.spec.ts` pins skip-to-capable, the bounded re-walk ending with the real terminal code, no re-walk for non-transient codes or an exhausted budget, and effort carry-over. `packages/client/ui-settings-models/tests/routing-section.client.spec.tsx` pins the badge and the hint.
