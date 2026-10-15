/**
 * ShopAgent — content/actions/interact.js
 * ------------------------------------------------------------------
 * Human-like interaction with the page: typing, submitting a search,
 * soft-scrolling lazy grids, driving the site's own sort/price UI, and
 * the executable action set used by the validated `ACT` protocol
 * (click-by-text, add-to-cart with verification, pagination).
 *
 * Every entry point receives a runtime `ctx` built by content.js:
 *   { settings, signal, isAborted(), throwIfAborted(), adapter }
 * so this module holds no state of its own and stays testable.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { sleep, randInt, clamp } = ShopAgent.utils;
  const dom = ShopAgent.actions.dom;

  const TYPING_DELAY = { slow: [70, 190], normal: [35, 95], fast: [12, 34] };

  /** HUD is owned by hud.js; resolved lazily so load order is free. */
  const hud = () => ShopAgent.actions.hud;

  /* ================================================================== *
   * Human-like typing
   * ================================================================== */

  /**
   * Type into an element exactly the way a person would: focus, then one
   * character at a time with keyboard events, input events and jitter.
   */
  async function typeHuman(ctx, el, text, { clear = true, speed } = {}) {
    if (!el) throw new Error('NO_ELEMENT');
    const str = String(text ?? '');
    const [minDelay, maxDelay] = TYPING_DELAY[speed || ctx.settings.typingSpeed] || TYPING_DELAY.normal;

    await dom.scrollIntoViewSmooth(el);
    hud().setStatus?.('typing', `«${str}»`);
    hud().highlight?.(el, 'field');

    el.focus({ preventScroll: true });
    dom.fire(el, 'focus');
    dom.fire(el, 'focusin');
    try {
      el.click();
    } catch {}
    await sleep(randInt(90, 220));

    if (clear && el.value) {
      // Select-all + delete, like a human clearing the box.
      dom.fireKey(el, 'keydown', { key: 'a', keyCode: 65, ctrlKey: true });
      el.setSelectionRange?.(0, el.value.length);
      await sleep(randInt(40, 90));
      dom.fireKey(el, 'keydown', { key: 'Backspace', keyCode: 8 });
      dom.setNativeValue(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      dom.fireKey(el, 'keyup', { key: 'Backspace', keyCode: 8 });
      dom.fire(el, 'change');
      await sleep(randInt(60, 140));
    }

    let typed = 0;
    for (const ch of str) {
      ctx.throwIfAborted();
      const keyCode = ch.charCodeAt(0);
      dom.fireKey(el, 'keydown', { key: ch, keyCode });
      dom.fireKey(el, 'keypress', { key: ch, keyCode });
      dom.setNativeValue(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: ch, inputType: 'insertText', isComposing: false }));
      dom.fireKey(el, 'keyup', { key: ch, keyCode });
      typed++;
      if (typed % 5 === 0) hud().setProgress?.(clamp(typed / Math.max(str.length, 1), 0, 1));
      ctx.emit?.('typing', { typed, total: str.length });
      // Occasional micro-pause, exactly like a person hesitating.
      await sleep(randInt(minDelay, maxDelay) + (Math.random() < 0.07 ? randInt(120, 320) : 0));
    }

    dom.fire(el, 'change');
    dom.fire(el, 'blur');
    hud().setProgress?.(1);
    return { ok: true, typed };
  }

  function pressEnter(el) {
    dom.fireKey(el, 'keydown', { key: 'Enter', keyCode: 13 });
    dom.fireKey(el, 'keypress', { key: 'Enter', keyCode: 13 });
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    dom.fireKey(el, 'keyup', { key: 'Enter', keyCode: 13 });
  }

  /* ================================================================== *
   * Page kind — the guard that stops us "searching" on a homepage
   * ================================================================== */

  /** DOM signals that only make sense on a listing/results view. */
  function resultsDomSignals() {
    const probes = [
      '[class*="search-result" i]',
      '[data-testid*="search-result" i]',
      '[class*="results-list" i]',
      '[class*="product-list" i]',
      '[class*="Sort" i], select[class*="sort" i]',
    ];
    for (const p of probes) {
      try {
        const el = document.querySelector(p);
        if (el && dom.isVisible(el)) return true;
      } catch {}
    }
    return Boolean(dom.findByText(['نتایج جستجو', 'نتایج', 'results for'], document, { tags: 'h1,h2,h3,span,div' }));
  }

  /**
   * Where are we right now?
   * `results` is only true for a genuine listing: the URL says search, or
   * (when not on the homepage) listing-only DOM signals are present.
   * Homepage carousels must NEVER count as results — that false positive
   * is exactly what made earlier builds scroll the home page instead of
   * searching.
   */
  function pageKind() {
    const cls = ShopAgent.sites.classifyUrl(location.href);
    const domSignals = resultsDomSignals();
    return {
      url: location.href,
      home: cls.home,
      resultsUrl: cls.results,
      resultsDom: domSignals,
      results: cls.results || (!cls.home && domSignals),
    };
  }

  /** Poll until the URL actually becomes a different, results-ish page. */
  async function waitForResultsPage(urlBefore, timeout = 9000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(220);

      if (location.href !== urlBefore) {
        await sleep(600); // let the SPA settle
        const kind = pageKind();
        return { ok: true, url: location.href, urlChanged: true, resultsPage: kind.results, cards: dom.findProductCards(ShopAgent.sites.detect(location.href), 60).length };
      }

      // Same URL: an SPA may have swapped the view in place (history.replaceState).
      const kind = pageKind();
      if (kind.results && kind.resultsUrl) {
        await sleep(400);
        return { ok: true, url: location.href, urlChanged: false, resultsPage: true, cards: dom.findProductCards(ShopAgent.sites.detect(location.href), 60).length };
      }
    }
    return { ok: false, url: location.href, urlChanged: false, resultsPage: pageKind().results };
  }

  /**
   * Submit the typed query, then PROVE we left for a results page.
   * Strategies are tried in order (Enter → real form → visible button)
   * and each one is verified; a no-op click can no longer be mistaken
   * for success.
   */
  async function submitSearch(ctx, inputEl) {
    const adapter = ctx.adapter;
    hud().setStatus?.('typing', 'ارسال جستجو');
    const urlBefore = location.href;
    const form = inputEl.closest('form');
    const btn =
      dom.queryFirst(adapter?.selectors?.searchSubmit || []) ||
      form?.querySelector('button[type="submit"],input[type="submit"]') ||
      dom.findByText(['جستجو', 'سرچ', 'search'], form || document);

    const attempts = [
      async () => {
        pressEnter(inputEl);
      },
    ];
    if (form) {
      attempts.push(async () => {
        hud().highlight?.(form, 'click');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      });
    }
    if (btn) {
      attempts.push(async () => {
        hud().highlight?.(btn, 'click');
        await sleep(randInt(120, 300));
        btn.click();
      });
    }

    for (const attempt of attempts) {
      ctx.throwIfAborted();
      try {
        await attempt();
      } catch {}
      const reached = await waitForResultsPage(urlBefore, 9000);
      if (reached.ok) return reached;
      // Autocomplete overlays love stealing focus; take it back.
      try {
        inputEl.focus({ preventScroll: true });
      } catch {}
      await sleep(randInt(120, 260));
    }

    const kind = pageKind();
    return { ok: false, url: location.href, urlChanged: false, resultsPage: kind.results, home: kind.home, reason: 'SEARCH_DID_NOT_NAVIGATE' };
  }

  /* ================================================================== *
   * Scrolling (lazy load)
   * ================================================================== */

  /**
   * Soft, eased scroll. Keeps going while the document height grows, so
   * infinite-scroll / lazy-image grids fully materialise.
   */
  async function softScroll(ctx, { rounds = 4, stepRatio = 0.85, settleMs = 550, maxIdleRounds = 3 } = {}) {
    const adapter = ctx.adapter;
    hud().setStatus?.('scrolling');
    let lastHeight = document.documentElement.scrollHeight;
    let idle = 0;
    let totalScrolled = 0;

    for (let r = 0; r < rounds; r++) {
      ctx.throwIfAborted();
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
      hud().setProgress?.(clamp((r + 1) / rounds, 0, 1));
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
      ctx.emit?.('scrolling', { round: r + 1, rounds, height: newHeight, loaded: dom.findProductCards(adapter, 500).length });
      if (idle >= maxIdleRounds) break;
    }

    // Scroll back up gently so the first results are in view for the user.
    const backFrom = window.scrollY;
    const started = performance.now();
    await new Promise((resolve) => {
      function frame(now) {
        const p = clamp((now - started) / 900, 0, 1);
        window.scrollTo(0, backFrom + (0 - backFrom) * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });

    return { ok: true, scrolled: Math.round(totalScrolled), height: document.documentElement.scrollHeight, cards: dom.findProductCards(adapter, 500).length };
  }

  /* ================================================================== *
   * Sorting / filtering through the site's own UI
   * ================================================================== */

  async function applySort(ctx, mode) {
    const adapter = ctx.adapter;
    hud().setStatus?.('filtering', 'مرتب‌سازی');
    const labels = adapter?.labels?.sort?.[mode] || [];
    if (!labels.length) return { ok: false, method: 'none', reason: 'NO_LABELS' };

    // 1. A native <select> is the easiest and most stable target.
    const select = dom.queryFirst(adapter?.selectors?.sortControl || ['select']);
    if (select && select.tagName === 'SELECT') {
      const opt = Array.from(select.options).find((o) => {
        const t = ShopAgent.utils.normalizeText(o.textContent || '');
        return labels.some((l) => t.includes(ShopAgent.utils.normalizeText(l)));
      });
      if (opt) {
        hud().highlight?.(select, 'click');
        select.value = opt.value;
        dom.fire(select, 'input');
        dom.fire(select, 'change');
        await sleep(900);
        return { ok: true, method: 'select', label: opt.textContent.trim() };
      }
    }

    // 2. Custom dropdown: open it, then click the matching option.
    const trigger =
      dom.queryFirst(adapter?.selectors?.sortControl || []) ||
      dom.findByText(['مرتب‌سازی', 'مرتب سازی', 'sort'], document, { tags: 'button,div,span,a' });
    if (trigger) {
      hud().highlight?.(trigger, 'click');
      await dom.scrollIntoViewSmooth(trigger);
      trigger.click();
      await sleep(randInt(350, 650));
      const option = dom.findByText(labels, document, { tags: 'li,button,a,div,span,label,option' });
      if (option) {
        hud().highlight?.(option, 'click');
        await sleep(randInt(120, 300));
        option.click();
        await sleep(1200);
        return { ok: true, method: 'dropdown', label: ShopAgent.utils.normalizeText(option.textContent) };
      }
      // Close what we opened.
      document.body.click();
      await sleep(200);
    }

    return { ok: false, method: 'none', reason: 'CONTROL_NOT_FOUND' };
  }

  async function applyPriceFilter(ctx, min, max) {
    if (!min && !max) return { ok: false, method: 'none', reason: 'NO_RANGE' };
    hud().setStatus?.('filtering', 'فیلتر قیمت');

    const heading = dom.findByText(ctx.adapter?.labels?.priceFilterHeading || ['محدوده قیمت', 'قیمت'], document, { tags: 'span,div,h1,h2,h3,h4,label,p' });
    const scope = heading ? heading.closest('section,div,fieldset,aside') || heading.parentElement : document;
    const inputs = Array.from(scope.querySelectorAll('input[type="number"],input[type="text"],input[type="tel"],input:not([type])')).filter(dom.isVisible);

    if (inputs.length >= 2) {
      hud().highlight?.(inputs[0], 'field');
      if (min) await typeHuman(ctx, inputs[0], String(min), { clear: true });
      await sleep(200);
      hud().highlight?.(inputs[1], 'field');
      if (max) await typeHuman(ctx, inputs[1], String(max), { clear: true });
      const apply = dom.findByText(ctx.adapter?.labels?.apply || ['اعمال', 'ثبت'], scope) || dom.queryFirst(['button[type="submit"]'], scope);
      if (apply) {
        hud().highlight?.(apply, 'click');
        await sleep(randInt(150, 350));
        apply.click();
        await sleep(1400);
        return { ok: true, method: 'inputs' };
      }
      return { ok: true, method: 'inputs-no-apply' };
    }
    return { ok: false, method: 'none', reason: 'NO_PRICE_INPUTS' };
  }

  /* ================================================================== *
   * Executable actions (validated `ACT` protocol — see shared/actions.js)
   * ================================================================== */

  /** Click an element found by its visible text. */
  async function clickText(ctx, { labels, tags } = {}) {
    const el = dom.findByText(labels || [], document, { tags });
    if (!el) return { ok: false, reason: 'NOT_FOUND' };
    hud().highlight?.(el, 'click');
    await dom.scrollIntoViewSmooth(el);
    await sleep(randInt(100, 260));
    el.click();
    await sleep(700);
    return { ok: true, label: ShopAgent.utils.normalizeText(el.textContent) };
  }

  /**
   * Add the current product to the cart using tiered button discovery,
   * then VERIFY the result (in-cart label or cart-count badge growth).
   * Never clicks anything payment-related.
   */
  async function addToCart(ctx) {
    const adapter = ctx.adapter;
    const { findBuyButton, detectInCart, readCartCount } = ShopAgent.adapters;
    hud().setStatus?.('filtering', 'افزودن به سبد خرید');

    const countBefore = readCartCount(document);

    let found = null;
    try {
      // Flexible timeout + MutationObserver-backed retry: buy boxes on
      // both stores render lazily, often after the first paint.
      found = await dom.waitFor(() => findBuyButton(document, adapter), { timeout: 9000, interval: 200, signal: ctx.signal });
    } catch {
      found = null;
    }
    if (!found) return { ok: false, reason: 'NO_BUY_BUTTON' };

    hud().highlight?.(found.el, 'click');
    await dom.scrollIntoViewSmooth(found.el);
    await sleep(randInt(120, 300));
    found.el.click();

    // Wait for confirmation evidence instead of assuming success.
    let evidence = detectInCart(document, adapter, countBefore);
    if (!evidence.ok) {
      try {
        await dom.waitFor(() => detectInCart(document, adapter, countBefore).ok, { timeout: 4000, interval: 250, signal: ctx.signal });
        evidence = detectInCart(document, adapter, countBefore);
      } catch {}
    }

    return {
      ok: evidence.ok,
      method: found.method,
      tier: found.tier,
      evidence,
      reason: evidence.ok ? null : 'UNCONFIRMED',
    };
  }

  /** Pagination via the site's own next-page control. */
  async function goNextPage(ctx) {
    const next = dom.queryFirst(ctx.adapter?.selectors?.nextPage || []) || dom.findByText(['صفحه بعد', 'بعدی', 'next'], document);
    if (!next) return { ok: false, reason: 'NO_NEXT' };
    hud().highlight?.(next, 'click');
    await dom.scrollIntoViewSmooth(next);
    next.click();
    await sleep(1500);
    return { ok: true, url: location.href };
  }

  ShopAgent.actions.interact = {
    typeHuman,
    pressEnter,
    pageKind,
    resultsDomSignals,
    waitForResultsPage,
    submitSearch,
    softScroll,
    applySort,
    applyPriceFilter,
    clickText,
    addToCart,
    goNextPage,
  };
})(globalThis);
