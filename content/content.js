/**
 * ShopAgent — content/content.js
 * ------------------------------------------------------------------
 * Thin orchestrator. Injection point for every store page:
 *
 *   • builds the runtime context (settings / abort / emit)
 *   • wires the message router to the modules in content/actions/*
 *   • boots the HUD and watches SPA navigations
 *
 * All DOM logic lives in content/actions/*, all store knowledge in
 * content/adapters/*, all safety rules in shared/guardrails.js.
 * This file never talks to a model and never touches the network.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  if (window.__SHOPAGENT_CONTENT_LOADED__) return;
  window.__SHOPAGENT_CONTENT_LOADED__ = true;

  const SA = globalThis.ShopAgent;
  const { normalizeText, logger } = SA.utils;
  const log = logger('content');
  const adapter = SA.adapters.current();

  /* ================================================================== *
   * Runtime context — the single object every action module reads.
   * ================================================================== */

  const state = {
    settings: { typingSpeed: 'normal', liveHud: true, autoScroll: true, maxResults: 6, language: 'fa' },
    running: false,
    abortController: null,
    lastExtraction: [],
  };

  const runtime = {
    settings: state.settings,
    lastExtraction: state.lastExtraction,
    get abortController() {
      return state.abortController;
    },
    isAborted: () => state.abortController?.signal?.aborted === true,
    throwIfAborted() {
      if (state.abortController?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    },
    emit(event, data) {
      try {
        chrome.runtime?.sendMessage({ type: 'SHOPAGENT_EVENT', event, data, url: location.href, at: Date.now() }).catch(() => {});
      } catch {}
    },
  };

  // One binding, used lazily by every action module.
  SA.actions.dom.bind(runtime);

  /* ================================================================== *
   * Message handlers — one line per action; bodies live in modules.
   * ================================================================== */

  const handlers = {
    PING: async () => ({
      ok: true,
      url: location.href,
      title: document.title,
      store: adapter.id,
      storeLabel: adapter.label,
      ready: document.readyState === 'complete',
      cards: SA.actions.dom.findProductCards(adapter, 500).length,
      hasSearchInput: Boolean(SA.actions.dom.findSearchInput(adapter).el),
    }),

    SYNC_SETTINGS: async ({ settings }) => {
      if (settings) Object.assign(state.settings, settings);
      if (state.settings.liveHud === false) SA.actions.hud.remove();
      return { ok: true, settings: state.settings };
    },

    SEARCH: async ({ query, submit = true, speed }) => {
      const hud = SA.actions.hud;
      const click = SA.actions.click;
      hud.setStatus('typing');
      const kindBefore = click.pageKind();
      const found = SA.actions.dom.findSearchInput(adapter);
      if (!found.el) {
        hud.fail('کادر جستجو پیدا نشد');
        return { ok: false, reason: 'NO_SEARCH_INPUT', url: location.href, resultsPage: kindBefore.results, home: kindBefore.home };
      }
      await SA.actions.events.typeHuman(found.el, query, { speed });
      if (!submit) return { ok: true, method: found.method, submitted: false };

      const res = await click.submitSearch(found.el, adapter);
      if (!res.ok) hud.fail('به صفحهٔ نتایج نرفتیم');
      else hud.setStatus('ready', res.cards ? `${res.cards} کالا` : '');
      return { ...res, method: found.method, wasHome: kindBefore.home };
    },

    SUBMIT_SEARCH: async () => {
      const found = SA.actions.dom.findSearchInput(adapter);
      if (!found.el) return { ok: false, reason: 'NO_SEARCH_INPUT' };
      return SA.actions.click.submitSearch(found.el, adapter);
    },

    SCROLL: async (payload) => SA.actions.scroll.softScroll(payload),

    EXTRACT: async (payload) => SA.actions.extract.extractProducts(adapter, payload),

    SORT: async ({ mode }) => SA.actions.click.applySort(mode, adapter),

    PRICE_FILTER: async ({ min, max }) => SA.actions.click.applyPriceFilter(min, max, adapter),

    NEXT_PAGE: async () => SA.actions.click.goNextPage(adapter),

    CLICK_TEXT: async ({ labels, tags }) => SA.actions.click.clickText(labels, tags),

    ADD_TO_CART: async () => SA.actions.cart.addToCart(adapter),

    /** Where are we? The background uses this as the results-page gate. */
    PAGE_KIND: async () => ({ ok: true, ...SA.actions.click.pageKind(), cards: SA.actions.dom.findProductCards(adapter, 300).length }),

    READ_PAGE: async () => {
      const main = document.querySelector('main, #main, [role="main"]') || document.body;
      return {
        ok: true,
        title: document.title,
        url: location.href,
        text: normalizeText(main.innerText || '').slice(0, 8000),
        h: Array.from(main.querySelectorAll('h1,h2,h3')).map((x) => normalizeText(x.textContent)).slice(0, 25),
      };
    },

    READ_PRODUCT: async () => SA.actions.extract.readProductPage(adapter),

    STOP: async () => {
      state.abortController?.abort(new Error('STOPPED'));
      state.running = false;
      SA.actions.hud.setStatus('stopped');
      return { ok: true };
    },

    HUD: async ({ show }) => {
      state.settings.liveHud = Boolean(show);
      if (show) SA.actions.hud.setStatus('idle');
      else SA.actions.hud.remove();
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
        if (aborted) SA.actions.hud.setStatus('stopped');
        else SA.actions.hud.fail(String(err?.message || err).slice(0, 80));
        log.error(`action ${action} failed`, err);
        sendResponse({ ok: false, aborted, error: String(err?.message || err) });
      });

    return true; // keep the message channel open for the async response
  });

  /* ================================================================== *
   * Boot
   * ================================================================== */

  function boot() {
    log.info(`ready on ${adapter.id} · ${location.href}`);
    // Pull the persisted preferences so the HUD & typing speed match settings.
    try {
      chrome.storage?.sync.get('settings', (res) => {
        const s = res?.settings;
        if (s) Object.assign(state.settings, s);
      });
    } catch {}

    if (state.settings.liveHud) {
      // Only announce ourselves once the page has settled.
      setTimeout(() => {
        SA.actions.hud.setStatus('idle', '');
        setTimeout(() => SA.actions.hud.root?.classList.add('sa-hud-fade'), 2600);
      }, 1200);
    }

    runtime.emit('ready', { store: adapter.id, url: location.href });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // SPA navigations: re-announce so the side panel always knows the truth.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log.info('SPA navigation →', lastUrl);
      runtime.emit('navigation', { url: lastUrl, store: SA.sites.detect(lastUrl).id });
      if (state.settings.liveHud) SA.actions.hud.setStatus('idle', '');
    }
  }, 900);
})();
