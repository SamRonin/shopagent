/**
 * ShopAgent — content/actions/click.js
 * ------------------------------------------------------------------
 * Every click-like DOM action: guarded clicking, search submission with
 * verified navigation, site-level sorting, price filters and pagination.
 * Clicks that could mutate the user's cart / orders route through the
 * Human-in-the-Loop guard (actions/guard.js) before they fire.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { sleep, randInt, normalizeText } = ShopAgent.utils;
  const dom = ShopAgent.actions.dom;
  const hud = () => ShopAgent.actions.hud;
  const events = ShopAgent.actions.events;

  /* ------------------------------------------------------------------ *
   * Page-kind gate (never "search" on a homepage)
   * ------------------------------------------------------------------ */

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

  function pageKind(adapter) {
    const cls = ShopAgent.sites.classifyUrl ? ShopAgent.sites.classifyUrl(location.href) : { home: false, results: false };
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
      dom.rt?.throwIfAborted();
      await sleep(220);

      if (location.href !== urlBefore) {
        await sleep(600); // let the SPA settle
        const kind = pageKind();
        return { ok: true, url: location.href, urlChanged: true, resultsPage: kind.results, cards: dom.findProductCards(null, 60).length };
      }

      // Same URL: an SPA may have swapped the view in place (replaceState).
      const kind = pageKind();
      if (kind.results && kind.resultsUrl) {
        await sleep(400);
        return { ok: true, url: location.href, urlChanged: false, resultsPage: true, cards: dom.findProductCards(null, 60).length };
      }
    }
    return { ok: false, url: location.href, urlChanged: false, resultsPage: pageKind().results };
  }

  /* ------------------------------------------------------------------ *
   * Guarded click
   * ------------------------------------------------------------------ */

  /**
   * Assess a prospective click, ask the user when risky, then click.
   * @returns {{ok:boolean, risk?:string, reason?:string, label?:string}}
   */
  async function guardedClick(el, { highlightKind = 'click' } = {}) {
    const guard = ShopAgent.actions.guard;
    const verdict = guard.assessElement(el);

    if (verdict.risk === 'blocked') {
      hud().fail('این دکمه توسط گاردریل مسدود شد');
      return { ok: false, risk: 'blocked', reason: verdict.reason, matched: verdict.matched };
    }

    if (verdict.risk === 'confirm') {
      const approved = await guard.confirmWithUser({
        title: verdict.label || normalizeText(el.textContent).slice(0, 60),
        detail: verdict.reason,
        risk: verdict.risk,
        url: location.href,
        matched: verdict.matched,
      });
      if (!approved) {
        return { ok: false, risk: 'confirm', reason: 'DENIED_BY_USER' };
      }
    }

    hud().highlight(el, highlightKind);
    await events.scrollIntoViewSmooth(el);
    await sleep(randInt(100, 260));
    el.click();
    return { ok: true, risk: verdict.risk, label: normalizeText(el.textContent).slice(0, 80) };
  }

  /* ------------------------------------------------------------------ *
   * Search submission (typed query → verified results page)
   * ------------------------------------------------------------------ */

  /**
   * Submit the typed query, then PROVE we left for a results page.
   * Strategies in order (Enter → real form → visible button), each one
   * verified; a no-op click can no longer be mistaken for success.
   */
  async function submitSearch(inputEl, adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    hud().setStatus('typing', 'ارسال جستجو');
    const urlBefore = location.href;
    const form = inputEl.closest('form');
    const btn =
      dom.queryFirst(ad.selectors?.searchSubmit || []) ||
      form?.querySelector('button[type="submit"],input[type="submit"]') ||
      dom.findByText(['جستجو', 'سرچ', 'search'], form || document);

    const attempts = [
      async () => {
        await events.pressEnter(inputEl);
      },
    ];
    if (form) {
      attempts.push(async () => {
        hud().highlight(form, 'click');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      });
    }
    if (btn) {
      attempts.push(async () => {
        hud().highlight(btn, 'click');
        await sleep(randInt(120, 300));
        btn.click();
      });
    }

    for (const attempt of attempts) {
      dom.rt?.throwIfAborted();
      try {
        await attempt();
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
      }
      const reached = await waitForResultsPage(urlBefore, 9000);
      if (reached.ok) return reached;
      // Autocomplete overlays love stealing focus; take it back.
      try {
        inputEl.focus({ preventScroll: true });
      } catch {}
      await sleep(randInt(120, 260));
    }

    const kind = pageKind();
    return {
      ok: false,
      url: location.href,
      urlChanged: false,
      resultsPage: kind.results,
      home: kind.home,
      reason: 'SEARCH_DID_NOT_NAVIGATE',
    };
  }

  /* ------------------------------------------------------------------ *
   * Site-level sorting / filtering / pagination
   * ------------------------------------------------------------------ */

  async function applySort(mode, adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    hud().setStatus('filtering', 'مرتب‌سازی');
    const labels = ad.labels?.sort?.[mode] || [];
    if (!labels.length) return { ok: false, method: 'none', reason: 'NO_LABELS' };

    // 1. A native <select> is the easiest and most stable target.
    const select = dom.queryFirst(ad.selectors?.sortControl || ['select']);
    if (select && select.tagName === 'SELECT') {
      const opt = Array.from(select.options).find((o) => {
        const t = normalizeText(o.textContent || '');
        return labels.some((l) => t.includes(normalizeText(l)));
      });
      if (opt) {
        hud().highlight(select, 'click');
        select.value = opt.value;
        events.fire(select, 'input');
        events.fire(select, 'change');
        await sleep(900);
        return { ok: true, method: 'select', label: opt.textContent.trim() };
      }
    }

    // 2. Custom dropdown: open it, then click the matching option.
    const trigger = dom.queryFirst(ad.selectors?.sortControl || []) || dom.findByText(['مرتب‌سازی', 'مرتب سازی', 'sort'], document, { tags: 'button,div,span,a' });
    if (trigger) {
      hud().highlight(trigger, 'click');
      await events.scrollIntoViewSmooth(trigger);
      trigger.click();
      await sleep(randInt(350, 650));
      const option = dom.findByText(labels, document, { tags: 'li,button,a,div,span,label,option' });
      if (option) {
        hud().highlight(option, 'click');
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

  async function applyPriceFilter(min, max, adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    if (!min && !max) return { ok: false, method: 'none', reason: 'NO_RANGE' };
    hud().setStatus('filtering', 'فیلتر قیمت');

    const heading = dom.findByText(ad.labels?.priceFilterHeading || ['محدوده قیمت', 'قیمت'], document, { tags: 'span,div,h1,h2,h3,h4,label,p' });
    const scope = heading ? heading.closest('section,div,fieldset,aside') || heading.parentElement : document;
    const inputs = Array.from(scope.querySelectorAll('input[type="number"],input[type="text"],input[type="tel"],input:not([type])')).filter(dom.isVisible);

    if (inputs.length >= 2) {
      hud().highlight(inputs[0], 'field');
      if (min) await events.typeHuman(inputs[0], String(min), { clear: true });
      await sleep(200);
      hud().highlight(inputs[1], 'field');
      if (max) await events.typeHuman(inputs[1], String(max), { clear: true });
      const apply = dom.findByText(ad.labels?.apply || ['اعمال', 'ثبت'], scope) || dom.queryFirst(['button[type="submit"]'], scope);
      if (apply) {
        hud().highlight(apply, 'click');
        await sleep(randInt(150, 350));
        apply.click();
        await sleep(1400);
        return { ok: true, method: 'inputs' };
      }
      return { ok: true, method: 'inputs-no-apply' };
    }
    return { ok: false, method: 'none', reason: 'NO_PRICE_INPUTS' };
  }

  async function goNextPage(adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    const next = dom.queryFirst(ad.selectors?.nextPage || []) || dom.findByText(['صفحه بعد', 'بعدی', 'next'], document);
    if (!next) return { ok: false, reason: 'NO_NEXT' };
    const res = await guardedClick(next);
    if (res.ok) await sleep(1500);
    return { ok: Boolean(res.ok), url: location.href, ...(res.ok ? {} : { reason: res.reason || 'CLICK_REFUSED' }) };
  }

  /** Click the first clickable element matching one of the given labels. */
  async function clickText(labels, tags) {
    const el = dom.findByText(labels, document, { tags });
    if (!el) return { ok: false, reason: 'NOT_FOUND' };
    const res = await guardedClick(el);
    if (res.ok) await sleep(700);
    return res;
  }

  ShopAgent.actions.click = { pageKind, resultsDomSignals, waitForResultsPage, submitSearch, applySort, applyPriceFilter, goNextPage, clickText, guardedClick };
})(globalThis);
