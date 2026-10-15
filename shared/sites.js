/**
 * ShopAgent — shared/sites.js
 * ------------------------------------------------------------------
 * Store-adapter REGISTRY + the generic heuristic engine.
 *
 * Design rule: **never trust a single selector.** Concrete adapters
 * (`content/adapters/digikala.js`, `content/adapters/basalam.js`,
 * `content/adapters/generic.js`) self-register here via
 * `ShopAgent.sites.register(...)`. Every adapter declares an *ordered*
 * list of candidate selectors; if all of them miss, the heuristic
 * engine at the bottom of this file reconstructs the page model from
 * first principles. A small CSS change on Digikala or Basalam then
 * degrades gracefully instead of breaking the whole run.
 *
 * This file must be loaded BEFORE any adapter file, and AFTER
 * shared/utils.js. It is context-free (no DOM, no chrome.* APIs).
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, parsePrice, absoluteUrl } = ShopAgent.utils;

  /* ------------------------------------------------------------------ *
   * Registry
   * ------------------------------------------------------------------ */

  const ADAPTERS = [];

  /**
   * Register a concrete store adapter. Called at load time by every
   * file in `content/adapters/`. Duplicate ids replace the old entry
   * so a reload of the content script never doubles the list.
   */
  function register(adapter) {
    if (!adapter || typeof adapter !== 'object' || !adapter.id) return;
    const existing = ADAPTERS.findIndex((a) => a.id === adapter.id);
    if (existing >= 0) ADAPTERS[existing] = adapter;
    else ADAPTERS.push(adapter);
  }

  /** A neutral adapter so the agent still works on any other shop. */
  const generic = {
    id: 'generic',
    nameKey: 'store.current',
    label: 'فروشگاه جاری',
    labelEn: 'Current store',
    hosts: [],
    home: null,
    searchUrl: () => [],
    productLinkRe: /\/(product|item|p|dp|goods)\//i,
    categoryLinkRe: /./i,
    selectors: {
      searchInput: ['input[type="search"]', 'input[name="q"]', 'input[name="query"]', 'input[name="s"]', 'input[placeholder*="جستجو"]', 'input[placeholder*="search" i]', 'input[role="searchbox"]'],
      searchSubmit: ['form button[type="submit"]', 'button[aria-label*="search" i]', 'button[type="submit"]'],
      productCard: ['article', '[data-testid*="product" i]', 'li[class*="product" i]', 'div[class*="product-card" i]', 'div[class*="productCard"]'],
      productTitle: ['h1', 'h2', 'h3', '[class*="title" i]'],
      productLink: ['a[href]'],
      productPrice: ['[class*="price" i]', '[data-testid*="price" i]'],
      productImage: ['img[src]', 'img[data-src]'],
      productRating: ['[class*="rating" i]', '[class*="star" i]'],
      productSeller: ['[class*="seller" i]', '[class*="shop" i]'],
      discountBadge: ['[class*="discount" i]', '[class*="off" i]'],
      sortControl: ['select'],
      nextPage: ['a[rel="next"]'],
      loadMore: [],
      addToCart: [],
    },
    labels: {
      sort: { bestselling: ['پرفروش'], cheapest: ['ارزان'], expensive: ['گران'], newest: ['جدید'], best_match: ['مرتبط'], discount: ['تخفیف'] },
      priceFilterHeading: ['قیمت'],
      apply: ['اعمال', 'apply'],
      addToCart: ['افزودن به سبد خرید', 'افزودن به سبد', 'اضافه به سبد', 'خرید نقدی', 'add to cart', 'add to basket'],
      inCart: ['در سبد خرید', 'به سبد اضافه شد', 'سبد خرید'],
    },
    urlSort: {},
  };

  function detect(url) {
    let host = '';
    try {
      const u = new URL(url || (typeof location !== 'undefined' ? location.href : ''));
      host = u.hostname.replace(/^www\./, '');
      for (const a of ADAPTERS) {
        if (a.hosts.some((h) => host === h || host.endsWith('.' + h))) return a;
      }
      return { ...generic, hosts: [u.hostname], home: u.origin + '/' };
    } catch {
      return generic;
    }
  }

  /** Adapter by id (`digikala`, `basalam`, …) or the generic fallback. */
  function byId(id) {
    return ADAPTERS.find((a) => a.id === id) || generic;
  }

  /**
   * Classify a URL without touching the DOM.
   *
   * This is the guard that stops the agent from "searching" on a store
   * homepage: a run may only scroll/extract once `results` is true.
   *
   * @param {string} url
   * @returns {{home:boolean, results:boolean, path:string, query:string}}
   */
  function classifyUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return { home: false, results: false, path: '', query: '' };
    }
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    const query = u.search || '';

    const resultsPath = /(^|\/)(search|srch|results?|s|find)(\/|$)/i.test(path);
    const resultsQuery = /[?&](q|query|keyword|keywords|search|searchtext|text|term)=/i.test(query);
    // A product page is never a results page, even if it carries ?q=.
    const productPath = /(^|\/)(product|item|p|dp|goods)(\/|-|$)/i.test(path);

    const home = path === '/' || /^\/(fa|en|home|index\.html?)$/i.test(path);

    return {
      home,
      results: resultsPath || (resultsQuery && !productPath),
      path,
      query,
    };
  }

  function list() {
    return [...ADAPTERS, generic].map((a) => ({
      id: a.id,
      label: a.label,
      labelEn: a.labelEn,
      home: a.home,
    }));
  }

  /* ------------------------------------------------------------------ *
   * Generic heuristic engine — the safety net behind every selector list
   * ------------------------------------------------------------------ */

  /**
   * Score how "product-card-like" an element is. Purely structural, so it
   * survives CSS renames: a card is a small, self-contained block that has
   * a product link, an image, a title-ish text and a price-ish number.
   */
  function cardScore(el, adapter) {
    if (!el || el.nodeType !== 1) return 0;
    let score = 0;

    const links = el.querySelectorAll('a[href]');
    const productLink = Array.from(links).find((a) => adapter.productLinkRe.test(a.getAttribute('href') || ''));
    if (productLink) score += 30;
    else if (links.length) score += 6;

    if (el.querySelector('img')) score += 14;

    const text = (el.innerText || el.textContent || '').trim();
    if (!text) return 0;
    if (text.length > 8 && text.length < 500) score += 12;
    if (text.length > 900) score -= 25;

    if (parsePrice(text) !== null) score += 24;

    const hasHeading = el.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
    if (hasHeading) score += 8;

    const tag = el.tagName.toLowerCase();
    if (tag === 'article' || tag === 'li') score += 6;
    if (tag === 'tr' || tag === 'td' || tag === 'table') score -= 30;
    if (tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'aside') score -= 40;
    if (el.querySelector('input,textarea,select,button[class*="cart" i]')) score -= 2;
    if (el.querySelector('header,footer,nav')) score -= 20;

    // Visible & reasonably sized
    const rect = el.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 40) score -= 20;
    if (rect.width > 1400) score -= 12;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return 0;

    return Math.max(0, score);
  }

  /**
   * Find repeated, structurally similar siblings and return the best group.
   * This is what makes extraction work on sites we have never seen.
   */
  function heuristicCards(scope, adapter, limit = 200) {
    const root = scope || document;
    const scored = [];
    const candidates = root.querySelectorAll('article, li, div');
    for (const el of candidates) {
      const s = cardScore(el, adapter);
      if (s >= 55) scored.push({ el, score: s });
      if (scored.length > 4000) break;
    }
    if (!scored.length) return [];

    // Group by parent; the parent with the most high-scoring children wins.
    const groups = new Map();
    for (const item of scored) {
      const p = item.el.parentElement;
      if (!p) continue;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(item);
    }

    let best = null;
    for (const [parent, items] of groups) {
      if (items.length < 2) continue;
      // Prefer groups whose members look alike (same tag + similar text length).
      const tags = new Set(items.map((i) => i.el.tagName));
      const uniform = tags.size === 1 ? 1.25 : 0.7;
      const avg = items.reduce((a, b) => a + b.score, 0) / items.length;
      const value = items.length * avg * uniform;
      if (!best || value > best.value) best = { parent, items, value };
    }

    if (!best) return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.el);
    return best.items
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((s) => s.el)
      .slice(0, limit);
  }

  ShopAgent.sites = {
    ADAPTERS,
    generic,
    register,
    byId,
    detect,
    classifyUrl,
    list,
    cardScore,
    heuristicCards,
  };
})(globalThis);
