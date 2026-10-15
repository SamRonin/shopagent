/**
 * ShopAgent — background/pipeline.js
 * ------------------------------------------------------------------
 * The task pipeline: intent → navigate → type → scroll → filter →
 * extract → rank, plus the streamed `question` answering and the
 * guarded add-to-cart orchestration. All progress goes through
 * bg.core.emitProgress; all model traffic through shared/llm.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const bg = ShopAgent.bg;
  const { core, tabs } = bg;
  const log = ShopAgent.utils.logger('bg.pipeline');

  /* ================================================================== *
   * Streamed free-form answer for `question` intents
   * ================================================================== */

  async function answerQuestion(taskId, text, settings, signal) {
    const lang = settings.language || 'fa';
    core.emitProgress(taskId, 'thinking', lang === 'fa' ? 'دارم جوابت رو می‌نویسم…' : 'Writing your answer…');
    const messages = [
      {
        role: 'system',
        content:
          lang === 'fa'
            ? 'تو «خرید‌یار هوشمند» هستی، دستیار خرید فارسی داخل یک اکستنشن مرورگر. کوتاه، دقیق و کاربردی جواب بده (حداکثر ۶ جمله). اگر سؤال دربارهٔ قیمت/محصول مشخص است، راهنمایی کن کاربر چه عبارتی سرچ کند. از Markdown استفاده نکن.'
            : 'You are ShopAgent, a shopping assistant inside a browser extension. Answer briefly and practically (max 6 sentences). No markdown.',
      },
      { role: 'user', content: String(text || '').slice(0, 1000) },
    ];

    const res = await ShopAgent.llm.chat(settings, { messages, json: false, temperature: 0.4, timeoutMs: 60000, signal, stream: true, onDelta: core.makeStreamRelay(taskId) });

    if (!res.ok || !String(res.text || '').trim()) {
      const f = ShopAgent.errors.friendly(res.error || 'BAD_JSON', { lang, provider: settings.provider });
      core.emitProgress(taskId, 'error', f.message);
      return { ok: false, chat: true, friendly: f, error: String(res.error || 'BAD_JSON') };
    }
    return { ok: true, chat: true, answer: res.text, model: res.model, latencyMs: res.latencyMs };
  }

  /* ================================================================== *
   * Add-to-cart orchestration (the flagship Human-in-the-Loop action)
   * ================================================================== */

  async function runAddToCart({ url, tabId }) {
    // Never navigate to a checkout-ish URL no matter who asked.
    const risk = ShopAgent.guardrails.assessUrl(url || '');
    if (url && risk.risk === 'blocked') {
      return { ok: false, error: 'BLOCKED_ACTION', friendly: { message: risk.reason, kind: 'blocked' } };
    }

    let tab = null;
    if (tabId) {
      tab = await chrome.tabs.get(tabId).catch(() => null);
    } else if (url) {
      const all = await chrome.tabs.query({});
      tab = all.find((t) => (t.url || '').split('#')[0] === url.split('#')[0]) || null;
      if (!tab) tab = await chrome.tabs.create({ url, active: true });
    } else {
      tab = await tabs.activeTab();
    }
    if (!tab) return { ok: false, error: 'NO_TAB' };

    await tabs.waitForTab(tab.id, { timeout: 30000 });
    await tabs.ensureContent(tab.id);

    // The content script asks the user for approval before it clicks.
    const res = await tabs.sendToContent(tab.id, 'ADD_TO_CART', {}, 120000);
    return res;
  }

  /* ================================================================== *
   * The main pipeline
   * ================================================================== */

  async function runTask(taskId, { text, store, tabId, settings }) {
    const task = core.getTask(taskId);
    if (!task) throw new Error('NO_TASK');
    const signal = task.abort.signal;
    const startedAt = Date.now();
    const lang = settings.language || 'fa';

    core.startKeepAlive();

    try {
      /* ---------- 1. Understand the request (streamed) ---------- */
      core.emitProgress(taskId, 'thinking', lang === 'fa' ? 'دستورت رو تحلیل می‌کنم…' : 'Understanding your request…');
      const intent = await ShopAgent.llm.parseIntent(text, settings, { signal, onDelta: core.makeStreamRelay(taskId) });
      core.emitProgress(taskId, 'thinking', intent.explanation || intent.query, { intent });

      if (intent.intent === 'question') {
        const chatRes = await answerQuestion(taskId, text, settings, signal);
        if (!chatRes.ok) return chatRes;
        const payload = {
          ok: true,
          chat: true,
          answer: chatRes.answer,
          intent,
          meta: { durationMs: Date.now() - startedAt, engine: intent.source, model: intent.model || null },
          taskId,
          query: text,
          at: Date.now(),
        };
        core.emitProgress(taskId, 'ready', lang === 'fa' ? 'پاسخ آماده شد' : 'Answer ready');
        return payload;
      }

      if (intent.intent === 'unknown' || !intent.query) {
        core.emitProgress(taskId, 'error', lang === 'fa' ? 'نتونستم بفهمم دنبال چه کالایی هستی.' : 'Could not identify a product in your request.');
        return { ok: false, error: 'EMPTY_QUERY', intent, products: [] };
      }

      /* ---------- 2. Resolve the tab ---------- */
      const wantedStore = intent.targetStore || store || settings.preferredStore || 'digikala';
      core.emitProgress(taskId, 'navigating', lang === 'fa' ? `باز کردن ${wantedStore === 'basalam' ? 'باسلام' : 'دیجی‌کالا'}` : `Opening ${wantedStore}`);

      let tab;
      try {
        const resolved = await tabs.resolveTab(wantedStore);
        tab = tabId ? await chrome.tabs.get(tabId).catch(() => resolved.tab) : resolved.tab;
        tab = await tabs.waitForTab(tab.id);
      } catch (e) {
        core.emitProgress(taskId, 'error', String(e.message || e));
        return { ok: false, error: 'TAB_ERROR', detail: String(e.message || e), intent, products: [] };
      }

      // Re-read settings in case they changed mid-flight.
      await tabs.sendToContent(tab.id, 'SYNC_SETTINGS', {
        settings: {
          typingSpeed: settings.typingSpeed,
          liveHud: settings.liveHud,
          autoScroll: settings.autoScroll,
          language: settings.language,
          maxResults: settings.maxResults,
        },
      }).catch(() => {});

      const ping = await tabs.ensureContent(tab.id);
      log.info('content ready on', ping.store, ping.url);

      /* ---------- 3. Search: type it live ---------- */
      const adapter = ShopAgent.sites[ping.store] || ShopAgent.sites.detect(tab.url);
      const templates = typeof adapter.searchUrl === 'function' ? adapter.searchUrl(intent.query) : [];
      let searchResult = null;

      if (adapter.id === wantedStore || wantedStore === 'current') {
        core.emitProgress(taskId, 'typing', `«${intent.query}»`, { query: intent.query });
        try {
          searchResult = await tabs.sendToContent(tab.id, 'SEARCH', { query: intent.query, submit: true, speed: settings.typingSpeed }, 60000);
        } catch (e) {
          log.warn('live typing failed:', e?.message);
          searchResult = { ok: false, reason: String(e?.message || e) };
        }
        if (searchResult && !searchResult.ok) {
          log.warn('live search reported:', searchResult.reason || 'failed', '→ results-page gate will take over');
        }
      }

      // A full navigation kills the old content script: re-arm it.
      await tabs.ensureContent(tab.id).catch((e) => log.warn('re-ensure after search failed', e?.message));

      /* ---------- 3b. HARD GATE: we must be on a results page ---------- */
      const gate = await tabs.ensureOnResultsPage(tab, adapter, settings, {
        liveSearch: searchResult,
        templates,
        onStatus: (status, detail) => core.emitProgress(taskId, status, detail),
      });

      if (!gate.ok) {
        core.emitProgress(taskId, 'error', lang === 'fa' ? 'نتوانستم به صفحهٔ نتایج جستجو بروم.' : 'Could not reach a search-results page.');
        return { ok: false, error: gate.error || 'NO_SEARCH_PATH', intent, products: [] };
      }
      tab = gate.tab || tab;

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      /* ---------- 4. Scroll so lazy content loads ---------- */
      if (settings.autoScroll !== false) {
        core.emitProgress(taskId, 'scrolling', lang === 'fa' ? 'دارم صفحه رو نرم اسکرول می‌کنم تا همه کالاها لود بشن' : 'Soft-scrolling to load every product');
        await tabs.sendToContent(tab.id, 'SCROLL', { rounds: 4, settleMs: 500 }, 60000).catch((e) => log.warn('scroll failed', e?.message));
      }

      /* ---------- 5. Best-effort site-level sorting & price filter ---------- */
      if (intent.sort && intent.sort !== 'best_match') {
        core.emitProgress(taskId, 'filtering', lang === 'fa' ? `مرتب‌سازی: ${intent.sort}` : `Sorting: ${intent.sort}`);
        const sortRes = await tabs.sendToContent(tab.id, 'SORT', { mode: intent.sort }, 25000).catch(() => ({ ok: false }));
        if (sortRes?.ok) await ShopAgent.utils.sleep(900);
        log.info('site sort:', sortRes?.method || 'fallback to client-side sorting');
      }

      if (intent.minPrice || intent.maxPrice) {
        core.emitProgress(taskId, 'filtering', lang === 'fa' ? 'اعمال فیلتر قیمت' : 'Applying price filter');
        await tabs.sendToContent(tab.id, 'PRICE_FILTER', { min: intent.minPrice, max: intent.maxPrice }, 30000).catch(() => ({ ok: false }));
        await ShopAgent.utils.sleep(900);
      }

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      /* ---------- 6. Extract ---------- */
      core.emitProgress(taskId, 'analyzing', lang === 'fa' ? 'خوندن قیمت‌ها و مشخصات' : 'Reading prices and specs');
      const extraction = await tabs.sendToContent(tab.id, 'EXTRACT', { limit: 80 }, 60000);
      if (!extraction || !extraction.ok) {
        core.emitProgress(taskId, 'error', extraction?.error || 'EXTRACT_FAILED');
        return { ok: false, error: 'EXTRACT_FAILED', intent, products: [] };
      }

      let products = extraction.products || [];
      core.emitProgress(taskId, 'analyzing', lang === 'fa' ? `${products.length} کالا استخراج شد` : `${products.length} products extracted`, { count: products.length });

      if (!products.length) {
        core.emitProgress(taskId, 'ready', lang === 'fa' ? 'کالایی پیدا نشد' : 'No products found');
        return { ok: true, intent, products: [], meta: extraction.meta, empty: true };
      }

      // Hard client-side budget guard (the site filter is best-effort only).
      if (intent.maxPrice) {
        const inBudget = products.filter((p) => p.price && p.price <= intent.maxPrice);
        if (inBudget.length >= 2) products = inBudget;
      }
      if (intent.minPrice) {
        const above = products.filter((p) => p.price && p.price >= intent.minPrice);
        if (above.length >= 2) products = above;
      }
      products = products.filter((p) => p.inStock !== false);

      /* ---------- 7. Rank ---------- */
      core.emitProgress(taskId, 'ranking', lang === 'fa' ? 'انتخاب بهترین گزینه‌ها' : 'Picking the best options');
      const maxPicks = intent.maxResults || settings.maxResults || 6;
      const ranked = await ShopAgent.llm.rankProducts(products, intent, { settings, userText: text, lang, maxPicks, signal });

      const durationMs = Date.now() - startedAt;
      const payload = {
        ok: true,
        intent,
        products: ranked,
        allCount: (extraction.products || []).length,
        meta: { ...(extraction.meta || {}), durationMs, engine: intent.source, model: intent.model || null },
        taskId,
        query: text,
        at: Date.now(),
      };

      core.emitProgress(taskId, 'ready', lang === 'fa' ? `${ranked.length} پیشنهاد آماده شد` : `${ranked.length} picks ready`, { count: ranked.length });
      chrome.storage.local.set({ lastRun: payload }).catch(() => {});
      ShopAgent.store.pushHistory({ query: text, intent: { ...intent }, count: ranked.length, durationMs }).catch(() => {});

      return payload;
    } catch (err) {
      const aborted = err?.name === 'AbortError' || /aborted|stopped/i.test(String(err?.message || err));
      const f = ShopAgent.errors.friendly(err, { lang, provider: settings.provider });
      core.emitProgress(taskId, aborted ? 'stopped' : 'error', aborted ? String(err?.message || err).slice(0, 160) : f.message);
      log.error('task failed', err);
      return aborted ? { ok: false, aborted, error: String(err?.message || err) } : { ok: false, error: String(err?.message || err), friendly: f };
    } finally {
      core.stopKeepAlive();
      setTimeout(() => core.setBadge('idle'), 4000);
    }
  }

  bg.pipeline = { runTask, answerQuestion, runAddToCart };
})(globalThis);
