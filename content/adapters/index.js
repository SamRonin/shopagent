/**
 * ShopAgent — content/adapters/index.js
 * ------------------------------------------------------------------
 * Adapter registry + structural card heuristics (the DOM safety net).
 *
 * resolve(url) merges:
 *   • URL metadata from shared/sites.js (hosts, searchUrl, classify)
 *   • DOM selectors/labels from the per-store adapter files
 * and is the ONLY object the action modules ever talk to.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const sites = ShopAgent.sites;
  const { parsePrice } = ShopAgent.utils;

  const registry = {}; // id → {selectors, labels, cartButtonTexts}
  const pending = ShopAgent.adapters?._pending || [];

  for (const entry of pending) registry[entry.id] = entry;
  delete ShopAgent.adapters?._pending;

  function domFor(storeId) {
    return registry[storeId] || registry.generic;
  }

  /** Full adapter = URL metadata + DOM knowledge. */
  function resolve(url) {
    const meta = sites.detect(url);
    return { ...meta, ...domFor(meta.id) };
  }

  /** The current page's adapter (content script context). */
  function current() {
    return resolve(typeof location !== 'undefined' ? location.href : '');
  }

  /* ------------------------------------------------------------------ *
   * Generic heuristic engine — what makes something look like a card?
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
    const productLink = Array.from(links).find((a) => (adapter.productLinkRe || /./).test(a.getAttribute('href') || ''));
    if (productLink) score += 30;
    else if (links.length) score += 6;

    if (el.querySelector('img')) score += 14;

    const text = (el.innerText || el.textContent || '').trim();
    if (!text) return 0;
    if (text.length > 8 && text.length < 500) score += 12;
    if (text.length > 900) score -= 25;

    if (parsePrice(text) !== null) score += 24;

    if (el.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]')) score += 8;

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
    const rootEl = scope || document;
    const scored = [];
    const candidates = rootEl.querySelectorAll('article, li, div');
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
      // Prefer groups whose members look alike (same tag + similar size).
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

  ShopAgent.adapters = {
    registry,
    domFor,
    resolve,
    current,
    cardScore,
    heuristicCards,
  };
})(globalThis);
