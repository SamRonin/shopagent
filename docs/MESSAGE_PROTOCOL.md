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
| panel → bg | `LIST_MODELS` | `{ settings? }` | same as above |
| panel → bg | `PARSE_LOCAL` | `{ text }` | offline rule-based intent (no model) |
| panel → bg | `GET_TAB_CONTEXT` | – | active tab + detected store + supported flag |
| panel → bg | `RUN_TASK` | `{ text, store?, tabId? }` | `{ ok, taskId }` immediately; results via `SHOPAGENT_RESULT` |
| panel → bg | `STOP_TASK` | `{ taskId, tabId? }` | aborts the pipeline + the content script |
| panel → bg | `GET_LAST_RUN` | – | cached last successful run |
| panel → bg | `OPEN_URL` | `{ url, tabId? }` | navigate / create tab |
| panel → bg | `OPEN_DOCS` | – | open the repo docs |
| panel → bg | `GET_PROVIDER_HEALTH` | `{ settings? }` | fast health probe for the status banner → `{ ok, result:{ ok, provider, latencyMs, models, message } }` |
| panel → bg | `ADD_TO_CART` | `{ url?, tabId? }` | opens/uses the product page and runs the guarded add-to-cart (user approval card required) |
| panel → bg | `SHOPAGENT_CONFIRM_RESPONSE` | `{ requestId, approved }` | answers a pending HITL confirmation card |
| bg → panel | `SHOPAGENT_PROGRESS` | `{ taskId, status, detail }` | `status` ∈ `thinking, navigating, typing, scrolling, filtering, analyzing, ranking, ready, error, stopped` |
| bg → panel | `SHOPAGENT_STREAM` | `{ taskId, full, firstTokenMs }` | throttled live model tokens (last 700 chars); `firstTokenMs` on the first tick |
| bg → panel | `SHOPAGENT_CONFIRM_SHOW` | `{ requestId, title, detail, risk, url }` | renders the HITL approval card; 90 s without an answer = denied |
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
| bg → content | `SHOPAGENT_NEXT_PAGE` | – | pagination |
| bg → content | `SHOPAGENT_CLICK_TEXT` | `{ labels, tags? }` | click an element found by its Persian label — risk-assessed first (blocked / confirm / safe) |
| bg → content | `SHOPAGENT_ADD_TO_CART` | – | finds the cart button, asks the panel for approval, clicks, verifies |
| bg → content | `SHOPAGENT_READ_PAGE` | – | sanitised page text for the model |
| bg → content | `SHOPAGENT_READ_PRODUCT` | – | single product page (title/price/specs) |
| bg → content | `SHOPAGENT_STOP` | – | abort current content action |
| bg → content | `SHOPAGENT_HUD` | `{ show }` | show/hide the on-page HUD |

## Why progress is pushed, not polled

A run can outlive several UI repaints and even a service-worker restart.
Pushing `SHOPAGENT_PROGRESS` events keeps the panel, the toolbar badge
and the on-page HUD in lockstep without any polling loop, and means a
panel that is opened mid-run simply resumes listening.

## Human-in-the-Loop confirmation

The content script never trusts a click target blindly:

1. `shared/guardrails.js` classifies the target → `safe` / `confirm` / `blocked`.
2. `blocked` (checkout, address, login, OTP, …) is refused outright.
3. `confirm` (add to cart, buy now, deletes) sends
   `SHOPAGENT_CONFIRM_REQUEST` → the worker relays it as
   `SHOPAGENT_CONFIRM_SHOW` → the panel renders an approval card →
   the answer travels back as `SHOPAGENT_CONFIRM_RESPONSE`.
4. Silence for 90 s, a closed panel, or «لغو» all count as **denied**.

Model output can never inject actions: `shared/schema.js` strips and
flags any `action`/`command`/`click` field an LLM tries to smuggle in.

## LLM output contract

Every model reply passes through `shared/json.js` (repair cascade:
smart quotes → comments → Python literals → trailing commas → unquoted
keys → single quotes) and then `shared/schema.js`. If validation fails,
one auto-repair round re-prompts the model with the exact errors. A
still-invalid answer falls back to the offline rule-based parser and the
run is marked `degraded` with `degradedReason` — visible in the panel.

## Failure contract

Every handler resolves — it never throws across the message boundary.
Failures arrive as `{ ok:false, error, aborted?, friendly? }` where
`friendly` is `{ kind, message, code }` from `shared/errors.js` — a
ready-to-display Persian (or English) explanation. The UI falls back to
its own code map (`NO_SEARCH_PATH`, `CONTENT_UNREACHABLE`, `NO_TAB`,
`EMPTY_QUERY`, `TIMEOUT:*`) and refreshes the provider banner when the
failure looks like the engine being down.
