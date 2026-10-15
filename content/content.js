/**
 * ShopAgent — content/content.js
 * ------------------------------------------------------------------
 * The Action Executor — now a thin orchestrator. Injected into store
 * pages (Digikala / Basalam) and responsible for routing validated
 * actions to the modules under content/actions/:
 *
 *   actions/dom.js       visibility, tiered queries, waitFor/retry
 *   actions/interact.js  typing, submit, scroll, sort, buy actions
 *   actions/extract.js   product + price extraction
 *   actions/hud.js       the on-page "see it happen" layer
 *   adapters/*.js        per-store selectors + button discovery tiers
 *
 * This file never talks to a model and never touches the network.
 * It owns only the message table, the per-action abort controller and
 * the runtime context (`ctx`) handed to the action modules.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  if (window.__SHOPAGENT_CONTENT_LOADED__) return;
  window.__SHOPAGENT_CONTENT_LOADED__ = true;

  const SA = globalThis.ShopAgent || {};
  const utils = SA.utils || {};
  const sites = SA.sites || {};
  const log = utils.logger('content');
  const adapter = sites.detect ? sites.detect(location.href) : { id: 'generic', label: '', selectors: {}, labels: {} };

  /* ================================================================== *
   * State + runtime context
   * ================================================================== */

  const state = {
    settings: { typingSpeed: 'normal', liveHud: true, autoScroll: true, maxResults: 6, language: 'fa' },
    running: false,
    abortController: null,
    lastExtraction: [],
  };

  function isAborted() {
    return state.abortController?.signal?.aborted === true;
  }

  function throwIfAborted() {
    if (isAborted()) throw new DOMException('Aborted', 'AbortError');
  }

  /** The single object every action module receives. */
  const ctx = {
    adapter,
    get settings() {
      return state.settings;
    },
    get signal() {
      return state.abortController?.signal;
    },
    isAborted,
    throwIfAborted,
    emit,
    lastExtraction: [],
  };

  function emit(event, data) {
    try {
      chrome.runtime?.sendMessage({ type: 'SHOPAGENT_EVENT', event, data, url: location.href, at: Date.now() }).catch(() => {});
    } catch {}
  }

  /* ================================================================== *
   * Action dispatcher (validated `ACT` protocol)
   * ================================================================== */

  const { dom, interact, extract, hud } = SA.actions;

  async function runValidatedAction(action, params) {
    switch (action) {
      case 'CLICK_TEXT':
        return interact.clickText(ctx, params);
      case 'SCROLL':
        return interact.softScroll(ctx, params || {});
      case 'ADD_TO_CART':
        return interact.addToCart(ctx);
      case 'GO_NEXT_PAGE':
        return interact.goNextPage(ctx);
      case 'SORT':
        return interact.applySort(ctx, params?.mode);
      case 'PRICE_FILTER':
        return interact.applyPriceFilter(ctx, params?.min, params?.max);
      case 'EXTRACT':
        return extract.extractProducts(ctx, params || {});
      case 'SEARCH':
        return doSearch(params || {});
      default:
        // PAY / CHECKOUT / CHANGE_ADDRESS / PLACE_ORDER never reach here:
        // shared/actions.js marks them `blocked` and the background
        // refuses them. This branch is defence in depth.
        return { ok: false, error: 'ACTION_BLOCKED', action };
    }
  }

  async function doSearch({ query, submit = true, speed }) {
    hud.setStatus?.('typing');
    const kindBefore = interact.pageKind();
    const found = dom.findSearchInput(adapter);
    if (!found.el) {
      hud.fail?.('کادر جستجو پیدا نشد');
      return { ok: false, reason: 'NO_SEARCH_INPUT', url: location.href, resultsPage: kindBefore.results, home: kindBefore.home };
    }
    await interact.typeHuman(ctx, found.el, query, { speed });
    if (!submit) return { ok: true, method: found.method, submitted: false };

    const res = await interact.submitSearch(ctx, found.el);
    if (!res.ok) hud.fail?.('به صفحهٔ نتایج نرفتیم');
    else hud.setStatus?.('ready', res.cards ? `${res.cards} کالا` : '');
    return { ...res, method: found.method, wasHome: kindBefore.home };
  }

  /* ================================================================== *
   * Message table
   * ================================================================== */

  const handlers = {
    PING: async () => ({
      ok: true,
      url: location.href,
      title: document.title,
      store: adapter.id,
      storeLabel: adapter.label,
      ready: document.readyState === 'complete',
      cards: dom.findProductCards(adapter, 500).length,
      hasSearchInput: Boolean(dom.findSearchInput(adapter).el),
    }),

    SYNC_SETTINGS: async ({ settings }) => {
      if (settings) state.settings = { ...state.settings, ...settings };
      hud.setEnabled(state.settings.liveHud !== false);
      return { ok: true, settings: state.settings };
    },

    SEARCH: async (payload) => doSearch(payload),

    SCROLL: async (payload) => interact.softScroll(ctx, payload),

    EXTRACT: async (payload) => {
      const res = await extract.extractProducts(ctx, payload);
      state.lastExtraction = ctx.lastExtraction;
      return res;
    },

    SORT: async ({ mode }) => interact.applySort(ctx, mode),

    PRICE_FILTER: async ({ min, max }) => interact.applyPriceFilter(ctx, min, max),

    /** Where are we? The background uses this as the results-page gate. */
    PAGE_KIND: async () => ({ ok: true, ...interact.pageKind(), cards: dom.findProductCards(adapter, 300).length }),

    /**
     * Execute a validated action. Validation happens in the background
     * (shared/actions.js); it is repeated here so a compromised or
     * outdated message can never drive a dangerous action.
     */
    ACT: async ({ action, params }) => {
      const verdict = SA.act ? SA.act.validate({ action, params }) : { ok: false, error: 'NO_VALIDATOR' };
      if (!verdict.ok) return { ok: false, error: verdict.error, risk: verdict.risk || 'invalid' };
      if (verdict.risk === 'blocked') return { ok: false, error: 'ACTION_BLOCKED', action: verdict.action };
      return runValidatedAction(verdict.action, verdict.params);
    },

    STOP: async () => {
      state.abortController?.abort(new Error('STOPPED'));
      state.running = false;
      hud.setStatus?.('stopped');
      return { ok: true };
    },

    HUD: async ({ show }) => {
      state.settings.liveHud = Boolean(show);
      hud.setEnabled(state.settings.liveHud);
      if (show) hud.setStatus?.('idle');
      return { ok: true };
    },
  };

  chrome.runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type || !msg.type.startsWith('SHOPAGENT_')) return false;
    const action = msg.type.replace('SHOPAGENT_', '');
    const handler = handlers[action];
    if (!handler) {
      sendResponse({ ok: false, error: `UNKNOWN_ACTION:${action}` });
      return false;
    }

    state.running = true;
    state.abortController = new AbortController();

    Promise.resolve()
      .then(() => handler(msg.payload || {}))
      .then((result) => {
        state.running = false;
        sendResponse(result);
      })
      .catch((err) => {
        state.running = false;
        const aborted = err?.name === 'AbortError' || /aborted|stopped/i.test(String(err?.message || err));
        if (aborted) hud.setStatus?.('stopped');
        else hud.fail?.(String(err?.message || err).slice(0, 80));
        log.error(`action ${action} failed`, err);
        sendResponse({ ok: false, aborted, error: String(err?.message || err) });
      });

    return true; // keep the message channel open for the async response
  });

  /* ================================================================== *
   * Boot
   * ================================================================== */

  SA.actions.onHudHidden = () => {
    state.settings.liveHud = false;
    emit('hud-hidden', {});
  };

  function boot() {
    log.info(`ready on ${adapter.id} · ${location.href}`);
    // Pull the persisted preferences so the HUD & typing speed match settings.
    try {
      chrome.storage?.sync.get('settings', (res) => {
        const s = res?.settings;
        if (s) state.settings = { ...state.settings, ...s };
        hud.setEnabled(state.settings.liveHud !== false);
      });
    } catch {}

    if (state.settings.liveHud) {
      // Only announce ourselves once the page has settled.
      setTimeout(() => {
        hud.setStatus?.('idle', '');
        setTimeout(() => hud.root?.classList.add('sa-hud-fade'), 2600);
      }, 1200);
    }

    emit('ready', { store: adapter.id, url: location.href });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // SPA navigations: re-announce so the side panel always knows the truth.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log.info('SPA navigation →', lastUrl);
      emit('navigation', { url: lastUrl, store: sites.detect ? sites.detect(lastUrl).id : 'generic' });
      if (state.settings.liveHud) hud.setStatus?.('idle', '');
    }
  }, 900);
})();
