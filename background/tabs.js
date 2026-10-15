/**
 * ShopAgent — background/tabs.js
 * ------------------------------------------------------------------
 * Tab lifecycle: pick / open / focus the right store tab, wait for
 * loads, (re)inject the content script and — critically — the HARD
 * GATE that guarantees no scrolling/extraction happens off a genuine
 * search-results page.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const bg = (ShopAgent.bg = ShopAgent.bg || {});
  const { sleep } = ShopAgent.utils;
  const log = ShopAgent.utils.logger('bg.tabs');

  /** Hosts we are allowed to automate. Mirrors manifest.content_scripts.matches. */
  const SUPPORTED_HOSTS = ['digikala.com', 'basalam.com'];

  const CONTENT_FILES = ['shared/utils.js', 'shared/sites.js', 'shared/guardrails.js', 'content/content.js'];
  const CONTENT_CSS = ['content/content.css'];

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

  function isSupported(url) {
    const host = hostOf(url || '');
    if (!host || !/^https?:/i.test(url || '')) return false;
    return SUPPORTED_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
  }

  /** Find (or create) a tab for the requested store. */
  async function resolveTab(store, { focus = true } = {}) {
    const current = await activeTab();

    if (store === 'current') {
      if (!current) throw new Error('NO_TAB');
      return { tab: current, created: false };
    }

    const wanted = ShopAgent.sites[store] || ShopAgent.sites.digikala;
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
    for (;;) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error('TAB_GONE');
      if (tab.status === 'complete') return tab;
      if (Date.now() > deadline) return tab;
      await sleep(250);
    }
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
        await sleep(350);
      } catch (e) {
        log.warn('injection failed', e?.message);
        if (attempt === retries) throw new Error(`INJECT_FAILED:${e?.message || e}`);
      }
    }
    throw new Error('CONTENT_UNREACHABLE');
  }

  /** Ask the page where we are; degrade to URL-only classification. */
  async function pageKindOf(tab) {
    try {
      const k = await sendToContent(tab.id, 'PAGE_KIND', {}, 15000);
      if (k && k.ok) return k;
    } catch (e) {
      log.debug('PAGE_KIND unreachable', e?.message);
    }
    const cls = ShopAgent.sites.classifyUrl(tab.url || '');
    return { ok: true, url: tab.url, home: cls.home, resultsUrl: cls.results, resultsDom: false, results: cls.results, unreachable: true };
  }

  /**
   * HARD GUARANTEE: no scrolling / extraction may happen unless the tab
   * shows a genuine search-results listing.
   *   1. the live SEARCH already landed on a results URL  → done
   *   2. the tab is already on a results URL (refining)   → done
   *   3. navigate to the adapter's search URL             → verify again
   */
  async function ensureOnResultsPage(tab, adapter, settings, { liveSearch, templates, onStatus } = {}) {
    const lang = settings.language || 'fa';

    if (liveSearch && liveSearch.ok && liveSearch.resultsPage) return { ok: true, tab };

    let kind = await pageKindOf(tab);
    if (kind.results) return { ok: true, tab };

    const target = templates && templates.length ? templates[0] : null;
    if (!target) {
      return kind.results ? { ok: true, tab } : { ok: false, error: 'NO_SEARCH_PATH', tab };
    }

    onStatus?.('navigating', lang === 'fa' ? 'رفتن مستقیم به صفحهٔ نتایج جستجو' : 'Going straight to the search results');
    await chrome.tabs.update(tab.id, { url: target });
    tab = await waitForTab(tab.id, { timeout: 30000 });
    await ensureContent(tab.id);
    await sleep(900);

    kind = await pageKindOf(tab);
    if (kind.results) return { ok: true, tab };

    // One retry with the adapter's second URL template.
    if (templates[1]) {
      await chrome.tabs.update(tab.id, { url: templates[1] });
      tab = await waitForTab(tab.id, { timeout: 30000 });
      await ensureContent(tab.id);
      await sleep(900);
      kind = await pageKindOf(tab);
      if (kind.results) return { ok: true, tab };
    }

    return { ok: false, error: 'NOT_ON_RESULTS_PAGE', tab };
  }

  bg.tabs = { SUPPORTED_HOSTS, CONTENT_FILES, CONTENT_CSS, activeTab, hostOf, isSupported, resolveTab, waitForTab, sendToContent, ensureContent, pageKindOf, ensureOnResultsPage };
})(globalThis);
