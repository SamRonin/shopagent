/**
 * ShopAgent — content/actions/extract.js
 * ------------------------------------------------------------------
 * Product + price extraction.
 *
 * Store class names are obfuscated hashes, so nothing here trusts them.
 * Every price candidate is ranked by evidence that survives any redesign:
 *   1. currency word + price-hint container
 *   2. currency word
 *   3. price-hint container / declared selector
 *   4. LARGEST FONT SIZE ← the number the user actually sees
 *   5. price-likeness of the text, then DOM order
 * Struck-through values only ever feed `originalPrice`; subtrees that
 * carry ratings/discounts are removed from the text before parsing.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { parsePrice, toEnglishDigits, normalizeText, absoluteUrl, formatMoney, priceLikeness, extractMoney, uid, clamp } = ShopAgent.utils;
  const dom = ShopAgent.actions.dom;
  const hud = () => ShopAgent.actions.hud;

  /* ------------------------------------------------------------------ *
   * Price-evidence patterns
   * ------------------------------------------------------------------ */

  /** Subtrees whose numbers are NOT prices: ratings, discounts, counts… */
  const PRICE_BAD_RE =
    /(?:^|[^a-zآ-ی])(rating|star|score|review|comment|count|discount|badge|sold|sale|installment|warranty|timer|cashback|تخفیف|امتیاز|رای|رأی|نظر|دیدگاه|شگفت|گارانتی|ماه|بن)(?:$|[^a-zآ-ی])/i;
  /** Elements that look like a price container. */
  const PRICE_HINT_RE = /(price|cost|amount|قیمت|toman|rial|ریال)/i;
  /** An explicit currency word — the strongest price evidence. */
  const CURRENCY_RE = /(تومان|تومن|تمن|ریال|toman|rial)/i;

  function elementSignature(el) {
    if (!el || !el.getAttribute) return '';
    return `${el.className || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('aria-label') || ''}`;
  }

  function isStruck(el) {
    if (!el) return false;
    if (['DEL', 'S', 'STRIKE'].includes(el.tagName)) return true;
    const cls = `${el.className || ''} ${el.getAttribute('class') || ''}`.toLowerCase();
    if (/line-?through|old|was|before|previous|crossed/.test(cls)) return true;
    const style = window.getComputedStyle(el);
    return /line-through/.test(style.textDecorationLine || style.textDecoration || '');
  }

  /** True when the element (or a close ancestor) is struck-through. */
  function struckContext(el, card) {
    for (let a = el, hops = 0; a && a !== card && hops < 5; a = a.parentElement, hops++) {
      if (isStruck(a)) return true;
    }
    return false;
  }

  /** True when the element sits inside a rating/discount/count container. */
  function badPriceContext(el, card) {
    for (let a = el, hops = 0; a && a !== card && hops < 5; a = a.parentElement, hops++) {
      if (PRICE_BAD_RE.test(elementSignature(a))) return true;
    }
    return false;
  }

  /**
   * The element's text with every struck-through («was» price) and every
   * rating/discount subtree removed.
   */
  function priceTextOf(el) {
    let out = '';
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          out += child.nodeValue;
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (isStruck(child)) continue;
        if (PRICE_BAD_RE.test(elementSignature(child))) continue;
        walk(child);
      }
    };
    walk(el);
    return out.replace(/\s+/g, ' ').trim();
  }

  function fontSizeOf(el) {
    try {
      return parseFloat(getComputedStyle(el).fontSize) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * When a container holds several plausible numbers (e.g. a «was» price
   * that is NOT marked as struck-through), the displayed price is the one
   * rendered in the largest font.
   */
  function dominantChildValue(el) {
    let best = null;
    for (const d of el.querySelectorAll('*')) {
      const t = priceTextOf(d);
      if (!t || t.length > 60 || priceLikeness(t) < 0.7) continue;
      const v = parsePrice(t, { prefer: 'first' });
      if (v === null) continue;
      const f = fontSizeOf(d);
      if (!best || f > best.f) best = { v, f };
    }
    return best ? best.v : null;
  }

  /** Read the current price (and the struck "was" price) out of a card. */
  function extractPrice(card, adapter) {
    const declared = dom.queryAll(adapter.selectors?.productPrice || [], card);
    const inDeclared = (el) => declared.some((d) => d === el || d.contains(el));

    const candidates = [];
    let original = null;

    for (const el of [card, ...card.querySelectorAll('*')]) {
      if (el.children.length > 6) continue;

      if (isStruck(el) || struckContext(el, card)) {
        const v = parsePrice((el.textContent || '').trim(), { prefer: 'max' });
        if (v !== null && (original === null || v > original)) original = v;
        continue;
      }
      if (badPriceContext(el, card)) continue;

      const text = priceTextOf(el);
      if (!text || text.length > 80) continue;
      const likeness = priceLikeness(text);
      if (likeness < 0.55) continue; // a title/label that merely contains digits

      let value = parsePrice(text, { prefer: 'first' }); // strict range
      if (value === null) continue;

      // Several plausible numbers in one container? Trust the largest-font child.
      if (extractMoney(text).filter((c) => c.value >= 500).length > 1) {
        const dv = dominantChildValue(el);
        if (dv !== null) value = dv;
      }

      candidates.push({
        value,
        anchored: CURRENCY_RE.test(text),
        hint: PRICE_HINT_RE.test(elementSignature(el)) || inDeclared(el),
        font: fontSizeOf(el),
        likeness,
        order: candidates.length,
      });
    }

    candidates.sort(
      (a, b) =>
        (b.anchored && b.hint ? 1 : 0) - (a.anchored && a.hint ? 1 : 0) ||
        (b.anchored ? 1 : 0) - (a.anchored ? 1 : 0) ||
        (b.hint ? 1 : 0) - (a.hint ? 1 : 0) ||
        b.font - a.font ||
        b.likeness - a.likeness ||
        a.order - b.order
    );

    let current = candidates.length ? candidates[0].value : null;
    if (current === null) {
      const full = priceTextOf(card);
      current = parsePrice(full, { prefer: 'first', anchoredOnly: true });
      if (current === null) current = parsePrice(full, { prefer: 'first' });
    }

    if (current !== null && original !== null && original <= current) original = null;
    return { current, original };
  }

  /* ------------------------------------------------------------------ *
   * Card fields
   * ------------------------------------------------------------------ */

  function pickImage(card) {
    const imgs = Array.from(card.querySelectorAll('img')).filter((i) => i.getAttribute('src') || i.getAttribute('data-src') || i.currentSrc);
    if (!imgs.length) return null;
    const best = imgs.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0];
    const raw = best.currentSrc || best.src || best.getAttribute('data-src') || best.getAttribute('data-lazy') || '';
    if (!raw || raw.startsWith('data:image/svg')) return null;
    return absoluteUrl(raw, location.href);
  }

  function parseRating(card, adapter) {
    const nodes = dom.queryAll(adapter.selectors?.productRating || [], card);
    for (const n of nodes) {
      const txt = toEnglishDigits(normalizeText(n.textContent || ''));
      const m = txt.match(/([0-5](?:\.[0-9])?)/);
      if (m) return { rating: Number(m[1]), text: n.textContent.trim() };
      const aria = n.getAttribute('aria-label') || n.getAttribute('title') || '';
      const am = toEnglishDigits(aria).match(/([0-5](?:\.[0-9])?)/);
      if (am) return { rating: Number(am[1]), text: aria };
      const style = window.getComputedStyle(n);
      const wm = (style.width || '').match(/([\d.]+)%/);
      if (wm) return { rating: Math.round((Number(wm[1]) / 100) * 5 * 10) / 10, text: `${wm[1]}%` };
    }
    // Text fallback: «۴.۳ از ۵»
    const txt = toEnglishDigits(card.textContent || '');
    const m = txt.match(/(\b[0-5]\.[0-9])\s*(?:از\s*5)?/);
    if (m) return { rating: Number(m[1]), text: m[1] };
    return { rating: null, text: null };
  }

  function parseRatingCount(card) {
    const txt = toEnglishDigits(card.textContent || '');
    const m = txt.match(/\((\d{1,7})\)/) || txt.match(/(\d{2,7})\s*(?:نظر|رای|امتیاز)/);
    return m ? Number(m[1]) : null;
  }

  function parseDiscount(card, adapter, current, original) {
    // Explicit badge first («۲۵٪»)
    const nodes = dom.queryAll(adapter.selectors?.discountBadge || [], card);
    for (const n of nodes) {
      const m = toEnglishDigits(n.textContent || '').match(/(\d{1,3})\s*[%٪]/);
      if (m) return clamp(Number(m[1]), 0, 95);
      const bare = toEnglishDigits(normalizeText(n.textContent || '')).match(/^(\d{1,3})$/);
      if (bare && Number(bare[1]) <= 95) return Number(bare[1]);
    }
    if (current && original && original > current) {
      return clamp(Math.round(((original - current) / original) * 100), 0, 95);
    }
    return 0;
  }

  function extractTitle(card, adapter) {
    const nodes = dom.queryAll(adapter.selectors?.productTitle || [], card);
    const scored = [];
    for (const n of nodes) {
      const text = normalizeText(n.getAttribute('title') || n.textContent || '');
      if (text.length < 6) continue;
      let score = text.length > 20 ? 20 : text.length;
      if (/^h[1-6]$/.test(n.tagName)) score += 15;
      if (/title|name|product/i.test(`${n.className || ''}`)) score += 12;
      if (text.length > 200) score -= 20;
      scored.push({ text: (n.getAttribute('title') || n.textContent || '').trim().replace(/\s+/g, ' '), score });
    }
    if (scored.length) return scored.sort((a, b) => b.score - a.score)[0].text;
    const img = card.querySelector('img[alt]');
    if (img && img.alt && img.alt.trim().length > 6) return img.alt.trim();
    return (card.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  }

  /* ------------------------------------------------------------------ *
   * Full-page extraction
   * ------------------------------------------------------------------ */

  /** Pull structured product data out of the current page. */
  function extractProducts(adapter, { limit = 60 } = {}) {
    const ad = adapter || ShopAgent.adapters.current();
    hud().setStatus('analyzing');
    const rt = dom.rt;
    const cards = dom.findProductCards(ad, limit * 4);
    const products = [];
    const seenLinks = new Set();
    const seenTitles = new Set();

    for (const card of cards) {
      rt?.throwIfAborted();
      const title = extractTitle(card, ad);
      if (!title || title.length < 6) continue;

      const linkEl =
        dom.queryFirst(ad.selectors?.productLink || ['a[href]'], card) ||
        Array.from(card.querySelectorAll('a[href]')).find((a) => (ad.productLinkRe || /./).test(a.getAttribute('href') || ''));
      const url = linkEl ? absoluteUrl(linkEl.getAttribute('href'), location.href) : null;

      const titleKey = normalizeText(title).slice(0, 80);
      if (url && seenLinks.has(url)) continue;
      if (seenTitles.has(titleKey)) continue;

      const { current, original } = extractPrice(card, ad);
      // A card without a readable price cannot be advised on; a sub-1,000
      // Toman "price" is essentially always a stray number.
      if (current === null || current < 1000) continue;

      seenLinks.add(url);
      seenTitles.add(titleKey);

      const rating = parseRating(card, ad);
      const discount = parseDiscount(card, ad, current, original);
      const sellerNode = dom.queryFirst(ad.selectors?.productSeller || [], card);
      const text = normalizeText(card.textContent || '');

      products.push({
        id: uid('p'),
        title: title.slice(0, 220),
        url,
        image: pickImage(card),
        price: current,
        priceText: formatMoney(current),
        originalPrice: original,
        discount,
        rating: rating.rating,
        ratingCount: parseRatingCount(card),
        seller: sellerNode ? normalizeText(sellerNode.textContent).slice(0, 60) : null,
        isNew: /(جدید|تازه|new)/i.test(text),
        inStock: !/(ناموجود|تمام شده|out of stock)/i.test(text),
        store: ad.id,
        storeLabel: ad.label,
        index: products.length,
      });

      if (products.length >= limit) break;
    }

    if (rt) rt.lastExtraction = products;
    rt?.emit('extracted', { count: products.length, scanned: cards.length });

    return {
      ok: true,
      products,
      meta: {
        url: location.href,
        title: document.title,
        store: ad.id,
        storeLabel: ad.label,
        cardsScanned: cards.length,
        extractedAt: Date.now(),
        pageHeight: document.documentElement.scrollHeight,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      },
    };
  }

  /** Read a single product page (title, price, specs, gallery). */
  function readProductPage(adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    const title = document.querySelector('h1')?.textContent?.trim() || document.title;
    const priceText = dom.queryFirst(ad.selectors?.productPrice || [])?.textContent || '';
    const specs = {};
    document.querySelectorAll('[class*="spec" i] tr, table tr, [class*="param" i] > div').forEach((row) => {
      const cells = row.querySelectorAll('th,td,dt,dd,span,div');
      if (cells.length >= 2) {
        const k = normalizeText(cells[0].textContent).slice(0, 60);
        const v = normalizeText(cells[1].textContent).slice(0, 120);
        if (k && v && k !== v) specs[k] = v;
      }
    });
    return {
      ok: true,
      url: location.href,
      title: normalizeText(title),
      price: parsePrice(priceText || document.body.innerText.slice(0, 3000)),
      priceText: normalizeText(priceText),
      image: document.querySelector('img[src*="dkstatic"], img[class*="gallery" i], main img')?.currentSrc || null,
      specs: Object.fromEntries(Object.entries(specs).slice(0, 40)),
      description: normalizeText(document.querySelector('[class*="description" i], #description')?.textContent || '').slice(0, 1500),
    };
  }

  ShopAgent.actions.extract = { extractProducts, readProductPage, extractPrice, extractTitle, priceTextOf, parseRating };
})(globalThis);
