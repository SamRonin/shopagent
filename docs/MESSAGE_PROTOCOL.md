# Message protocol / پروتکل پیام‌ها

All extension contexts talk through `chrome.runtime` / `chrome.tabs`
messages. Every request is an object whose `type` is a SCREAMING_SNAKE
string; every response is `{ ok, ... }`. Long-running work answers
immediately with a `taskId` and streams progress separately.

| Direction | `type` | Payload | Response / notes |
|---|---|---|---|
| panel → bg | `GET_SETTINGS` | – | `{ ok, settings }` |
| panel → bg | `SAVE_SETTINGS` | `{ settings }` | `{ ok, settings }` (secrets split into `storage.local`) |
| panel → bg | `RESET_SETTINGS` | – | `{ ok, settings }` |
| panel → bg | `GET_HISTORY` / `CLEAR_HISTORY` | – | `{ ok, history }` / `{ ok }` |
| panel → bg | `TEST_CONNECTION` | `{ settings? }` | `{ ok, result:{ ok, provider, latencyMs, models, message } }` |
| panel → bg | `OLLAMA_STATUS` | `{ settings?, timeoutMs? }` | `{ ok, online, models, modelMissing, latencyMs, baseUrl }` — drives the status banner |
| panel → bg | `PARSE_LOCAL` | `{ text }` | offline rule-based intent (no model) |
| panel → bg | `GET_TAB_CONTEXT` | – | active tab + detected store + supported flag |
| panel → bg | `RUN_TASK` | `{ text, store?, tabId? }` | `{ ok, taskId }` immediately; results via `SHOPAGENT_RESULT` |
| panel → bg | `STOP_TASK` | `{ taskId, tabId? }` | aborts the pipeline + the content script |
| panel → bg | `GET_LAST_RUN` | – | cached last successful run |
| panel → bg | `OPEN_URL` | `{ url, tabId? }` | navigate / create tab |
| panel → bg | `OPEN_DOCS` | – | open the repo docs |
| panel → bg | `PROXY_CHAT` | `{ messages, json? }` | ad-hoc model call through the worker (CORS-safe) |
| panel → bg | `EXEC_ACTION` | `{ action, params?, product?, tabId? }` | validates against `shared/act.js`: `safe` → runs now; `confirm` → `{ ok, pending, confirmId }`; `blocked`/invalid → refused with guidance |
| panel → bg | `CONFIRM_ACTION` | `{ confirmId, approve }` | executes (or cancels) a pending `confirm` action |
| bg → panel | `SHOPAGENT_PROGRESS` | `{ taskId, status, detail }` | `status` ∈ `thinking, navigating, typing, scrolling, filtering, analyzing, ranking, ready, error, stopped` |
| bg → panel | `SHOPAGENT_STREAM` | `{ taskId, kind: 'delta'|'done'|'error', text, error? }` | live model tokens for question answers (low TTFT) |
| bg → panel | `SHOPAGENT_CONFIRM_REQUEST` | `{ id, action, params, product, fa, en }` | opens the Human-in-the-Loop dialog |
| bg → panel | `SHOPAGENT_CONFIRM_RESULT` | `{ id, ok, result?, error? }` | outcome of the confirmed action |
| bg → panel | `SHOPAGENT_RESULT` | `{ taskId, result }` | the full run result (intent + ranked products) |
| content → bg → panel | `SHOPAGENT_EVENT` → `SHOPAGENT_LIVE_EVENT` | `{ event, data }` | live telemetry: `typing`, `scrolling`, `extracted`, `navigation`, `ready`, `hud-hidden` |
| bg → content | `SHOPAGENT_PING` | – | `{ ok, store, url, cards, hasSearchInput }` |
| bg → content | `SHOPAGENT_PAGE_KIND` | – | `{ ok, url, home, resultsUrl, resultsDom, results, cards }` — the results-page gate |
| bg → content | `SHOPAGENT_SYNC_SETTINGS` | `{ settings }` | push typing speed / HUD / language into the page |
| bg → content | `SHOPAGENT_SEARCH` | `{ query, submit?, speed? }` | human typing + submit; falls back to URL navigation in bg |
| bg → content | `SHOPAGENT_SCROLL` | `{ rounds?, settleMs? }` | soft scroll for lazy loading |
| bg → content | `SHOPAGENT_EXTRACT` | `{ limit? }` | `{ ok, products[], meta }` |
| bg → content | `SHOPAGENT_SORT` | `{ mode }` | clicks the site's own sort UI (best-effort) |
| bg → content | `SHOPAGENT_PRICE_FILTER` | `{ min?, max? }` | fills the site's price inputs (best-effort) |
| bg → content | `SHOPAGENT_ACT` | `{ action, params }` | execute a validated action (`CLICK_TEXT`, `SCROLL`, `ADD_TO_CART`, `GO_NEXT_PAGE`, …). Re-validated in the page: `blocked` actions are refused there too |
| bg → content | `SHOPAGENT_STOP` | – | abort current content action |
| bg → content | `SHOPAGENT_HUD` | `{ show }` | show/hide the on-page HUD |

## Action contract (shared/act.js)

The model never drives the page directly. Every action goes through the
whitelist in `shared/act.js` with three risk levels:

| risk | examples | behaviour |
|---|---|---|
| `safe` | `SEARCH`, `SCROLL`, `EXTRACT`, `SORT`, `PRICE_FILTER`, `CLICK_TEXT`, `GO_NEXT_PAGE`, `OPEN_PRODUCT` | executed immediately |
| `confirm` | `ADD_TO_CART` | executed only after the user approves the side-panel dialog |
| `blocked` | `PAY`, `CHECKOUT`, `PLACE_ORDER`, `CHANGE_ADDRESS`, `PAYMENT_METHOD` | never automated — the user does these on the site |

Unknown actions are rejected, never guessed. The same validator runs in
the background (gate) and inside the content script (defence in depth).

## Why progress is pushed, not polled

A run can outlive several UI repaints and even a service-worker restart.
Pushing `SHOPAGENT_PROGRESS` events keeps the panel, the toolbar badge
and the on-page HUD in lockstep without any polling loop, and means a
panel that is opened mid-run simply resumes listening.

## Failure contract

Every handler resolves — it never throws across the message boundary.
Failures arrive as `{ ok:false, error, aborted? }` and the UI maps known
error codes (`NO_SEARCH_PATH`, `CONTENT_UNREACHABLE`, `NO_TAB`,
`EMPTY_QUERY`, `TIMEOUT:*`) to friendly Persian/English copy.
