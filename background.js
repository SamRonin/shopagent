/**
 * ShopAgent — background.js (MV3 service worker)
 * ------------------------------------------------------------------
 * The orchestrator. It owns:
 *
 *   • tab lifecycle (pick / open / focus the right store tab)
 *   • content-script injection + a resilient PING/ACK handshake
 *   • the task pipeline: intent → navigate → type → scroll → filter →
 *     extract → rank
 *   • all model traffic (host permissions live here, so the side panel
 *     and content scripts never have to deal with CORS)
 *   • progress broadcasting to the side panel + toolbar badge
 *   • a keep-alive heartbeat so the SW survives long LLM calls
 *
 * Loaded as a classic worker; shared modules come in via importScripts.
 * ------------------------------------------------------------------
 */

importScripts('shared/utils.js', 'shared/locales.js', 'shared/i18n.js', 'shared/storage.js', 'shared/sites.js', 'shared/llm.js');

const SA = globalThis.ShopAgent;
const log = SA.utils.logger('background');

/** Hosts we are allowed to automate. Mirrors manifest.content_scripts.matches. */
const SUPPORTED_HOSTS = ['digikala.com', 'basalam.com'];

const CONTENT_FILES = ['shared/utils.js', 'shared/sites.js', 'content/content.js'];
const CONTENT_CSS = ['content/content.css'];

/* ================================================================== *
 * Task state
 * ================================================================== */

const tasks = new Map(); // taskId → { status, abort, startedAt, ... }

function newTask() {
  const id = SA.utils.uid('task');
  const abort = new AbortController();
  tasks.set(id, { id, status: 'idle', abort, startedAt: Date.now(), steps: [] });
  return id;
}

function getTask(id) {
  return tasks.get(id);
}

function pruneTasks() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, t] of tasks) if (t.startedAt < cutoff) tasks.delete(id);
}

/** Broadcast a progress event to every listening extension surface. */
function emitProgress(taskId, status, detail, extra = {}) {
  const task = getTask(taskId);
  if (task) {
    task.status = status;
    task.steps.push({ status, detail, at: Date.now() });
    if (task.steps.length > 60) task.steps.shift();
  }
  const payload = { type: 'SHOPAGENT_PROGRESS', taskId, status, detail, at: Date.now(), ...extra };
  chrome.runtime.sendMessage(payload).catch(() => {});
  setBadge(status);
  log.info(`[${taskId}] ${status}${detail ? ` — ${detail}` : ''}`);
}

const BADGE = {
  idle: { text: '', color: '#0f766e' },
  thinking: { text: '···', color: '#0ea5e9' },
  navigating: { text: '→', color: '#8b5cf6' },
  typing: { text: '⌨', color: '#38bdf8' },
  scrolling: { text: '⇕', color: '#a78bfa' },
  analyzing: { text: '◎', color: '#f59e0b' },
  filtering: { text: '⚙', color: '#ec4899' },
  ranking: { text: '★', color: '#22c55e' },
  ready: { text: '✓', color: '#16a34a' },
  error: { text: '!', color: '#ef4444' },
  stopped: { text: '■', color: '#64748b' },
};

function setBadge(status) {
  const b = BADGE[status] || BADGE.idle;
  try {
    chrome.action.setBadgeText({ text: b.text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => {});
  } catch {}
}

/* ================================================================== *
 * Keep-alive: MV3 kills idle service workers after ~30 s. Extension API
 * calls reset that timer, so we tick one while a task is in flight.
 * ================================================================== */

let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.storage.local.get('__ka').catch(() => {});
    if (!tasks.size) stopKeepAlive();
  }, 20000);
  pruneTasks();
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* ================================================================== *
 * Tabs
 * ================================================================== */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function adapterFor(url) {
  return SA.sites.detect(url);
}

function isSupported(url) {
  const host = hostOf(url || '');
  if (!host || !/^https?:/i.test(url || '')) return false;
  return SUPPORTED_HOSTS.some((s) => host === s || host.endsWith('.' + s));
}

/** Find (or create) a tab for the requested store. */
async function resolveTab(store, { focus = true } = {}) {
  const current = await activeTab();

  if (store === 'current') {
    if (!current) throw new Error('NO_TAB');
    return { tab: current, created: false };
  }

  const wanted = SA.sites[store] || SA.sites.digikala;
  const wantedHosts = wanted.hosts || [];

  // 1. The active tab is already the right store.
  if (current && wantedHosts.some((h) => hostOf(current.url || '').endsWith(h))) {
    return { tab: current, created: false };
  }

  // 2. Another tab already has it open.
  const all = await chrome.tabs.query({});
  const existing = all.find((t) => wantedHosts.some((h) => hostOf(t.url || '').endsWith(h)));
  if (existing) {
    if (focus) await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return { tab: existing, created: false };
  }

  // 3. Open a fresh tab.
  const url = wanted.home || 'https://www.digikala.com/';
  const tab = await chrome.tabs.create({ url, active: focus });
  return { tab, created: true };
}

async function waitForTab(tabId, { timeout = 25000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('TAB_GONE');
    if (tab.status === 'complete') return tab;
    await SA.utils.sleep(250);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) return tab;
  throw new Error('TAB_TIMEOUT');
}

/** Make sure the content script is alive on the tab; inject if needed. */
async function ensureContent(tabId, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await sendToContent(tabId, 'PING');
      if (res && res.ok) return res;
    } catch (e) {
      log.debug('ping failed', e?.message);
    }
    if (attempt === retries) break;
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      await SA.utils.sleep(350);
    } catch (e) {
      log.warn('injection failed', e?.message);
      if (attempt === retries) throw new Error(`INJECT_FAILED:${e?.message || e}`);
    }
  }
  throw new Error('CONTENT_UNREACHABLE');
}

function sendToContent(tabId, action, payload = {}, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT:${action}`)), timeoutMs);
    chrome.tabs.sendMessage(tabId, { type: `SHOPAGENT_${action}`, payload }, (response) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || 'NO_RECEIVER'));
      resolve(response);
    });
  });
}

/** Ask the page where we are; degrade to URL-only classification. */
async function pageKindOf(tab) {
  try {
    const k = await sendToContent(tab.id, 'PAGE_KIND', {}, 15000);
    if (k && k.ok) return k;
  } catch (e) {
    log.debug('PAGE_KIND unreachable', e?.message);
  }
  const cls = SA.sites.classifyUrl(tab.url || '');
  return { ok: true, url: tab.url, home: cls.home, resultsUrl: cls.results, resultsDom: false, results: cls.results, unreachable: true };
}

/**
 * HARD GUARANTEE: no scrolling / extraction may happen unless the tab is
 * showing a genuine search-results listing.
 *
 *   1. the live SEARCH already landed on a results URL  → done
 *   2. the tab is already on a results URL (refining)   → done
 *   3. otherwise navigate to the adapter's search URL   → verify again
 *
 * This is what prevents the old failure mode where a submit no-op left
 * the run scrolling the Digikala homepage.
 */
async function ensureOnResultsPage(tab, adapter, settings, { liveSearch, templates, onStatus } = {}) {
  const lang = settings.language || 'fa';

  if (liveSearch && liveSearch.ok && liveSearch.resultsPage) return { ok: true, tab };

  let kind = await pageKindOf(tab);
  if (kind.results) return { ok: true, tab };

  const target = templates && templates.length ? templates[0] : null;
  if (!target) {
    // Unknown store: the live submit was our only chance.
    return kind.results ? { ok: true, tab } : { ok: false, error: 'NO_SEARCH_PATH', tab };
  }

  onStatus?.('navigating', lang === 'fa' ? 'رفتن مستقیم به صفحهٔ نتایج جستجو' : 'Going straight to the search results');
  await chrome.tabs.update(tab.id, { url: target });
  tab = await waitForTab(tab.id, { timeout: 30000 });
  await ensureContent(tab.id);
  await SA.utils.sleep(900);

  kind = await pageKindOf(tab);
  if (kind.results) return { ok: true, tab };

  // One retry with the adapter's second URL template.
  if (templates[1]) {
    await chrome.tabs.update(tab.id, { url: templates[1] });
    tab = await waitForTab(tab.id, { timeout: 30000 });
    await ensureContent(tab.id);
    await SA.utils.sleep(900);
    kind = await pageKindOf(tab);
    if (kind.results) return { ok: true, tab };
  }

  return { ok: false, error: 'NOT_ON_RESULTS_PAGE', tab };
}

/* ================================================================== *
 * The pipeline
 * ================================================================== */

async function runTask(taskId, { text, store, tabId, settings }) {
  const task = getTask(taskId);
  if (!task) throw new Error('NO_TASK');
  const signal = task.abort.signal;
  const startedAt = Date.now();
  const lang = settings.language || 'fa';

  startKeepAlive();

  try {
    /* ---------- 1. Understand the request ---------- */
    emitProgress(taskId, 'thinking', lang === 'fa' ? 'دستورت رو تحلیل می‌کنم…' : 'Understanding your request…');
    const intent = await SA.llm.parseIntent(text, settings, { signal });
    emitProgress(taskId, 'thinking', intent.explanation || intent.query, { intent });

    if (intent.intent === 'unknown' || !intent.query) {
      emitProgress(taskId, 'error', lang === 'fa' ? 'نتونستم بفهمم دنبال چه کالایی هستی.' : 'Could not identify a product in your request.');
      return { ok: false, error: 'EMPTY_QUERY', intent, products: [] };
    }

    /* ---------- 2. Resolve the tab ---------- */
    const wantedStore = intent.targetStore || store || settings.preferredStore || 'digikala';
    emitProgress(taskId, 'navigating', lang === 'fa' ? `باز کردن ${wantedStore === 'basalam' ? 'باسلام' : 'دیجی‌کالا'}` : `Opening ${wantedStore}`);

    let tab;
    try {
      const resolved = await resolveTab(wantedStore);
      tab = tabId ? await chrome.tabs.get(tabId).catch(() => resolved.tab) : resolved.tab;
      tab = await waitForTab(tab.id);
    } catch (e) {
      emitProgress(taskId, 'error', String(e.message || e));
      return { ok: false, error: 'TAB_ERROR', detail: String(e.message || e), intent, products: [] };
    }

    // Re-read settings in case they changed mid-flight.
    await sendToContent(tab.id, 'SYNC_SETTINGS', {
      settings: {
        typingSpeed: settings.typingSpeed,
        liveHud: settings.liveHud,
        autoScroll: settings.autoScroll,
        language: settings.language,
        maxResults: settings.maxResults,
      },
    }).catch(() => {});

    const ping = await ensureContent(tab.id);
    log.info('content ready on', ping.store, ping.url);

    /* ---------- 3. Search: type it live ---------- */
    const adapter = SA.sites[ping.store] || SA.sites.detect(tab.url);
    const templates = typeof adapter.searchUrl === 'function' ? adapter.searchUrl(intent.query) : [];
    let searchResult = null;

    if (adapter.id === wantedStore || wantedStore === 'current') {
      emitProgress(taskId, 'typing', `«${intent.query}»`, { query: intent.query });
      try {
        searchResult = await sendToContent(tab.id, 'SEARCH', { query: intent.query, submit: true, speed: settings.typingSpeed }, 60000);
      } catch (e) {
        log.warn('live typing failed:', e?.message);
        searchResult = { ok: false, reason: String(e?.message || e) };
      }
      if (searchResult && !searchResult.ok) {
        log.warn('live search reported:', searchResult.reason || 'failed', '→ results-page gate will take over');
      }
    }

    // A full navigation kills the old content script: make sure the page
    // we are about to verify has a live executor.
    await ensureContent(tab.id).catch((e) => log.warn('re-ensure after search failed', e?.message));

    /* ---------- 3b. HARD GATE: we must be on a results page ---------- */
    const gate = await ensureOnResultsPage(tab, adapter, settings, {
      liveSearch: searchResult,
      templates,
      onStatus: (status, detail) => emitProgress(taskId, status, detail),
    });

    if (!gate.ok) {
      emitProgress(taskId, 'error', lang === 'fa' ? 'نتوانستم به صفحهٔ نتایج جستجو بروم.' : 'Could not reach a search-results page.');
      return { ok: false, error: gate.error || 'NO_SEARCH_PATH', intent, products: [] };
    }
    tab = gate.tab || tab;

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    /* ---------- 4. Scroll so lazy content loads ---------- */
    if (settings.autoScroll !== false) {
      emitProgress(taskId, 'scrolling', lang === 'fa' ? 'دارم صفحه رو نرم اسکرول می‌کنم تا همه کالاها لود بشن' : 'Soft-scrolling to load every product');
      await sendToContent(tab.id, 'SCROLL', { rounds: 4, settleMs: 500 }, 60000).catch((e) => log.warn('scroll failed', e?.message));
    }

    /* ---------- 5. Best-effort site-level sorting & price filter ---------- */
    if (intent.sort && intent.sort !== 'best_match') {
      emitProgress(taskId, 'filtering', lang === 'fa' ? `مرتب‌سازی: ${intent.sort}` : `Sorting: ${intent.sort}`);
      const sortRes = await sendToContent(tab.id, 'SORT', { mode: intent.sort }, 25000).catch(() => ({ ok: false }));
      if (sortRes?.ok) await SA.utils.sleep(900);
      log.info('site sort:', sortRes?.method || 'fallback to client-side sorting');
    }

    if (intent.minPrice || intent.maxPrice) {
      emitProgress(taskId, 'filtering', lang === 'fa' ? 'اعمال فیلتر قیمت' : 'Applying price filter');
      await sendToContent(tab.id, 'PRICE_FILTER', { min: intent.minPrice, max: intent.maxPrice }, 30000).catch(() => ({ ok: false }));
      await SA.utils.sleep(900);
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    /* ---------- 6. Extract ---------- */
    emitProgress(taskId, 'analyzing', lang === 'fa' ? 'خوندن قیمت‌ها و مشخصات' : 'Reading prices and specs');
    const extraction = await sendToContent(tab.id, 'EXTRACT', { limit: 80 }, 60000);
    if (!extraction || !extraction.ok) {
      emitProgress(taskId, 'error', extraction?.error || 'EXTRACT_FAILED');
      return { ok: false, error: 'EXTRACT_FAILED', intent, products: [] };
    }

    let products = extraction.products || [];
    emitProgress(taskId, 'analyzing', lang === 'fa' ? `${products.length} کالا استخراج شد` : `${products.length} products extracted`, { count: products.length });

    if (!products.length) {
      emitProgress(taskId, 'ready', lang === 'fa' ? 'کالایی پیدا نشد' : 'No products found');
      return { ok: true, intent, products: [], meta: extraction.meta, empty: true };
    }

    // Hard client-side budget guard (the site filter is best-effort only).
    if (intent.maxPrice) {
      const inBudget = products.filter((p) => p.price && p.price <= intent.maxPrice);
      if (inBudget.length >= 2) products = inBudget;
    }
    if (intent.minPrice) {
      const above = products.filter((p) => p.price && p.price >= intent.minPrice);
      if (above.length >= 2) products = above;
    }
    products = products.filter((p) => p.inStock !== false);

    /* ---------- 7. Rank ---------- */
    emitProgress(taskId, 'ranking', lang === 'fa' ? 'انتخاب بهترین گزینه‌ها' : 'Picking the best options');
    const maxPicks = intent.maxResults || settings.maxResults || 6;
    const ranked = await SA.llm.rankProducts(products, intent, {
      settings,
      userText: text,
      lang,
      maxPicks,
      signal,
    });

    const durationMs = Date.now() - startedAt;
    const payload = {
      ok: true,
      intent,
      products: ranked,
      allCount: (extraction.products || []).length,
      meta: { ...(extraction.meta || {}), durationMs, engine: intent.source, model: intent.model || null },
      taskId,
      query: text,
      at: Date.now(),
    };

    emitProgress(taskId, 'ready', lang === 'fa' ? `${ranked.length} پیشنهاد آماده شد` : `${ranked.length} picks ready`, { count: ranked.length });
    chrome.storage.local.set({ lastRun: payload }).catch(() => {});
    SA.store.pushHistory({ query: text, intent: { ...intent }, count: ranked.length, durationMs }).catch(() => {});

    return payload;
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /aborted|stopped/i.test(String(err?.message || err));
    emitProgress(taskId, aborted ? 'stopped' : 'error', String(err?.message || err).slice(0, 160));
    log.error('task failed', err);
    return { ok: false, aborted, error: String(err?.message || err) };
  } finally {
    stopKeepAlive();
    setTimeout(() => setBadge('idle'), 4000);
  }
}

/* ================================================================== *
 * Message routing
 * ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  // Content scripts relay their own live events straight to the UI.
  if (msg.type === 'SHOPAGENT_EVENT') {
    chrome.runtime.sendMessage({ type: 'SHOPAGENT_LIVE_EVENT', ...msg, tabId: sender.tab?.id }).catch(() => {});
    return false;
  }

  (async () => {
    try {
      switch (msg.type) {
        case 'GET_SETTINGS':
          sendResponse({ ok: true, settings: await SA.store.getSettings() });
          break;

        case 'SAVE_SETTINGS':
          sendResponse({ ok: true, settings: await SA.store.saveSettings(msg.settings || {}) });
          break;

        case 'RESET_SETTINGS':
          await SA.store.resetAll();
          sendResponse({ ok: true, settings: await SA.store.getSettings() });
          break;

        case 'GET_HISTORY':
          sendResponse({ ok: true, history: await SA.store.getHistory(20) });
          break;

        case 'CLEAR_HISTORY':
          await SA.store.clearHistory();
          sendResponse({ ok: true });
          break;

        case 'TEST_CONNECTION': {
          const settings = msg.settings || (await SA.store.getSettings());
          const result = await SA.llm.testConnection(settings);
          sendResponse({ ok: result.ok, result });
          break;
        }

        case 'LIST_MODELS': {
          const settings = msg.settings || (await SA.store.getSettings());
          const result = await SA.llm.listModels(settings);
          sendResponse({ ok: result.ok, result });
          break;
        }

        case 'PARSE_LOCAL': {
          // Instant, offline preview of what the rule-based parser sees.
          const settings = await SA.store.getSettings();
          sendResponse({ ok: true, intent: SA.llm.builtinParseIntent(msg.text || '', settings) });
          break;
        }

        case 'GET_TAB_CONTEXT': {
          const tab = await activeTab();
          const adapter = tab ? adapterFor(tab.url) : null;
          sendResponse({
            ok: true,
            tab: tab ? { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, status: tab.status } : null,
            store: adapter ? { id: adapter.id, label: adapter.label, supported: isSupported(tab?.url || '') } : null,
            stores: SA.sites.list(),
          });
          break;
        }

        case 'RUN_TASK': {
          const settings = await SA.store.getSettings();
          const taskId = newTask();
          sendResponse({ ok: true, taskId });
          // Fire and forget — progress arrives via SHOPAGENT_PROGRESS.
          runTask(taskId, {
            text: msg.text,
            store: msg.store || settings.preferredStore,
            tabId: msg.tabId,
            settings,
          }).then((result) => {
            chrome.runtime.sendMessage({ type: 'SHOPAGENT_RESULT', taskId, result }).catch(() => {});
          });
          break;
        }

        case 'STOP_TASK': {
          const task = getTask(msg.taskId) || [...tasks.values()].pop();
          if (task) {
            task.abort.abort(new Error('STOPPED'));
            if (msg.tabId) await sendToContent(msg.tabId, 'STOP').catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        case 'GET_LAST_RUN': {
          const res = await chrome.storage.local.get('lastRun').catch(() => ({}));
          sendResponse({ ok: true, lastRun: res.lastRun || null });
          break;
        }

        case 'OPEN_URL': {
          if (msg.tabId) await chrome.tabs.update(msg.tabId, { url: msg.url, active: true }).catch(() => {});
          else await chrome.tabs.create({ url: msg.url, active: msg.active !== false });
          sendResponse({ ok: true });
          break;
        }

        case 'OPEN_DOCS':
          await chrome.tabs.create({ url: msg.url || 'https://github.com/SamRonin/shopagent#ollama--راه‌اندازی-مدل-لوکال' });
          sendResponse({ ok: true });
          break;

        case 'SHOPAGENT_SETTINGS_CHANGED':
          // Emitted by shared/storage.js whenever another surface saves.
          log.debug('settings changed elsewhere');
          sendResponse({ ok: true });
          break;

        case 'PROXY_CHAT': {
          // Exposed so the side panel can ask the model ad-hoc questions.
          const settings = await SA.store.getSettings();
          const res = await SA.llm.chat(settings, {
            messages: msg.messages || [],
            json: msg.json !== false,
            temperature: msg.temperature,
          });
          sendResponse(res);
          break;
        }

        default:
          sendResponse({ ok: false, error: `UNKNOWN:${msg.type}` });
      }
    } catch (err) {
      log.error('router error', msg?.type, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // async response
});

/* ================================================================== *
 * Lifecycle
 * ================================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info('installed', details.reason);
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    log.debug('sidePanel behaviour not available', e?.message);
  }
  const settings = await SA.store.getSettings();
  if (!settings.ollama?.baseUrl) await SA.store.saveSettings({ ollama: { baseUrl: 'http://localhost:11434' } });
  setBadge('idle');
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});

// Make the toolbar icon open the side panel (belt & braces with the above).
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    log.debug('sidePanel.open failed', e?.message);
  }
});

// NOTE: no `webNavigation` listener on purpose. The declarative
// `content_scripts` entry in manifest.json covers every store navigation,
// and `ensureContent()` re-injects programmatically whenever a PING fails
// (e.g. a tab that was already open before the extension was installed).
// This keeps the permission set minimal: activeTab, scripting, storage,
// sidePanel, tabs.

setBadge('idle');
log.info('service worker booted');
