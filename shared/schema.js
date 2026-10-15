/**
 * ShopAgent — shared/schema.js
 * ------------------------------------------------------------------
 * Schema validation for everything a model is allowed to tell us.
 *
 * LLM output is UNTRUSTED: fields come back with wrong types, hallucinated
 * values, or missing entirely. Instead of trusting and crashing, every
 * validator returns { ok, value, errors } where `value` is always a safe,
 * normalised object and `errors` is a human-readable list (also fed back
 * to the model by the auto-repair loop in llm.parseIntent).
 *
 * Pure functions only — runs in Node tests, worker and content script.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { clamp } = ShopAgent.utils;

  const SORTS = ['best_match', 'bestselling', 'cheapest', 'expensive', 'newest', 'discount'];
  const INTENTS = ['search', 'filter', 'compare', 'question', 'unknown'];
  const STORES = ['digikala', 'basalam'];

  const EMPTY_INTENT = {
    intent: 'search',
    query: '',
    minPrice: null,
    maxPrice: null,
    sort: 'best_match',
    brand: null,
    category: null,
    attributes: [],
    targetStore: null,
    maxResults: 6,
    confidence: 0,
    source: 'builtin',
    explanation: '',
  };

  /* ------------------------------------------------------------------ *
   * Primitives
   * ------------------------------------------------------------------ */

  function isMissing(v) {
    return v === null || v === undefined || v === '';
  }

  function asString(v, max) {
    if (isMissing(v)) return null;
    const s = String(v).trim();
    if (!s) return null;
    return max ? s.slice(0, max) : s;
  }

  function asMoney(v, errors, field) {
    if (isMissing(v)) return null;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`${field}: مقدار عددی معتبر نیست (${JSON.stringify(v)}) — null در نظر گرفته شد.`);
      return null;
    }
    if (n > 50_000_000_000_000) {
      errors.push(`${field}: مقدار غیرمعقول است (${n}) — null در نظر گرفته شد.`);
      return null;
    }
    return Math.round(n);
  }

  function asArray(v, errors, field, { maxItems = 8, maxLen = 60 } = {}) {
    if (isMissing(v)) return [];
    if (!Array.isArray(v)) {
      // Models love comma strings: "بی‌سیم, نویز کنسلینگ"
      if (typeof v === 'string') {
        return v
          .split(/[,،]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, maxItems);
      }
      errors.push(`${field}: باید آرایه باشد — [] در نظر گرفته شد.`);
      return [];
    }
    return v
      .map((x) => String(x ?? '').trim().slice(0, maxLen))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  /* ------------------------------------------------------------------ *
   * Intent
   * ------------------------------------------------------------------ */

  /** Cheap last-resort query extraction (shared with the offline parser). */
  function extractQueryFallback(text, STOP_WORDS) {
    let s = String(text || '');
    s = s.replace(/(از|تا|بین|زیر|بالای|کمتر از|بیشتر از|حداکثر|حداقل)?\s*[\d.,]+\s*(هزار|میلیون|میلیارد)?\s*(تومان|تومن|ریال)?/g, ' ');
    s = s.replace(/\d+/g, ' ');
    const tokens = s
      .split(' ')
      .map((w) => w.replace(/[؟?!.,;:«»"'()\[\]{}٪%*_\-–—]+/g, '').trim())
      .filter((w) => w && w.length > 1 && !(STOP_WORDS || []).includes(w));
    return [...new Set(tokens)].slice(0, 6).join(' ');
  }

  /**
   * Validate + normalise a model-produced intent object.
   * @param {*} raw anything the model returned (already JSON-parsed or not)
   * @param {{originalText?:string, settings?:object, stopWords?:string[]}} [ctx]
   * @returns {{ok:boolean, value:object, errors:string[]}}
   */
  function validateIntent(raw, ctx = {}) {
    const errors = [];
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!obj) errors.push('پاسخ مدل یک آبجکت JSON نبود.');

    const value = { ...EMPTY_INTENT };

    // intent kind
    const kind = obj ? asString(obj.intent, 20) : null;
    if (kind && INTENTS.includes(kind)) value.intent = kind;
    else if (kind) errors.push(`intent: مقدار «${kind}» مجاز نیست — یکی از ${INTENTS.join('|')}.`);

    // query (mandatory)
    const query = obj ? asString(obj.query, 160) : null;
    if (query) value.query = query;
    else {
      const fb = extractQueryFallback(ctx.originalText || '', ctx.stopWords);
      if (fb) {
        value.query = fb;
        errors.push('query: مدل خالی فرستاد — از متن کاربر بازیابی شد.');
      } else {
        errors.push('query: الزامی است و از متن کاربر هم قابل بازیابی نبود.');
      }
    }

    // prices
    value.minPrice = obj ? asMoney(obj.minPrice, errors, 'minPrice') : null;
    value.maxPrice = obj ? asMoney(obj.maxPrice, errors, 'maxPrice') : null;
    if (value.minPrice && value.maxPrice && value.minPrice > value.maxPrice) {
      [value.minPrice, value.maxPrice] = [value.maxPrice, value.minPrice];
      errors.push('minPrice > maxPrice بود — دو مقدار جابه‌جا شدند.');
    }

    // sort
    const sort = obj ? asString(obj.sort, 20) : null;
    if (sort && SORTS.includes(sort)) value.sort = sort;
    else if (sort && !SORTS.includes(sort)) errors.push(`sort: مقدار «${sort}» مجاز نیست — best_match در نظر گرفته شد.`);

    // misc strings
    value.brand = obj ? asString(obj.brand, 40) : null;
    value.category = obj ? asString(obj.category, 60) : null;
    value.explanation = obj ? asString(obj.explanation, 400) || '' : '';
    const store = obj ? asString(obj.targetStore, 20) : null;
    if (store && STORES.includes(store)) value.targetStore = store;
    else if (store) errors.push(`targetStore: «${store}» پشتیبانی نمی‌شود — نادیده گرفته شد.`);

    // arrays
    value.attributes = obj ? asArray(obj.attributes, errors, 'attributes') : [];

    // numbers
    const conf = Number(obj?.confidence);
    value.confidence = Number.isFinite(conf) ? clamp(conf, 0, 1) : 0;
    const mr = parseInt(obj?.maxResults, 10);
    if (Number.isFinite(mr)) value.maxResults = clamp(mr, 1, 24);
    else if (!isMissing(obj?.maxResults)) errors.push('maxResults: عدد صحیح ۱ تا ۲۴ لازم است.');

    // Any hallucinated command channel must be stripped — actions are only
    // ever executed through the guarded pipeline, never on model say-so.
    if (obj && ['action', 'command', 'click', 'navigate'].some((k) => k in obj)) {
      errors.push('مدل فیلد اجرای اکشن فرستاده است؛ به‌دلایل امنیتی نادیده گرفته شد (اکشن‌ها فقط از مسیر محافظت‌شده اجرا می‌شوند).');
    }

    return { ok: errors.length === 0, value, errors };
  }

  /* ------------------------------------------------------------------ *
   * Ranking
   * ------------------------------------------------------------------ */

  /**
   * Validate a model-produced ranking against the concrete product pool.
   * Unknown/hallucinated ids are dropped (never trusted), ranks are
   * repaired, `why` strings are length-capped.
   *
   * @param {*} raw parsed model output (object with picks, or bare array)
   * @param {Array<{id:string}>} pool products the model actually saw
   * @returns {{ok:boolean, value:Array, errors:string[]}}
   */
  function validateRanking(raw, pool = []) {
    const errors = [];
    const byId = new Map(pool.map((p) => [String(p.id), p]));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.picks) ? raw.picks : null;

    if (!list) {
      errors.push('پاسخ رتبه‌بندی نه آرایه بود و نه شامل «picks».');
      return { ok: false, value: [], errors };
    }
    if (list.length > pool.length * 2 + 4) {
      errors.push(`مدل ${list.length} گزینه برگرداند در حالی که فقط ${pool.length} کالا دیده بود.`);
    }

    const value = [];
    for (const item of list) {
      if (value.length >= pool.length) break; // never more picks than products
      const prod = byId.get(String(item?.id));
      if (!prod) {
        errors.push(`picks: شناسه «${item?.id ?? '?'}» در محصولات ورودی وجود ندارد — حذف شد.`);
        continue;
      }
      const rank = Number.isFinite(Number(item?.rank)) ? clamp(Math.round(Number(item.rank)), 1, 99) : value.length + 1;
      const score = Number.isFinite(Number(item?.score)) ? clamp(Math.round(Number(item.score)), 0, 100) : null;
      value.push({
        ...prod,
        rank,
        score,
        why: asString(item?.why, 240) || null,
      });
    }

    value.sort((a, b) => a.rank - b.rank);
    return { ok: errors.length === 0, value, errors };
  }

  ShopAgent.schema = { SORTS, INTENTS, STORES, EMPTY_INTENT, validateIntent, validateRanking, extractQueryFallback };
})(globalThis);
