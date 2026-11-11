# Validation — 0.1.0

Date: 2026-10-17. Windows 11 amd64; Magpie `0.1.1278`; Bun `1.3.14`.

## Contract and unit checks

- `npm run check`: single exported plugin function (`ZenMuxAuthPlugin`), `config`, `auth` (`provider: "zenmux"`, `methods`, `loader`, `usage`), and `provider.models` hooks verified offline with no credentials.
- `npm test` / `bun test`: **2 passed, 0 failed**.
- Unit coverage verifies:
  - Automatic key-type classification (`sk-ss-v1-…` → `subscription`, `sk-ai-v1-…` → `payg`, `sk-mg-v1-…` → `management`).
  - Subscription detail mapping (`usage_percentage` ratio `0..1` → `0..100`%, 5-hour and 7-day rolling Flow windows, USD equivalent values, and `remaining_resets` → `resets.fiveHour`).
  - PAYG balance mapping (`total_credits` → `balance: "$..."` with empty `windows`).
  - Protocol selection (`anthropic/*` → `@ai-sdk/anthropic` at `/api/anthropic/v1`, `openai/*` → `@ai-sdk/openai` at `/api/v1`).
  - `403 access_denied` (`X-Magpie-Sign-In: expired`) vs `403 safety_check_failed` (`X-Magpie-Sign-In: kept`).

## Real Magpie host & live ZenMux API verification

- Verified against Magpie CLI `0.1.1278` and Bun `1.3.14` plugin host in an isolated sandbox (`HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`), then installed into the live Magpie environment after removing the legacy custom `zenmux` provider entry.
- Tested with three real ZenMux keys (a Builder Starter subscription key `sk-ss-v1-…`, a Pay-As-You-Go key `sk-ai-v1-…`, and a personal Management API key `sk-mg-v1-…`):
  - **Per-account model filtering**: Total discovered chat/decision models: **182**. The Builder Starter seat (`sk-ss-v1-…`) automatically filtered its model list to **165** Starter-eligible models (excluding Max/Ultra-only models such as `anthropic/claude-opus-4.5`), while the PAYG seat (`sk-ai-v1-…`) listed all **182** models.
  - **Shared Management API key**: The second account (`zenmux#payg`) automatically reused the `sk-mg-v1-…` Management API key saved in `plugin-auth.json` without requiring duplicate input.
  - **Live `magpie quota zenmux` output**:
    ```text
    zenmux · Pay As You Go · API key …6756                   subscription  $26.77 left
    zenmux · Builder Starter · until Oct 27 · API key …dff9  subscription  5h 0% (0 / 50 flows · $0.00 / $1.64) ↻4h38m 14:40  7d 5% (9.86 / 213 flows · $0.32 / $6.99) ↻4d4h Wed 14:39  ↺ 4 five-hour resets until Oct 27 18:01
    ```
  - **Live inference**: `magpie provider test zenmux inclusionai/ling-3.1-flash` passed (`✓ chat · inclusionai/ling-3.1-flash`), and direct Anthropic Messages (`POST /api/anthropic/v1/messages` with `metadata`) and OpenAI Chat Completions (`POST /api/v1/chat/completions`) both answered `200 OK`.
- No API keys or account credentials are stored in this repository.

---

# Validation — 0.1.3

Date: 2026-11-11. macOS 15 (Darwin 25.6.0); Node `v26.3.1`; Bun `1.3.14`; Magpie `0.1.1278`.

## What changed

ZenMux rotated every API key format during its upgrade window of 2026-10-22 → 2026-11-10 and disabled the legacy keys on 2026-11-10 00:00 UTC. The live ZenMux API answers a legacy key with:

```text
403 access_denied — The API key upgrade window (October 22–November 10, 2026) has ended.
Legacy keys have been disabled since November 10, 2026, at 00:00 UTC.
Please create a new API key of the same type at https://zenmux.ai/platform …
```

The new formats (taken from the upstream plugin, which tracks the platform) are `sk-subs-…` for Builder Plan, `sk-payg-…` for Pay As You Go and `sk-mgmt-…` for Management. 0.1.3 accepts the new and the legacy spelling of each, so an account signed in before the upgrade keeps classifying the way it used to.

## Contract and unit checks

- `npm run check`: **✓ magpie-zenmux (0.1.3)** — single exported plugin function, `config`, `auth` (`provider: "zenmux"`, `methods`, `loader`, `usage`) and `provider.models` hooks, verified offline with no credentials.
- `npm test`: **5 passed, 0 failed**.
  - New unit coverage: `sk-subs-` → `subscription`, `sk-payg-` → `payg`, `sk-mgmt-` → `management`, and the legacy `sk-ss-v1-` / `sk-ai-v1-` / `sk-mg-v1-` spellings still classify as before.
  - The 0.1.2 coverage (image-only models stay in the catalog, a higher `effective_usd_per_flow` reads as a value note and not an error, `403 access_denied` vs `403 safety_check_failed`) still passes.

## Not verified here

- No new-format key was available in this environment, so the new prefixes are verified against the upstream plugin and the platform's own error message, not against a live request.
