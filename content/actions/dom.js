/**
 * ShopAgent — content/actions/dom.js
 * ------------------------------------------------------------------
 * The resilient element-discovery core. Every lookup goes through
 * *fallback chains*: declared (per-site) selectors → semantic attributes
 * (data-testid / ARIA / name) → text matching → structural heuristics.
 *
 * Also owns waitFor(): a polling discovery loop with smart back-off for
 * elements that materialise through lazy loading — replaces the old
 * "click and pray" pattern.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, toEnglishDigits, sleep } = ShopAgent.utils;
  const adapters = ShopAgent.adapters;
  const log = ShopAgent.utils.logger('dom');

  /** Runtime context injected by content.js (settings + abort helpers). */
  let runtime = null;
  function bind(rt) {
    runtime = rt;
  }

  /* ------------------------------------------------------------------ *
   * Visibility & basic queries
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
  }

  /** Try each selector in order; ignore invalid ones instead of crashing. */
  function queryFirst(selectors, scope = document, { visibleOnly = true } = {}) {
    if (!Array.isArray(selectors)) return null;
    for (const sel of selectors) {
      try {
        for (const el of scope.querySelectorAll(sel)) {
          if (!visibleOnly || isVisible(el)) return el;
        }
      } catch (e) {
        log.debug('bad selector skipped:', sel, e.message);
      }
    }
    return null;
  }

  function queryAll(selectors, scope = document) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(selectors)) return out;
    for (const sel of selectors) {
      try {
        for (const el of scope.querySelectorAll(sel)) {
          if (!seen.has(el) && isVisible(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch {}
    }
    return out;
  }

  /** Find a clickable element whose visible text matches one of the labels. */
  function findByText(labels, scope = document, { tags = 'a,button,span,div,label,li,option' } = {}) {
    if (!labels || !labels.length) return null;
    const wanted = labels.map((l) => normalizeText(toEnglishDigits(l))).filter(Boolean);
    if (!wanted.length) return null;
    let nodes;
    try {
      nodes = scope.querySelectorAll(tags);
    } catch {
      return null;
    }
    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      const txt = normalizeText(el.textContent || '');
      if (!txt || txt.length > 60) continue;
      for (const w of wanted) {
        if (txt === w || txt.includes(w)) {
          const clickable = el.closest('a,button,[role="button"],label,li,option') || el;
          if (!isVisible(clickable)) continue;
          const score = (txt === w ? 100 : 60) + (txt.length < w.length + 12 ? 20 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = clickable;
          }
        }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * waitFor — discovery with timeout + adaptive polling (lazy-load safe)
   * ------------------------------------------------------------------ */

  /**
   * Poll for an element without freezing the page.
   * @param {() => *|null} finder zero-arg discovery function
   * @param {{timeout?:number, interval?:number, backoff?:number, signal?:AbortSignal}} [opts]
   * @returns {Promise<*|null>} first truthy result, or null on timeout
   */
  async function waitFor(finder, { timeout = 6000, interval = 220, backoff = 1.25, signal } = {}) {
    const deadline = Date.now() + timeout;
    let gap = interval;
    for (;;) {
      if (signal?.aborted) return null;
      let found = null;
      try {
        found = finder();
      } catch (e) {
        log.debug('waitFor finder threw', e?.message);
      }
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await sleep(gap);
      gap = Math.min(700, gap * backoff); // ease off as the wait drags on
    }
  }

  /* ------------------------------------------------------------------ *
   * High-level discovery (search box, cards, cart button)
   * ------------------------------------------------------------------ */

  /** The search box, found four different ways (adapter → attrs → form → shape). */
  function findSearchInput(adapter) {
    const ad = adapter || adapters.current();

    // 1. Adapter chain
    let el = queryFirst(ad.selectors?.searchInput || []);
    if (el) return { el, method: 'selector' };

    // 2. Generic semantic attributes
    el = queryFirst([
      'input[type="search"]',
      'input[role="searchbox"]',
      'input[name="q"]',
      'input[name="query"]',
      'input[name="search"]',
      'input[name="s"]',
      'input[autocomplete*="search" i]',
      'input[aria-label*="جستجو"]',
      'input[aria-label*="search" i]',
      'input[placeholder*="جستجو"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="دنبال"]',
    ]);
    if (el) return { el, method: 'attribute' };

    // 3. Search form
    const form = queryFirst(['form[action*="search" i]', 'form[action*="/s" i]', 'form[role="search"]', 'div[role="search"] form']);
    if (form) {
      const inner = form.querySelector('input:not([type="hidden"]):not([type="submit"])');
      if (inner && isVisible(inner)) return { el: inner, method: 'form' };
    }

    // 4. Heuristic: widest visible text input in the header area.
    const inputs = Array.from(document.querySelectorAll('input[type="text"],input[type="search"],input:not([type])')).filter(isVisible);
    const headerZone = document.querySelector('header') || document.body;
    const inHeader = inputs.filter((i) => headerZone.contains(i));
    const pool = (inHeader.length ? inHeader : inputs).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    if (pool.length && pool[0].getBoundingClientRect().width > 120) return { el: pool[0], method: 'heuristic' };

    return { el: null, method: 'none' };
  }

  /** Product cards: declared selectors (scored) → structural heuristics → dedupe. */
  function findProductCards(adapter, limit = 300) {
    const ad = adapter || adapters.current();
    let cards = queryAll(ad.selectors?.productCard || []);
    cards = cards.filter((el) => adapters.cardScore(el, ad) >= 45);

    if (cards.length < 3) {
      const heur = adapters.heuristicCards(document, ad, limit);
      if (heur.length > cards.length) cards = heur;
    }

    // De-duplicate nested duplicates (keep the outermost useful one).
    const unique = [];
    for (const el of cards) {
      if (unique.some((u) => u.contains(el) || el.contains(u))) continue;
      unique.push(el);
    }
    return unique.slice(0, limit);
  }

  /**
   * The add-to-cart button on a product page — the most volatile button
   * on any store. Five independent strategies, retried via waitFor().
   */
  function findCartButton(adapter, scope = document) {
    const ad = adapter || adapters.current();

    // 1. data-testid / semantic classes
    const bySelector = queryFirst(
      [
        '[data-testid*="add-to-cart"]',
        '[data-testid*="addToCart"]',
        'button[class*="add-to-cart" i]',
        'button[class*="addToCart" i]',
        'button[class*="cart" i][class*="add" i]',
        '[class*="add-to-cart" i]',
      ],
      scope
    );
    if (bySelector && isVisible(bySelector)) return bySelector;

    // 2. Persian / English button texts from the adapter
    const byText = findByText(ad.cartButtonTexts || ['افزودن به سبد خرید', 'افزودن به سبد', 'add to cart'], scope, { tags: 'button,a,span,div' });
    if (byText) return byText;

    // 3. ARIA labels
    const byAria = queryFirst(['button[aria-label*="سبد" i]', 'button[aria-label*="cart" i]'], scope);
    if (byAria && isVisible(byAria)) return byAria;

    // 4. Form submit inside a product action bar
    const formBtn = queryFirst(['form button[type="submit"]'], scope);
    if (formBtn && isVisible(formBtn) && normalizeText(formBtn.textContent || '').length < 40) return formBtn;

    // 5. Shopping-cart icon button in the sticky buy bar (last resort)
    const cartIconBtn = Array.from(scope.querySelectorAll('button, a')).find((b) => {
      if (!isVisible(b)) return false;
      const sig = `${b.className || ''} ${b.getAttribute('data-testid') || ''} ${b.getAttribute('aria-label') || ''}`.toLowerCase();
      return /cart|basket|سبد/.test(sig) && b.querySelector('svg,img');
    });
    if (cartIconBtn) return cartIconBtn;

    return null;
  }

  ShopAgent.actions = ShopAgent.actions || {};
  ShopAgent.actions.dom = {
    bind,
    isVisible,
    queryFirst,
    queryAll,
    findByText,
    waitFor,
    findSearchInput,
    findProductCards,
    findCartButton,
    get rt() {
      return runtime;
    },
  };
})(globalThis);
