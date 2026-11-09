# Agent Note: DeepSeek credential shape and account balance precedence

Status: implemented

English | [中文](2026-11-05-deepseek-open-platform-key-shape.zh.md)

## Problem

The DeepSeek official provider card accepted any non-blank string as the API key. A user who pasted the browser sign-in token (a UUID) saved it; every official request, including the usage plugin's balance query at startup, then failed with HTTP 401, and the message pointed back at the key the user had just saved. The usage plugin also queried balance only through the Open Platform key, even when the account was signed in through the DeepSeek account service.

## Decision

Two gates on the value's shape and one rule for the balance source:

- `packages/client/ui-settings-models/src/client/apiKey.ts` exports `deepSeekKeyFailure`. On the `deepseek` layout a non-empty draft that does not match `/^sk-[A-Za-z0-9_-]+$/` reports `keyNotOpenPlatform` and the editor refuses to save. The rule tests the prefix and character set only, not length. The save-time provider verification (`verifyOfficialKey`) runs after it.
- `apps/desktop/scripts/usage-balance-compat.mjs`, copied into the plugin as `lib/dsh-balance-compat.mjs` by `scripts/patch-usage-balance.mjs`, exports the same test as `isOpenPlatformKey`. The patched `queryBalance` returns `keyShapeFailure()` (`errorCode: 'not-open-platform-key'`) without an HTTP request when the stored DeepSeek credential fails it.
- Before reading credentials, the patched `queryBalance` calls `accountBalance(ctx, provider)`. When `ctx.get('deepseekAccount')` reports `credential-stored`, the wallets from its `getBalance` become the plugin's DeepSeek result with `sourceNoteKey: 'note.deepseekAccount'` and `credentialSource: 'deepseek-account-platform'`. Any other state or failure returns `null` and the key path continues.

The patch replaces the import line left by its earlier revision and stays idempotent under the 1.18.0 version lock. The 401 text says that a pasted sign-in token needs an Open Platform key and that account balance lives under Settings → Account.

## Alternatives considered

**Verify the key against the provider before saving, without a shape test.** Rejected as the only gate: verification needs the network and reports a generic rejection, while the shape test explains the mistake before any request.

**Accept the sign-in token as an Open Platform key through the account service.** Rejected: the Open Platform and the account site issue different credentials. The account service already exposes balance, so only the balance query moves to it.

**Require the exact DeepSeek key length.** Rejected: the length is not documented as stable, and short `sk-` values are valid for third-party endpoints and existing fixtures. The prefix is enough to separate a UUID token.

## Consequences

Bought: a pasted sign-in token is refused with a localized explanation at save time and never reaches the official endpoint, and signed-in users see their account balance without an Open Platform key. Cost: the usage plugin stays patched by string replacement and must be re-verified when its version changes, and the account result reports `grantedBalance` as zero because the account wallet API does not split it; bonus wallets appear only as detail rows.

## Testing

`apps/desktop/scripts/usage-balance-compat.test.mjs`, `scripts/patch-usage-balance.test.mjs`, and `packages/client/ui-settings-models/tests/api-key.client.spec.ts`.
