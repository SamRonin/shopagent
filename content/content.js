/**
 * ShopAgent — content/content.js
 * ------------------------------------------------------------------
 * The Action Executor. Injected into store pages (Digikala / Basalam)
 * and responsible for every physical interaction with the DOM:
 *
 *   • human-like typing  (real keydown/keypress/input/keyup events,
 *                         per-character jitter, React-safe value setter)
 *   • resilient element discovery (ordered selectors → text search →
 *                         structural heuristics)
 *   • soft scrolling for lazy-loaded grids
 *   • product extraction + Persian price normalisation
 *   • a live HUD so the user can *see* what the agent is doing
 *
 * This file never talks to a model and never touches the network.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  if (window.__SHOPAGENT_CONTENT_LOADED__) return;
  window.__SHOPAGENT_CONTENT_LOADED__ = true;

  const SA = globalThis.ShopAgent || {};
  const utils = SA.utils || {};
  const sites = SA.sites || {};
  const {
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1)),
    clamp = (v, a, b) => Math.min(b, Math.max(a, v)),
    parsePrice = () => null,
    toEnglishDigits = (s) => s,
    normalizeText = (s) => String(s || ''),
    absoluteUrl = (h) => h,
    formatMoney = (v) => String(v),
    logger = () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    uid = (p) => `${p}_${Math.random().toString(36).slice(2)}`,
    toPersianDigits = (s) => s,
  } = utils;

  const log = logger('content');
  const adapter = sites.detect ? sites.detect(location.href) : {};

  /* ================================================================== *
   * State
   * ================================================================== */

  const state = {
    settings: { typingSpeed: 'normal', liveHud: true, autoScroll: true, maxResults: 6, language: 'fa' },
    running: false,
    abortController: null,
    lastExtraction: [],
  };

  const TYPING_DELAY = { slow: [70, 190], normal: [35, 95], fast: [12, 34] };

  function isAborted() {
    return state.abortController?.signal?.aborted === true;
  }

  function throwIfAborted() {
    if (isAborted()) throw new DOMException('Aborted', 'AbortError');
  }

  /* ================================================================== *
   * Event helpers — dispatch things a real browser would dispatch
   * ================================================================== */

  function fire(el, type, init = {}) {
    try {
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    } catch (e) {
      log.debug('fire failed', type, e);
    }
  }

  function fireKey(el, type, { key = '', code, keyCode = 0, shiftKey = false, ctrlKey = false, altKey = false, metaKey = false } = {}) {
    try {
      const ev = new KeyboardEvent(type, {
        key,
        code: code || keyToCode(key),
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey,
        ctrlKey,
        altKey,
        metaKey,
        view: window,
      });
      // KeyboardEvent.keyCode is read-only in some engines; force it.
      Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
      Object.defineProperty(ev, 'which', { get: () => keyCode });
      el.dispatchEvent(ev);
    } catch (e) {
      log.debug('fireKey failed', type, e);
    }
  }

  function keyToCode(key) {
    if (!key) return 'Unidentified';
    if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    const named = { ' ': 'Space', '،': 'Comma', '٫': 'Period', '.': 'Period', ',': 'Comma', '-': 'Minus', '؟': 'Slash', '/': 'Slash' };
    return named[key] || 'Unidentified';
  }

  /** The React/Vue-safe way to write into a controlled input. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  /* ================================================================== *
   * Element discovery
   * ================================================================== */

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
        const found = scope.querySelectorAll(sel);
        for (const el of found) {
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

  /** The search box, found four different ways. */
  function findSearchInput() {
    // 1. Adapter selectors
    let el = queryFirst(adapter.selectors?.searchInput || []);
    if (el) return { el, method: 'selector' };

    // 2. Generic attributes
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
      'input[placeholder*="چه چیزی"]',
    ]);
    if (el) return { el, method: 'attribute' };

    // 3. Search form
    const form = queryFirst(['form[action*="search" i]', 'form[action*="/s" i]', 'form[role="search"]', 'div[role="search"] form']);
    if (form) {
      const inner = form.querySelector('input:not([type="hidden"]):not([type="submit"])');
      if (inner && isVisible(inner)) return { el: inner, method: 'form' };
    }

    // 4. Heuristic: the widest visible text input in the header area.
    const inputs = Array.from(document.querySelectorAll('input[type="text"],input[type="search"],input:not([type])')).filter(isVisible);
    const headerZone = document.querySelector('header') || document.body;
    const inHeader = inputs.filter((i) => headerZone.contains(i));
    const pool = (inHeader.length ? inHeader : inputs).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    if (pool.length && pool[0].getBoundingClientRect().width > 120) return { el: pool[0], method: 'heuristic' };

    return { el: null, method: 'none' };
  }

  function findProductCards(limit = 300) {
    // 1. Declared selectors
    let cards = queryAll(adapter.selectors?.productCard || []);
    // Keep only elements that actually look like a card.
    cards = cards.filter((el) => (sites.cardScore ? sites.cardScore(el, adapter) : 50) >= 45);

    // 2. Structural heuristics when the declared selectors missed.
    if (cards.length < 3 && sites.heuristicCards) {
      const heur = sites.heuristicCards(document, adapter, limit);
      if (heur.length > cards.length) cards = heur;
    }

    // 3. De-duplicate nested duplicates (keep the outermost useful one).
    const unique = [];
    for (const el of cards) {
      if (unique.some((u) => u.contains(el) || el.contains(u))) continue;
      unique.push(el);
    }
    return unique.slice(0, limit);
  }

  /* ================================================================== *
   * Human-like interaction
   * ================================================================== */

  function scrollIntoViewSmooth(el) {
    return new Promise((resolve) => {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      } catch {
        try {
          el.scrollIntoView();
        } catch {}
      }
      setTimeout(resolve, 420);
    });
  }

  /**
   * Type into an element exactly the way a person would: focus, then one
   * character at a time with keyboard events, input events and jitter.
   */
  async function typeHuman(el, text, { clear = true, speed } = {}) {
    if (!el) throw new Error('NO_ELEMENT');
    const str = String(text ?? '');
    const [minDelay, maxDelay] = TYPING_DELAY[speed || state.settings.typingSpeed] || TYPING_DELAY.normal;

    await scrollIntoViewSmooth(el);
    hud.setStatus('typing', `«${str}»`);
    highlight(el, 'field');

    el.focus({ preventScroll: true });
    fire(el, 'focus');
    fire(el, 'focusin');
    try {
      el.click();
    } catch {}
    await sleep(randInt(90, 220));

    if (clear && el.value) {
      // Select-all + delete, like a human clearing the box.
      fireKey(el, 'keydown', { key: 'a', keyCode: 65, ctrlKey: true });
      el.setSelectionRange?.(0, el.value.length);
      await sleep(randInt(40, 90));
      fireKey(el, 'keydown', { key: 'Backspace', keyCode: 8 });
      setNativeValue(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      fireKey(el, 'keyup', { key: 'Backspace', keyCode: 8 });
      fire(el, 'change');
      await sleep(randInt(60, 140));
    }

    let typed = 0;
    for (const ch of str) {
      throwIfAborted();
      const keyCode = ch.charCodeAt(0);
      fireKey(el, 'keydown', { key: ch, keyCode });
      fireKey(el, 'keypress', { key: ch, keyCode });
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: ch, inputType: 'insertText', isComposing: false }));
      fireKey(el, 'keyup', { key: ch, keyCode });
      typed++;
      if (typed % 5 === 0) hud.setProgress(clamp(typed / Math.max(str.length, 1), 0, 1));
      emit('typing', { typed, total: str.length });
      // Occasional micro-pause, exactly like a person hesitating.
      await sleep(randInt(minDelay, maxDelay) + (Math.random() < 0.07 ? randInt(120, 320) : 0));
    }

    fire(el, 'change');
    fire(el, 'blur');
    hud.setProgress(1);
    log.info('typed', typed, 'chars into', el.name || el.id || el.placeholder || '<input>');
    return { ok: true, typed };
  }

  async function pressEnter(el) {
    fireKey(el, 'keydown', { key: 'Enter', keyCode: 13 });
    fireKey(el, 'keypress', { key: 'Enter', keyCode: 13 });
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    fireKey(el, 'keyup', { key: 'Enter', keyCode: 13 });
  }

  /** Submit a search: try the button, then the form, then Enter. */
  async function submitSearch(inputEl) {
    hud.setStatus('typing', 'ارسال جستجو');
    const urlBefore = location.href;

    const btn = queryFirst(adapter.selectors?.searchSubmit || []) ||
      (inputEl.closest('form')?.querySelector('button[type="submit"],input[type="submit"]')) ||
      findByText(['جستجو', 'سرچ', 'search'], inputEl.closest('form') || document);

    if (btn) {
      highlight(btn, 'click');
      await sleep(randInt(120, 320));
      btn.click();
      log.info('clicked search button');
    } else {
      const form = inputEl.closest('form');
      if (form) {
        highlight(form, 'click');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        log.info('submitted search form');
      } else {
        await pressEnter(inputEl);
        log.info('pressed Enter');
      }
    }

    // Wait for either a URL change or fresh product cards.
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      throwIfAborted();
      await sleep(250);
      const urlChanged = location.href !== urlBefore;
      const cards = findProductCards(8);
      if (urlChanged || cards.length >= 2) {
        await sleep(600); // let the SPA settle
        return { ok: true, url: location.href, cards: cards.length, urlChanged };
      }
    }
    return { ok: false, url: location.href, reason: 'NO_RESULTS_DETECTED' };
  }

  /* ================================================================== *
   * Scrolling (lazy load)
   * ================================================================== */

  /**
   * Soft, eased scroll. Keeps going while the document height grows, so
   * infinite-scroll / lazy-image grids fully materialise.
   */
  async function softScroll({ rounds = 4, stepRatio = 0.85, settleMs = 550, maxIdleRounds = 3 } = {}) {
    hud.setStatus('scrolling');
    let lastHeight = document.documentElement.scrollHeight;
    let idle = 0;
    let totalScrolled = 0;

    for (let r = 0; r < rounds; r++) {
      throwIfAborted();
      const step = Math.max(300, window.innerHeight * stepRatio);
      const target = window.scrollY + step;
      const from = window.scrollY;
      const duration = randInt(420, 780);
      const started = performance.now();

      await new Promise((resolve) => {
        function frame(now) {
          const p = clamp((now - started) / duration, 0, 1);
          const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
          window.scrollTo(0, from + (target - from) * eased);
          if (p < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });

      totalScrolled += step;
      hud.setProgress(clamp((r + 1) / rounds, 0, 1));
      // Nudge the lazy loaders by firing the events they listen for.
      window.dispatchEvent(new Event('scroll'));
      await sleep(settleMs + randInt(0, 250));

      const newHeight = document.documentElement.scrollHeight;
      if (newHeight > lastHeight + 40) {
        lastHeight = newHeight;
        idle = 0;
      } else {
        idle++;
      }
      emit('scrolling', { round: r + 1, rounds, height: newHeight, loaded: findProductCards(500).length });
      if (idle >= maxIdleRounds) {
        log.info('page stopped growing; scroll finished');
        break;
      }
    }

    // Scroll back up gently so the first results are in view for the user.
    const backFrom = window.scrollY;
    const backTo = 0;
    const started = performance.now();
    await new Promise((resolve) => {
      function frame(now) {
        const p = clamp((now - started) / 900, 0, 1);
        window.scrollTo(0, backFrom + (backTo - backFrom) * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });

    return { ok: true, scrolled: Math.round(totalScrolled), height: document.documentElement.scrollHeight, cards: findProductCards(500).length };
  }

  /* ================================================================== *
   * Extraction
   * ================================================================== */

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

  function isStruck(el) {
    if (!el) return false;
    if (['DEL', 'S', 'STRIKE'].includes(el.tagName)) return true;
    const cls = `${el.className || ''} ${el.getAttribute('class') || ''}`.toLowerCase();
    if (/line-?through|old|was|before|previous|crossed/.test(cls)) return true;
    const style = window.getComputedStyle(el);
    return /line-through/.test(style.textDecorationLine || style.textDecoration || '');
  }

  function parseRating(card) {
    const nodes = queryAll(adapter.selectors?.productRating || [], card);
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
    // Text fallback: «۴.۳ از ۵» / «(۱۲۳)»
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

  function parseDiscount(card, current, original) {
    // Explicit badge first («۲۵٪»)
    const nodes = queryAll(adapter.selectors?.discountBadge || [], card);
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

  /**
   * Read a price out of a card, tolerating Rial/Toman, Persian digits,
   * grouping separators and struck-through "was" prices.
   */
  function extractPrice(card) {
    let current = null;
    let original = null;

    const priceNodes = queryAll(adapter.selectors?.productPrice || [], card);
    const allNodes = priceNodes.length ? priceNodes : [card];

    for (const node of allNodes) {
      const children = node.querySelectorAll('*');
      for (const el of [node, ...children]) {
        if (!el || el.children.length > 3) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 60) continue;
        const value = parsePrice(text, { prefer: 'first' });
        if (value === null) continue;
        if (isStruck(el)) {
          if (original === null || value > original) original = value;
          continue;
        }
        // Prefer the value closest to a "price" labelled container.
        const cls = `${el.className || ''}`.toLowerCase();
        const isPriceish = /price|cost|amount|قیمت/.test(cls) || priceNodes.includes(node);
        if (current === null || (isPriceish && value > current)) current = value;
      }
      if (current !== null) break;
    }

    if (current === null) current = parsePrice(card.textContent || '', { prefer: 'first' });
    if (current !== null && original !== null && original <= current) original = null;
    return { current, original };
  }

  function extractTitle(card) {
    const nodes = queryAll(adapter.selectors?.productTitle || [], card);
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

  /** Pull structured product data out of the current page. */
  function extractProducts({ limit = 60 } = {}) {
    hud.setStatus('analyzing');
    const cards = findProductCards(limit * 4);
    const products = [];
    const seenLinks = new Set();
    const seenTitles = new Set();

    for (const card of cards) {
      throwIfAborted();
      const title = extractTitle(card);
      if (!title || title.length < 6) continue;

      const linkEl =
        queryFirst(adapter.selectors?.productLink || ['a[href]'], card) ||
        Array.from(card.querySelectorAll('a[href]')).find((a) => adapter.productLinkRe?.test(a.getAttribute('href') || ''));
      const url = linkEl ? absoluteUrl(linkEl.getAttribute('href'), location.href) : null;

      const titleKey = normalizeText(title).slice(0, 80);
      if (url && seenLinks.has(url)) continue;
      if (seenTitles.has(titleKey)) continue;

      const { current, original } = extractPrice(card);
      if (current === null) continue; // a card without a readable price cannot be advised on

      seenLinks.add(url);
      seenTitles.add(titleKey);

      const rating = parseRating(card);
      const discount = parseDiscount(card, current, original);
      const sellerNode = queryFirst(adapter.selectors?.productSeller || [], card);
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
        store: adapter.id,
        storeLabel: adapter.label,
        index: products.length,
      });

      if (products.length >= limit) break;
    }

    state.lastExtraction = products;
    emit('extracted', { count: products.length, scanned: cards.length });
    log.info(`extracted ${products.length} products from ${cards.length} candidate cards`);

    return {
      ok: true,
      products,
      meta: {
        url: location.href,
        title: document.title,
        store: adapter.id,
        storeLabel: adapter.label,
        cardsScanned: cards.length,
        extractedAt: Date.now(),
        pageHeight: document.documentElement.scrollHeight,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      },
    };
  }

  /* ================================================================== *
   * Sorting / filtering through the site's own UI
   * ================================================================== */

  async function applySort(mode) {
    hud.setStatus('filtering', 'مرتب‌سازی');
    const labels = adapter.labels?.sort?.[mode] || [];
    if (!labels.length) return { ok: false, method: 'none', reason: 'NO_LABELS' };

    // 1. A native <select> is the easiest and most stable target.
    const select = queryFirst(adapter.selectors?.sortControl || ['select']);
    if (select && select.tagName === 'SELECT') {
      const opt = Array.from(select.options).find((o) => {
        const t = normalizeText(o.textContent || '');
        return labels.some((l) => t.includes(normalizeText(l)));
      });
      if (opt) {
        highlight(select, 'click');
        select.value = opt.value;
        fire(select, 'input');
        fire(select, 'change');
        await sleep(900);
        return { ok: true, method: 'select', label: opt.textContent.trim() };
      }
    }

    // 2. Custom dropdown: open it, then click the matching option.
    const trigger = queryFirst(adapter.selectors?.sortControl || []) ||
      findByText(['مرتب‌سازی', 'مرتب سازی', 'sort'], document, { tags: 'button,div,span,a' });
    if (trigger) {
      highlight(trigger, 'click');
      await scrollIntoViewSmooth(trigger);
      trigger.click();
      await sleep(randInt(350, 650));
      const option = findByText(labels, document, { tags: 'li,button,a,div,span,label,option' });
      if (option) {
        highlight(option, 'click');
        await sleep(randInt(120, 300));
        option.click();
        await sleep(1200);
        return { ok: true, method: 'dropdown', label: normalizeText(option.textContent) };
      }
      // Close what we opened.
      document.body.click();
      await sleep(200);
    }

    return { ok: false, method: 'none', reason: 'CONTROL_NOT_FOUND' };
  }

  async function applyPriceFilter(min, max) {
    if (!min && !max) return { ok: false, method: 'none', reason: 'NO_RANGE' };
    hud.setStatus('filtering', 'فیلتر قیمت');

    const heading = findByText(adapter.labels?.priceFilterHeading || ['محدوده قیمت', 'قیمت'], document, { tags: 'span,div,h1,h2,h3,h4,label,p' });
    const scope = heading ? heading.closest('section,div,fieldset,aside') || heading.parentElement : document;
    const inputs = Array.from(scope.querySelectorAll('input[type="number"],input[type="text"],input[type="tel"],input:not([type])')).filter(isVisible);

    if (inputs.length >= 2) {
      highlight(inputs[0], 'field');
      if (min) await typeHuman(inputs[0], String(min), { clear: true });
      await sleep(200);
      highlight(inputs[1], 'field');
      if (max) await typeHuman(inputs[1], String(max), { clear: true });
      const apply = findByText(adapter.labels?.apply || ['اعمال', 'ثبت'], scope) || queryFirst(['button[type="submit"]'], scope);
      if (apply) {
        highlight(apply, 'click');
        await sleep(randInt(150, 350));
        apply.click();
        await sleep(1400);
        return { ok: true, method: 'inputs' };
      }
      return { ok: true, method: 'inputs-no-apply' };
    }
    return { ok: false, method: 'none', reason: 'NO_PRICE_INPUTS' };
  }

  async function goNextPage() {
    const next = queryFirst(adapter.selectors?.nextPage || []) || findByText(['صفحه بعد', 'بعدی', 'next'], document);
    if (!next) return { ok: false, reason: 'NO_NEXT' };
    highlight(next, 'click');
    await scrollIntoViewSmooth(next);
    next.click();
    await sleep(1500);
    return { ok: true, url: location.href };
  }

  /* ================================================================== *
   * Live HUD + highlight (the "see it happen" layer)
   * ================================================================== */

  const STATUS_FA = {
    idle: 'آماده',
    typing: 'در حال تایپ',
    scrolling: 'در حال اسکرول',
    analyzing: 'در حال تحلیل صفحه',
    filtering: 'در حال اعمال فیلتر',
    navigating: 'در حال جابه‌جایی',
    thinking: 'در حال تفکر',
    ranking: 'در حال رتبه‌بندی',
    ready: 'انجام شد',
    error: 'خطا',
    stopped: 'متوقف شد',
  };

  const hud = {
    root: null,
    statusEl: null,
    detailEl: null,
    barEl: null,
    ring: null,
    cursor: null,

    ensure() {
      if (!state.settings.liveHud) return null;
      if (this.root && document.body.contains(this.root)) return this.root;

      const root = document.createElement('div');
      root.id = 'shopagent-hud';
      root.setAttribute('dir', 'rtl');
      root.innerHTML = `
        <div class="sa-hud-card">
          <div class="sa-hud-head">
            <span class="sa-hud-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 4h10l1.2 2.6a1 1 0 0 1-.9 1.4H6.7a1 1 0 0 1-.9-1.4L7 4Zm-2 6h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/></svg>
            </span>
            <span class="sa-hud-title">خرید‌یار هوشمند</span>
            <button class="sa-hud-close" type="button" aria-label="بستن">&times;</button>
          </div>
          <div class="sa-hud-body">
            <span class="sa-hud-dot"></span>
            <span class="sa-hud-status">آماده</span>
            <span class="sa-hud-detail"></span>
          </div>
          <div class="sa-hud-track"><div class="sa-hud-bar"></div></div>
        </div>`;
      document.documentElement.appendChild(root);

      this.root = root;
      this.statusEl = root.querySelector('.sa-hud-status');
      this.detailEl = root.querySelector('.sa-hud-detail');
      this.barEl = root.querySelector('.sa-hud-bar');
      root.querySelector('.sa-hud-close').addEventListener('click', () => {
        root.classList.add('sa-hidden');
        state.settings.liveHud = false;
        emit('hud-hidden', {});
      });
      root.classList.remove('sa-hidden');
      return root;
    },

    setStatus(status, detail) {
      if (!state.settings.liveHud) return;
      const root = this.ensure();
      if (!root) return;
      root.classList.remove('sa-hidden');
      root.dataset.status = status;
      if (this.statusEl) this.statusEl.textContent = STATUS_FA[status] || status;
      if (this.detailEl) this.detailEl.textContent = detail || '';
      if (!['typing', 'scrolling', 'filtering', 'analyzing'].includes(status)) this.setProgress(null);
    },

    setProgress(p) {
      if (!this.barEl) return;
      if (p === null || p === undefined) this.barEl.style.width = '0%';
      else this.barEl.style.width = `${clamp(p, 0, 1) * 100}%`;
    },

    done(message) {
      this.setStatus('ready', message || '');
      setTimeout(() => this.setProgress(null), 800);
    },

    fail(message) {
      this.setStatus('error', message || '');
      setTimeout(() => this.setStatus('idle', ''), 6000);
    },

    /** Animated ring around the element currently being acted on. */
    highlight(el, kind = 'field', ms = 2600) {
      if (!el || !state.settings.liveHud) return;
      try {
        const existing = document.getElementById('shopagent-ring');
        if (existing) existing.remove();
        const rect = el.getBoundingClientRect();
        const ring = document.createElement('div');
        ring.id = 'shopagent-ring';
        ring.className = `sa-ring sa-ring-${kind}`;
        ring.style.top = `${rect.top + window.scrollY - 4}px`;
        ring.style.left = `${rect.left + window.scrollX - 4}px`;
        ring.style.width = `${rect.width + 8}px`;
        ring.style.height = `${rect.height + 8}px`;
        document.documentElement.appendChild(ring);
        this.ring = ring;
        this.moveCursorTo(rect);
        clearTimeout(ring._t);
        ring._t = setTimeout(() => ring.remove(), ms);
      } catch (e) {
        log.debug('highlight failed', e);
      }
    },

    /** A soft "ghost cursor" that travels to the target, like a real user. */
    moveCursorTo(rect) {
      if (!state.settings.liveHud) return;
      try {
        if (!this.cursor) {
          const c = document.createElement('div');
          c.id = 'shopagent-cursor';
          c.className = 'sa-cursor';
          c.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M5 2.5 19 12l-6.4 1.6L9.8 20 5 2.5Z"/></svg>';
          document.documentElement.appendChild(c);
          this.cursor = c;
        }
        const x = rect.left + window.scrollX + Math.min(rect.width * 0.75, rect.width - 14);
        const y = rect.top + window.scrollY + Math.min(rect.height * 0.6, rect.height - 10);
        this.cursor.style.transform = `translate(${x}px, ${y}px)`;
        this.cursor.classList.add('sa-cursor-active');
      } catch (e) {
        log.debug('cursor failed', e);
      }
    },

    toast(text, ms = 2200) {
      try {
        const t = document.createElement('div');
        t.className = 'sa-toast';
        t.textContent = text;
        t.setAttribute('dir', 'rtl');
        document.documentElement.appendChild(t);
        requestAnimationFrame(() => t.classList.add('sa-toast-in'));
        setTimeout(() => {
          t.classList.remove('sa-toast-in');
          setTimeout(() => t.remove(), 320);
        }, ms);
      } catch {}
    },
  };

  function highlight(el, kind, ms) {
    hud.highlight(el, kind, ms);
  }

  /* ================================================================== *
   * Messaging with the service worker
   * ================================================================== */

  function emit(event, data) {
    try {
      chrome.runtime?.sendMessage({ type: 'SHOPAGENT_EVENT', event, data, url: location.href, at: Date.now() }).catch(() => {});
    } catch {}
  }

  const handlers = {
    PING: async () => ({
      ok: true,
      url: location.href,
      title: document.title,
      store: adapter.id,
      storeLabel: adapter.label,
      ready: document.readyState === 'complete',
      cards: findProductCards(500).length,
      hasSearchInput: Boolean(findSearchInput().el),
    }),

    SYNC_SETTINGS: async ({ settings }) => {
      if (settings) state.settings = { ...state.settings, ...settings };
      if (state.settings.liveHud === false) hud.root?.remove();
      return { ok: true, settings: state.settings };
    },

    SEARCH: async ({ query, submit = true, speed }) => {
      hud.setStatus('typing');
      const found = findSearchInput();
      if (!found.el) {
        hud.fail('کادر جستجو پیدا نشد');
        return { ok: false, reason: 'NO_SEARCH_INPUT', url: location.href };
      }
      await typeHuman(found.el, query, { speed });
      if (submit) {
        const res = await submitSearch(found.el);
        if (!res.ok) hud.fail('نتیجه‌ای لود نشد');
        else hud.setStatus('ready', `${res.cards} کالا`);
        return { ...res, method: found.method };
      }
      return { ok: true, method: found.method, submitted: false };
    },

    SUBMIT_SEARCH: async () => {
      const found = findSearchInput();
      if (!found.el) return { ok: false, reason: 'NO_SEARCH_INPUT' };
      return submitSearch(found.el);
    },

    SCROLL: async (payload) => softScroll(payload),

    EXTRACT: async (payload) => extractProducts(payload),

    SORT: async ({ mode }) => applySort(mode),

    PRICE_FILTER: async ({ min, max }) => applyPriceFilter(min, max),

    NEXT_PAGE: async () => goNextPage(),

    CLICK_TEXT: async ({ labels, tags }) => {
      const el = findByText(labels, document, { tags });
      if (!el) return { ok: false, reason: 'NOT_FOUND' };
      highlight(el, 'click');
      await scrollIntoViewSmooth(el);
      await sleep(randInt(100, 260));
      el.click();
      await sleep(700);
      return { ok: true, label: normalizeText(el.textContent) };
    },

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

    /** Read a single product page (title, price, specs, gallery). */
    READ_PRODUCT: async () => {
      const title = document.querySelector('h1')?.textContent?.trim() || document.title;
      const priceText = queryFirst(adapter.selectors?.productPrice || [])?.textContent || '';
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
    },

    STOP: async () => {
      state.abortController?.abort(new Error('STOPPED'));
      state.running = false;
      hud.setStatus('stopped');
      return { ok: true };
    },

    HUD: async ({ show }) => {
      state.settings.liveHud = Boolean(show);
      if (show) hud.setStatus('idle');
      else hud.root?.remove();
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
        if (aborted) hud.setStatus('stopped');
        else hud.fail(String(err?.message || err).slice(0, 80));
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
        if (s) state.settings = { ...state.settings, ...s };
      });
    } catch {}

    if (state.settings.liveHud) {
      // Only announce ourselves once the page has settled.
      setTimeout(() => {
        hud.setStatus('idle', '');
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
      if (state.settings.liveHud) hud.setStatus('idle', '');
    }
  }, 900);
})();
