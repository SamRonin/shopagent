/**
 * ShopAgent — content/actions/dom.js
 * ------------------------------------------------------------------
 * DOM primitives: visibility, tiered queries, text lookup, synthetic
 * events and the resilient `waitFor` (flexible timeout + smart retry
 * via MutationObserver) used for lazily-rendered elements.
 *
 * No page-specific knowledge lives here; store specifics come from the
 * adapters. This module never talks to the network or the model.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, toEnglishDigits } = ShopAgent.utils;

  /* ------------------------------------------------------------------ *
   * Visibility
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
  }

  /* ------------------------------------------------------------------ *
   * Tiered queries
   * ------------------------------------------------------------------ */

  /** Try each selector in order; ignore invalid ones instead of crashing. */
  function queryFirst(selectors, scope = document, { visibleOnly = true } = {}) {
    if (!Array.isArray(selectors)) return null;
    for (const sel of selectors) {
      try {
        const found = scope.querySelectorAll(sel);
        for (const el of found) {
          if (!visibleOnly || isVisible(el)) return el;
        }
      } catch {
        // invalid selector for this engine — skip it
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
      const txt = normalizeText(toEnglishDigits(el.textContent || ''));
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
   * Resilient waiting — the lazy-load answer
   * ------------------------------------------------------------------ */

  /**
   * Wait until `predicate` returns a truthy value.
   *
   * Polls on an interval AND reacts to DOM mutations (childList /
   * class / hidden / disabled) so a lazily-rendered element is picked
   * up the moment it appears instead of at the next tick. Resolves
   * with the predicate's value; rejects with WAIT_TIMEOUT or AbortError.
   *
   * @param {() => any} predicate
   * @param {{timeout?:number, interval?:number, signal?:AbortSignal}} [opts]
   */
  function waitFor(predicate, { timeout = 6000, interval = 150, signal } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let done = false;
      let poll = null;
      let observer = null;

      const cleanup = () => {
        done = true;
        if (poll) clearInterval(poll);
        if (observer) observer.disconnect();
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      function onAbort() {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      }

      function check() {
        if (done) return;
        let value = null;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) {
          cleanup();
          resolve(value);
          return;
        }
        if (Date.now() >= deadline) {
          cleanup();
          reject(new Error('WAIT_TIMEOUT'));
        }
      }

      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      check();
      if (done) return;

      poll = setInterval(check, interval);
      try {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden'],
        });
      } catch {}
    });
  }

  /** Wait for the first element matching `selectors` (or a predicate). */
  function waitForElement(selectors, { timeout = 6000, interval = 150, visibleOnly = true, signal, scope = document } = {}) {
    const predicate =
      typeof selectors === 'function'
        ? selectors
        : () => queryFirst(Array.isArray(selectors) ? selectors : [selectors], scope, { visibleOnly });
    return waitFor(predicate, { timeout, interval, signal });
  }

  /* ------------------------------------------------------------------ *
   * Synthetic events — dispatch what a real browser would dispatch
   * ------------------------------------------------------------------ */

  function fire(el, type, init = {}) {
    try {
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    } catch {}
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
    } catch {}
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

  /* ------------------------------------------------------------------ *
   * Scrolling
   * ------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------ *
   * Page-model discovery
   * ------------------------------------------------------------------ */

  /** The search box, found four different ways. */
  function findSearchInput(adapter) {
    // 1. Adapter selectors
    let el = queryFirst(adapter?.selectors?.searchInput || []);
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

  /**
   * Product cards: declared selectors first, structural heuristics when
   * they miss, nested duplicates removed (outermost card wins).
   */
  function findProductCards(adapter, limit = 300) {
    const { cardScore, heuristicCards } = ShopAgent.sites;
    // 1. Declared selectors
    let cards = queryAll(adapter?.selectors?.productCard || []);
    // Keep only elements that actually look like a card.
    cards = cards.filter((el) => (cardScore ? cardScore(el, adapter) : 50) >= 45);

    // 2. Structural heuristics when the declared selectors missed.
    if (cards.length < 3 && heuristicCards) {
      const heur = heuristicCards(document, adapter, limit);
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

  ShopAgent.actions = ShopAgent.actions || {};
  ShopAgent.actions.dom = {
    isVisible,
    queryFirst,
    queryAll,
    findByText,
    waitFor,
    waitForElement,
    fire,
    fireKey,
    keyToCode,
    setNativeValue,
    scrollIntoViewSmooth,
    findSearchInput,
    findProductCards,
  };
})(globalThis);
