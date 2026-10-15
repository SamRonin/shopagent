/**
 * ShopAgent — shared/sites.js
 * ------------------------------------------------------------------
 * Store metadata at the URL level. This file is deliberately DOM-free
 * so the service worker can use it (search templates, host detection,
 * page classification) without touching content-script code.
 *
 * The DOM half of every store — selectors, labels, card heuristics —
 * lives in content/adapters/* and is merged on top of this metadata at
 * runtime (see content/adapters/index.js → resolve()).
 *
 * Design rule: **never trust a single selector** (enforced in the
 * adapters) and **never trust a single URL shape** (enforced here).
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  const digikala = {
    id: 'digikala',
    nameKey: 'store.digikala',
    label: 'دیجی‌کالا',
    labelEn: 'Digikala',
    hosts: ['www.digikala.com', 'digikala.com', 'm.digikala.com'],
    home: 'https://www.digikala.com/',
    /** Tried in order; the first reachable template wins. */
    searchUrl: (q) => [
      `https://www.digikala.com/search/?q=${encodeURIComponent(q)}`,
      `https://www.digikala.com/search?q=${encodeURIComponent(q)}`,
    ],
    productLinkRe: /\/product\/(dkp-|\d)/i,
    categoryLinkRe: /\/(product|search|category|list)\//i,
    /** Optional URL-level sort hints (best-effort, UI clicking is primary). */
    urlSort: { cheapest: { sort: 5 }, expensive: { sort: 6 }, newest: { sort: 4 }, bestselling: { sort: 8 }, best_match: { sort: 1 } },
  };

  const basalam = {
    id: 'basalam',
    nameKey: 'store.basalam',
    label: 'باسلام',
    labelEn: 'Basalam',
    hosts: ['basalam.com', 'www.basalam.com'],
    home: 'https://basalam.com/',
    searchUrl: (q) => [
      `https://basalam.com/search?q=${encodeURIComponent(q)}`,
      `https://basalam.com/fa/search?q=${encodeURIComponent(q)}`,
      `https://basalam.com/products?q=${encodeURIComponent(q)}`,
    ],
    productLinkRe: /\/(product|p)\//i,
    categoryLinkRe: /\/(product|search|category|shop)\//i,
    urlSort: {},
  };

  const ADAPTERS = [digikala, basalam];

  /** A neutral store so the agent still works on any other shop. */
  const generic = {
    id: 'generic',
    nameKey: 'store.current',
    label: 'فروشگاه جاری',
    labelEn: 'Current store',
    hosts: [],
    home: null,
    searchUrl: (q) => [],
    productLinkRe: /\/(product|item|p|dp|goods)\//i,
    categoryLinkRe: /./i,
    urlSort: {},
  };

  function detect(url) {
    try {
      const u = new URL(url || (typeof location !== 'undefined' ? location.href : ''));
      const host = u.hostname.replace(/^www\./, '');
      for (const a of ADAPTERS) {
        if (a.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return a;
      }
      return { ...generic, hosts: [u.hostname], home: `${u.origin}/` };
    } catch {
      return generic;
    }
  }

  /**
   * Classify a URL without touching the DOM.
   *
   * This is the guard that stops the agent from "searching" on a store
   * homepage: a run may only scroll/extract once `results` is true.
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

  ShopAgent.sites = { ADAPTERS, generic, digikala, basalam, detect, classifyUrl, list };
})(globalThis);
