/**
 * ShopAgent — shared/sites.js
 * ------------------------------------------------------------------
 * Store adapters.
 *
 * Design rule: **never trust a single selector.** Every adapter declares
 * an ordered list of candidate selectors; if all of them miss, the
 * generic heuristic engine (bottom of this file) reconstructs the page
 * model from first principles. That way a small CSS change on Digikala
 * or Basalam degrades gracefully instead of breaking the whole run.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, parsePrice, absoluteUrl, similarity } = ShopAgent.utils;

  /* ------------------------------------------------------------------ *
   * Adapters
   * ------------------------------------------------------------------ */

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
    selectors: {
      searchInput: [
        'input[type="search"][name="q"]',
        '#search-input-digitalkala',
        'input#search-input',
        'input[placeholder*="جستجو"]',
        'input[aria-label*="جستجو"]',
        'form[action*="/search"] input[type="text"]',
        'form[action*="/search"] input[type="search"]',
        'header input[type="search"]',
        'input[type="search"]',
      ],
      searchSubmit: [
        'form[action*="/search"] button[type="submit"]',
        'button[aria-label*="جستجو"]',
        'button[type="submit"]',
      ],
      productCard: [
        '[data-testid="productCard"]',
        'div.product-card',
        'div[class*="productCard"]',
        'ul.product-list > li',
        'div[class*="product-list"] > div',
        'div[class*="ProductList"] > div',
        'main li:has(a[href*="/product/"])',
        'div:has(> a[href*="/product/"])',
      ],
      productTitle: [
        '[data-testid="productTitle"]',
        'h2',
        'h3',
        'span[class*="title"]',
        'div[class*="title"]',
        'a[href*="/product/"]',
      ],
      productLink: ['a[href*="/product/"]', 'a[data-testid*="product"]', 'a[href]'],
      productPrice: [
        '[data-testid="price"]',
        'div[class*="price"]',
        'span[class*="price"]',
        'div[class*="Price"]',
      ],
      productImage: ['img[src]', 'img[data-src]', 'picture img'],
      productRating: ['[class*="rating"]', '[class*="Rating"]', '[data-testid*="rating"]'],
      productSeller: ['[class*="seller"]', '[class*="Seller"]'],
      discountBadge: ['[class*="discount"]', '[class*="Discount"]', '[class*="off"]'],
      sortControl: ['select[class*="sort"]', '[class*="sort"] button', '[data-testid*="sort"]'],
      nextPage: ['a[rel="next"]', 'button[aria-label*="بعدی"]', 'a[class*="next"]'],
      loadMore: ['button[class*="more"]', 'button:has(span)'],
    },
    /** Persian UI labels used by the click-by-text strategy. */
    labels: {
      sort: {
        bestselling: ['پرفروش‌ترین', 'پرفروش ترین', 'محبوب‌ترین'],
        cheapest: ['ارزان‌ترین', 'ارزان ترین', 'کمترین قیمت'],
        expensive: ['گران‌ترین', 'بیشترین قیمت'],
        newest: ['جدید‌ترین', 'جدیدترین', 'تازه‌ترین'],
        best_match: ['مرتبط‌ترین', 'بهترین تطابق', 'مرتبط ترین'],
        discount: ['بیشترین تخفیف'],
      },
      priceFilterHeading: ['محدوده قیمت', 'قیمت', 'بازه قیمت'],
      apply: ['اعمال', 'ثبت', 'تایید', 'اعمال فیلتر'],
    },
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
    selectors: {
      searchInput: [
        'input[name="q"]',
        'input[type="search"]',
        'input[placeholder*="جستجو"]',
        'input[placeholder*="دنبال"]',
        'input[aria-label*="جستجو"]',
        'form[action*="search"] input',
        'header input',
      ],
      searchSubmit: ['form[action*="search"] button[type="submit"]', 'button[aria-label*="جستجو"]', 'button[type="submit"]'],
      productCard: [
        '[data-testid*="product"]',
        'article',
        'div[class*="product-card"]',
        'div[class*="productCard"]',
        'div[class*="product_card"]',
        'main div:has(> a[href*="/product/"])',
        'li:has(a[href*="/product/"])',
      ],
      productTitle: ['h2', 'h3', '[class*="title"]', 'a[href*="/product/"]'],
      productLink: ['a[href*="/product/"]', 'a[href]'],
      productPrice: ['[class*="price"]', '[class*="Price"]', '[class*="cost"]'],
      productImage: ['img[src]', 'img[data-src]'],
      productRating: ['[class*="rating"]', '[class*="star"]'],
      productSeller: ['[class*="seller"]', '[class*="shop"]', 'a[href*="/shop"]'],
      discountBadge: ['[class*="discount"]', '[class*="off"]', '[class*="takhfif"]'],
      sortControl: ['select', '[class*="sort"] button', '[class*="sort"]'],
      nextPage: ['a[rel="next"]', 'button[aria-label*="بعدی"]'],
      loadMore: ['button[class*="more"]'],
    },
    labels: {
      sort: {
        bestselling: ['پرفروش‌ترین', 'محبوب‌ترین', 'پرفروش'],
        cheapest: ['ارزان‌ترین', 'کمترین قیمت', 'ارزان'],
        expensive: ['گران‌ترین', 'بیشترین قیمت'],
        newest: ['جدید‌ترین', 'تازه‌ترین', 'جدید'],
        best_match: ['مرتبط‌ترین', 'بهترین', 'پیشنهادی'],
        discount: ['بیشترین تخفیف', 'تخفیف'],
      },
      priceFilterHeading: ['محدوده قیمت', 'قیمت'],
      apply: ['اعمال', 'ثبت', 'تایید'],
    },
    urlSort: {},
  };

  const ADAPTERS = [digikala, basalam];

  /** A neutral adapter so the agent still works on any other shop. */
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
    },
    labels: {
      sort: { bestselling: ['پرفروش'], cheapest: ['ارزان'], expensive: ['گران'], newest: ['جدید'], best_match: ['مرتبط'], discount: ['تخفیف'] },
      priceFilterHeading: ['قیمت'],
      apply: ['اعمال', 'apply'],
    },
    urlSort: {},
  };

  function detect(url) {
    try {
      const u = new URL(url || (typeof location !== 'undefined' ? location.href : ''));
      const host = u.hostname.replace(/^www\./, '');
      for (const a of ADAPTERS) {
        if (a.hosts.some((h) => host === h || host.endsWith('.' + h))) return a;
      }
      return { ...generic, hosts: [u.hostname], home: u.origin + '/' };
    } catch {
      return generic;
    }
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
    return best.items.sort((a, b) => a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).map((s) => s.el).slice(0, limit);
  }

  ShopAgent.sites = {
    ADAPTERS,
    generic,
    digikala,
    basalam,
    detect,
    list,
    cardScore,
    heuristicCards,
  };
})(globalThis);
