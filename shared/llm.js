/**
 * ShopAgent — shared/llm.js
 * ------------------------------------------------------------------
 * The AI core. Three interchangeable providers, all free:
 *
 *   1. `ollama`  — local, offline, zero cost (default)
 *   2. `groq`    — free API key, very fast
 *   3. `gemini`  — Google free tier
 *   4. `builtin` — rule-based Persian parser, no network at all
 *
 * Transport lives in background/providers/*.js behind ONE interface:
 * `complete({ prompt, systemPrompt, model, … })`. This file only knows
 * how to *talk to a model safely*:
 *
 *   • parseJsonLoose()  — broken JSON from small local models is the
 *                         norm, not the exception: fences, trailing
 *                         commas, single quotes, smart quotes, unquoted
 *                         keys, truncated objects — all repaired.
 *   • completeJson()    — parse + schema-validate, then ONE automatic
 *                         self-correction round that tells the model
 *                         exactly what was wrong. If it still fails we
 *                         degrade to the offline parser and SAY SO
 *                         (never silently).
 *   • streamChat()      — token streaming for low TTFT answers.
 *
 * Every LLM path is optional: unreachable model or garbage output
 * degrades to `builtin` so the extension never becomes useless.
 * Nothing here ever calls a paid endpoint.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const utils = ShopAgent.utils;
  const { normalizeText, parseBudget, parsePrice, toEnglishDigits, similarity, clamp, formatMoneyShort, toPersianDigits } = utils;
  const log = utils.logger('llm');

  /* ------------------------------------------------------------------ *
   * Provider metadata (used by the settings UI)
   * ------------------------------------------------------------------ */

  const PROVIDER_META = {
    ollama: {
      id: 'ollama',
      needsKey: false,
      local: true,
      streaming: true,
      keyUrl: null,
      defaultModel: 'llama3.2',
      suggestedModels: ['llama3.2', 'llama3.1:8b', 'qwen2.5:7b', 'qwen2.5:3b', 'mistral', 'gemma2:9b', 'phi3'],
      install: 'ollama pull llama3.2',
    },
    groq: {
      id: 'groq',
      needsKey: true,
      local: false,
      streaming: true,
      keyUrl: 'https://console.groq.com/keys',
      defaultModel: 'llama-3.3-70b-versatile',
      suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768'],
    },
    gemini: {
      id: 'gemini',
      needsKey: true,
      local: false,
      streaming: true,
      keyUrl: 'https://aistudio.google.com/app/apikey',
      defaultModel: 'gemini-2.0-flash',
      suggestedModels: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'],
    },
    builtin: {
      id: 'builtin',
      needsKey: false,
      local: true,
      streaming: false,
      keyUrl: null,
      defaultModel: 'rule-based-fa',
      suggestedModels: ['rule-based-fa'],
    },
  };

  /* ------------------------------------------------------------------ *
   * Intent schema
   * ------------------------------------------------------------------ */

  const SORTS = ['best_match', 'bestselling', 'cheapest', 'expensive', 'newest', 'discount'];
  const FOLLOW_UPS = ['add_to_cart', 'open_product'];

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
    action: null,
    maxResults: 6,
    confidence: 0,
    source: 'builtin',
    explanation: '',
  };

  /** Coerce any object into a valid intent (defensive against LLM output). */
  function sanitizeIntent(raw, originalText, settings) {
    const out = { ...EMPTY_INTENT, ...(raw && typeof raw === 'object' ? raw : {}) };

    out.intent = ['search', 'filter', 'compare', 'question', 'unknown'].includes(out.intent) ? out.intent : 'search';
    out.query = String(out.query || '').trim().slice(0, 160);
    out.sort = SORTS.includes(out.sort) ? out.sort : 'best_match';
    out.attributes = Array.isArray(out.attributes) ? out.attributes.map((a) => String(a).trim()).filter(Boolean).slice(0, 8) : [];
    out.brand = out.brand ? String(out.brand).trim().slice(0, 40) : null;
    out.category = out.category ? String(out.category).trim().slice(0, 60) : null;
    out.targetStore = ['digikala', 'basalam'].includes(out.targetStore) ? out.targetStore : null;
    out.action = FOLLOW_UPS.includes(out.action) ? out.action : null;
    out.confidence = clamp(Number(out.confidence) || 0, 0, 1);
    out.explanation = String(out.explanation || '').slice(0, 400);
    out.maxResults = clamp(parseInt(out.maxResults, 10) || settings?.maxResults || 6, 1, 24);

    for (const k of ['minPrice', 'maxPrice']) {
      const rawValue = out[k];
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        out[k] = null;
        continue;
      }
      const n = Number(rawValue);
      // Negative or non-numeric money is nonsense → drop it.
      out[k] = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    if (out.minPrice && out.maxPrice && out.minPrice > out.maxPrice) {
      [out.minPrice, out.maxPrice] = [out.maxPrice, out.minPrice];
    }

    // The query is mandatory — recover it from the raw text if the model dropped it.
    if (!out.query && originalText) out.query = extractQueryFallback(originalText);
    return out;
  }

  /* ================================================================== *
   * Robust JSON — small local models break JSON constantly
   * ================================================================== */

  /** Remove // and /* *​/ comments that sit outside string literals. */
  function stripComments(src) {
    let out = '';
    let inStr = false;
    let quote = '';
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        out += ch;
        if (ch === '\\') {
          out += src[i + 1] || '';
          i++;
        } else if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }

  /** Repair the classic ways a model mangles JSON. */
  function repairJsonText(text) {
    let s = String(text ?? '');
    s = s.replace(/^\uFEFF/, '');
    s = s.replace(/```(?:json|JSON)?/g, '').replace(/```/g, '');
    s = s.replace(/[«»“”]/g, '"').replace(/[‘’]/g, "'");
    s = stripComments(s);
    s = s.replace(/,\s*([}\]])/g, '$1'); // trailing commas
    s = s.replace(/'([^'\\]*)'/g, (m, g) => `"${g.replace(/"/g, '\\"')}"`); // single-quoted strings
    s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'); // unquoted keys
    s = s.replace(/:\s*(NaN|Infinity|-Infinity)/g, ': null');
    return s.trim();
  }

  /** First balanced {...} or [...] region of a string (or null). */
  function extractBalanced(text) {
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']'],
    ]) {
      const start = text.indexOf(open);
      if (start === -1) continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  /** Close brackets left open by a truncated reply (best effort). */
  function closeTruncated(fragment) {
    const stack = [];
    let inStr = false;
    let esc = false;
    for (const ch of fragment) {
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (!stack.length && !inStr) return fragment;
    let closed = fragment.replace(/,\s*$/, '');
    // A dangling key («"query":») makes closing pointless — drop it.
    closed = closed.replace(/,\s*"[^"]*"\s*:\s*$/, '');
    if (inStr) closed += '"';
    while (stack.length) closed += stack.pop();
    return closed;
  }

  /**
   * Parse model output that *should* be JSON but often is not.
   * @returns {{ok:true, data:any, repaired:boolean}|{ok:false, error:string}}
   */
  function parseJsonLoose(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'EMPTY' };
    const cleaned = text.replace(/^\uFEFF/, '').trim();

    const attempts = [cleaned, repairJsonText(cleaned)];
    for (const candidate of attempts) {
      try {
        return { ok: true, data: JSON.parse(candidate), repaired: candidate !== cleaned };
      } catch {}
    }

    const balanced = extractBalanced(cleaned);
    if (balanced) {
      for (const candidate of [balanced, repairJsonText(balanced), closeTruncated(repairJsonText(balanced))]) {
        try {
          return { ok: true, data: JSON.parse(candidate), repaired: true };
        } catch {}
      }
    }

    // Whole reply looks like a truncated object.
    const repairedAll = repairJsonText(cleaned);
    const fragment = extractBalanced(repairedAll) || repairedAll;
    try {
      return { ok: true, data: JSON.parse(closeTruncated(fragment)), repaired: true };
    } catch {}

    return { ok: false, error: 'BAD_JSON' };
  }

  /** Back-compat wrapper: the parsed value or null. */
  function safeJsonParse(text) {
    const res = parseJsonLoose(text);
    return res.ok ? res.data : null;
  }

  /* ================================================================== *
   * Schema validators — structure is checked BEFORE coercion
   * ================================================================== */

  function validateIntentShape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'NOT_AN_OBJECT' };
    const errs = [];
    if (data.intent !== undefined && !['search', 'filter', 'compare', 'question', 'unknown'].includes(data.intent)) errs.push('intent');
    if (data.query !== undefined && typeof data.query !== 'string') errs.push('query');
    if (data.sort !== undefined && !SORTS.includes(data.sort)) errs.push('sort');
    if (data.targetStore !== undefined && data.targetStore !== null && !['digikala', 'basalam'].includes(data.targetStore)) errs.push('targetStore');
    if (data.action !== undefined && data.action !== null && !FOLLOW_UPS.includes(data.action)) errs.push('action');
    for (const k of ['minPrice', 'maxPrice']) {
      if (data[k] !== undefined && data[k] !== null && !(typeof data[k] === 'number' && Number.isFinite(data[k]))) errs.push(k);
    }
    if (data.attributes !== undefined && !Array.isArray(data.attributes)) errs.push('attributes');
    if (data.maxResults !== undefined && !(typeof data.maxResults === 'number')) errs.push('maxResults');
    if (data.confidence !== undefined && !(typeof data.confidence === 'number')) errs.push('confidence');
    return errs.length ? { ok: false, error: `BAD_FIELDS:${errs.join(',')}` } : { ok: true };
  }

  function validateRankShape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'NOT_AN_OBJECT' };
    const picks = Array.isArray(data.picks) ? data.picks : Array.isArray(data) ? data : null;
    if (!picks) return { ok: false, error: 'NO_PICKS_ARRAY' };
    for (const p of picks) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return { ok: false, error: 'PICK_WITHOUT_ID' };
    }
    return { ok: true, data: { picks } };
  }

  function validatePlanShape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'NOT_AN_OBJECT' };
    if (typeof data.action !== 'string' || !data.action) return { ok: false, error: 'NO_ACTION' };
    if (data.params !== undefined && (typeof data.params !== 'object' || Array.isArray(data.params))) return { ok: false, error: 'BAD_PARAMS' };
    return { ok: true, data: { action: data.action, params: data.params || {} } };
  }

  /* ================================================================== *
   * Prompting (kept tight — every token costs latency on local models)
   * ================================================================== */

  const INTENT_SYSTEM_PROMPT = `You are the intent parser of "ShopAgent", a browser automation extension for Iranian e-commerce sites (Digikala, Basalam).
Convert the user's Persian (or English) shopping request into ONE strict JSON object. No prose, no markdown fences, no extra keys.

Schema:
{
  "intent": "search" | "filter" | "compare" | "question" | "unknown",
  "query": "<concise Persian search keywords, max 6 words, no price, no store name>",
  "minPrice": <integer Toman or null>,
  "maxPrice": <integer Toman or null>,
  "sort": "best_match" | "bestselling" | "cheapest" | "expensive" | "newest" | "discount",
  "brand": "<brand name or null>",
  "category": "<short Persian category or null>",
  "attributes": ["<important Persian attribute>", "..."],
  "targetStore": "digikala" | "basalam" | null,
  "action": "add_to_cart" | "open_product" | null,
  "maxResults": <integer 1..24>,
  "confidence": <float 0..1>,
  "explanation": "<one short Persian sentence describing what you understood>"
}

Rules:
- ALL prices MUST be in Toman. «۳ میلیون تومان» = 3000000. «۵۰۰ هزار تومان» = 500000.
- «تا X» / «زیر X» => maxPrice = X. «بالای X» / «از X» => minPrice = X. «بین A تا B» => both.
- Keep "query" clean: only the product itself. Never include price words, "بهترین" or store names.
- If the user says «بهترین» without other ranking hints, use sort "bestselling".
- "action": set "add_to_cart" ONLY if the user explicitly asks to add the found item to the cart; "open_product" if they ask to open the product page; otherwise null. NEVER emit any payment/checkout/address action — those are forbidden by contract.
- If nothing product-like can be found, set intent "unknown" and query "".

Example:
INPUT: بهترین ایرپاد تا ۳ میلیون تومان رو پیدا کن
OUTPUT: {"intent":"search","query":"ایرپاد","minPrice":null,"maxPrice":3000000,"sort":"bestselling","brand":null,"category":"صوتی","attributes":["بی‌سیم"],"targetStore":null,"action":null,"maxResults":6,"confidence":0.93,"explanation":"دنبال بهترین ایرپاد با سقف قیمت سه میلیون تومان هستی."}`;

  const RANK_SYSTEM_PROMPT = `You are the shopping advisor inside "ShopAgent". You receive a JSON array of real products scraped from an Iranian store and the user's parsed intent.
Rank them and answer with ONE strict JSON object, no prose:
{
  "picks": [
    {
      "id": "<the id field of the product, unchanged>",
      "rank": <1-based integer>,
      "score": <integer 0..100>,
      "why": "<one short Persian sentence, max 25 words, explaining why it fits the request>"
    }
  ]
}
Rules:
- Respect the budget hard: a product above maxPrice may only appear if fewer than 2 in-budget products exist, and then say so in "why".
- Weigh: budget fit, rating, discount, brand match, and how well the title matches the requested attributes.
- Return at most as many picks as requested. Never invent ids that are not in the input.`;

  const PLAN_SYSTEM_PROMPT = `You are the action planner of "ShopAgent". Given one chosen product and the user's request, answer with ONE strict JSON object:
{"action": "<one of: OPEN_PRODUCT, ADD_TO_CART>", "params": {"url": "<product url>"}}
Rules:
- OPEN_PRODUCT only opens the product page. ADD_TO_CART adds it to the cart (the user confirms first).
- Payment, checkout, order placement and address changes are FORBIDDEN — never emit them.
- No prose, no markdown fences.`;

  function buildIntentMessages(text) {
    return [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: `INPUT: ${text}` },
    ];
  }

  function buildRankMessages(products, intent, userText, maxPicks, lang) {
    const compact = products.slice(0, 60).map((p, i) => ({
      id: p.id || `p${i}`,
      title: (p.title || '').slice(0, 120),
      price: p.price ?? null,
      originalPrice: p.originalPrice ?? null,
      rating: p.rating ?? null,
      ratingCount: p.ratingCount ?? null,
      discount: p.discount ?? null,
      seller: p.seller || null,
    }));
    return [
      { role: 'system', content: RANK_SYSTEM_PROMPT + (lang === 'en' ? '\nWrite "why" in English.' : '') },
      {
        role: 'user',
        content: JSON.stringify({ user_request: userText, parsed_intent: intent, max_picks: maxPicks, products: compact }),
      },
    ];
  }

  function buildPlanMessages(product, intent, lang) {
    return [
      { role: 'system', content: PLAN_SYSTEM_PROMPT + (lang === 'en' ? '\nAnswer in English.' : '') },
      {
        role: 'user',
        content: JSON.stringify({ product: { id: product.id, title: product.title, url: product.url }, request: intent.query || '' }),
      },
    ];
  }

  /**
   * Self-correction round: replay the conversation plus the model's own
   * broken reply and a precise description of what was wrong with it.
   */
  function buildRepairMessages(messages, badText, error, lang) {
    const snippet = String(badText || '').slice(0, 600);
    const note =
      lang === 'en'
        ? `Your previous reply could not be used (${error}). Reply with ONE valid JSON object only — no prose, no markdown fences — that satisfies the original instructions exactly.`
        : `پاسخ قبلی تو قابل استفاده نبود (${error}). فقط و فقط یک شیء JSON معتبر بفرست — بدون توضیح و بدون بلوک کد — که دقیقاً به دستور اولیه پایبند باشد.`;
    return [...messages, { role: 'assistant', content: snippet }, { role: 'user', content: note }];
  }

  /* ================================================================== *
   * Transport — thin wrapper over background/providers/*
   * ================================================================== */

  function providerFor(settings) {
    const id = settings?.provider || 'ollama';
    return ShopAgent.providers.get(id) || null;
  }

  /** Settings → provider options. */
  function providerOpts(settings, extra = {}) {
    const id = settings.provider || 'ollama';
    const conf = settings[id] || {};
    return {
      model: conf.model,
      timeoutMs: extra.timeoutMs,
      signal: extra.signal,
      temperature: extra.temperature,
      json: extra.json,
      messages: extra.messages,
      prompt: extra.prompt,
      systemPrompt: extra.systemPrompt,
      ...(id === 'ollama' ? { baseUrl: conf.baseUrl, keepAlive: conf.keepAlive } : { apiKey: conf.apiKey }),
    };
  }

  /**
   * Single chat entry point used by every provider.
   * @returns {Promise<{ok:boolean, text?:string, error?:string, provider:string, model:string, latencyMs:number}>}
   */
  async function chat(settings, { messages, prompt, systemPrompt, json = true, temperature, timeoutMs = 60000, signal } = {}) {
    const providerId = settings.provider || 'ollama';
    const provider = providerFor(settings);
    if (!provider) return { ok: false, error: 'UNKNOWN_PROVIDER', provider: providerId, model: 'unknown', latencyMs: 0 };
    const started = Date.now();
    const res = await provider.complete(providerOpts(settings, { messages, prompt, systemPrompt, json, temperature, timeoutMs, signal }));
    return {
      ok: Boolean(res.ok),
      text: res.text || '',
      error: res.error,
      detail: res.detail,
      provider: providerId,
      model: res.model || settings[providerId]?.model || 'unknown',
      latencyMs: res.latencyMs ?? Date.now() - started,
    };
  }

  /**
   * Chat with a JSON contract: parse → validate → ONE auto-repair.
   * @returns {Promise<{ok:boolean, data?:any, repaired?:boolean, error?:string, provider?:string, model?:string}>}
   */
  async function completeJson(settings, { messages, validate, lang = 'fa', temperature = 0.1, timeoutMs = 45000, signal } = {}) {
    const first = await chat(settings, { messages, json: true, temperature, timeoutMs, signal });
    if (!first.ok) return { ok: false, error: first.error, provider: first.provider, model: first.model };

    const parsed = parseJsonLoose(first.text);
    const verdict = parsed.ok ? (validate ? validate(parsed.data) : { ok: true, data: parsed.data }) : { ok: false, error: parsed.error || 'BAD_JSON' };
    if (verdict.ok) {
      return { ok: true, data: verdict.data !== undefined ? verdict.data : parsed.data, repaired: parsed.repaired, provider: first.provider, model: first.model };
    }

    // One self-correction round — the model is told exactly what failed.
    log.info('model output invalid, attempting auto-repair:', verdict.error || parsed.error);
    const second = await chat(settings, {
      messages: buildRepairMessages(messages, first.text, verdict.error || parsed.error, lang),
      json: true,
      temperature: 0,
      timeoutMs,
      signal,
    });
    if (second.ok) {
      const parsed2 = parseJsonLoose(second.text);
      const verdict2 = parsed2.ok ? (validate ? validate(parsed2.data) : { ok: true, data: parsed2.data }) : { ok: false, error: 'BAD_JSON' };
      if (verdict2.ok) {
        return { ok: true, data: verdict2.data !== undefined ? verdict2.data : parsed2.data, repaired: true, provider: second.provider, model: second.model };
      }
    }

    return { ok: false, error: 'BAD_JSON', repaired: false, provider: first.provider, model: first.model, detail: String(first.text || '').slice(0, 200) };
  }

  /**
   * Streaming chat: yields deltas through `onDelta` as they arrive.
   * @returns {Promise<{ok:boolean, text?:string, error?:string, provider:string, model:string}>}
   */
  async function streamChat(settings, { messages, prompt, systemPrompt, temperature = 0.3, timeoutMs = 90000, signal, onDelta } = {}) {
    const providerId = settings.provider || 'ollama';
    const provider = providerFor(settings);
    if (!provider || typeof provider.stream !== 'function') {
      return { ok: false, error: 'STREAM_UNSUPPORTED', provider: providerId, model: 'unknown' };
    }
    let text = '';
    try {
      const iterator = provider.stream(providerOpts(settings, { messages, prompt, systemPrompt, json: false, temperature, timeoutMs, signal }));
      for await (const delta of iterator) {
        if (!delta) continue;
        text += delta;
        onDelta?.(delta, text);
      }
      return { ok: true, text, provider: providerId, model: settings[providerId]?.model || 'unknown' };
    } catch (err) {
      const code = err?.code || err?.message || 'STREAM_ERROR';
      log.warn('stream failed', providerId, code);
      return { ok: false, error: String(code), provider: providerId, model: settings[providerId]?.model || 'unknown', text };
    }
  }

  /* ================================================================== *
   * Connection test + model discovery
   * ================================================================== */

  async function testConnection(settings, signal) {
    const providerId = settings.provider || 'ollama';
    const provider = providerFor(settings);
    const started = Date.now();

    if (providerId === 'builtin') {
      return { ok: true, provider: providerId, latencyMs: 0, message: 'builtin', models: ['rule-based-fa'] };
    }
    if (!provider) return { ok: false, provider: providerId, latencyMs: 0, message: 'UNKNOWN_PROVIDER', models: [] };

    if (providerId === 'ollama' && typeof provider.ping === 'function') {
      const res = await provider.ping(settings.ollama?.baseUrl, { signal });
      const configured = settings.ollama?.model;
      return {
        ok: res.ok,
        provider: providerId,
        latencyMs: res.latencyMs ?? Date.now() - started,
        online: res.online,
        models: res.models || [],
        message: !res.ok
          ? res.error
          : configured && res.models.length && !res.models.some((m) => m === configured || m.startsWith(configured + ':'))
          ? `MODEL_MISSING:${configured}`
          : 'ok',
      };
    }

    if (providerId === 'groq' || providerId === 'gemini') {
      const key = settings[providerId]?.apiKey;
      if (!key) return { ok: false, provider: providerId, latencyMs: 0, message: 'NO_KEY', models: [] };
      try {
        const url =
          providerId === 'groq'
            ? 'https://api.groq.com/openai/v1/models'
            : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`;
        const res = await ShopAgent.providers.fetchWithTimeout(url, providerId === 'groq' ? { headers: { Authorization: `Bearer ${key}` } } : {}, 10000, signal);
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const data = await res.json();
        const models =
          providerId === 'groq'
            ? (data?.data || []).map((m) => m.id).filter(Boolean)
            : (data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name || '').replace(/^models\//, ''));
        return { ok: true, provider: providerId, latencyMs: Date.now() - started, models, message: 'ok' };
      } catch (err) {
        return { ok: false, provider: providerId, latencyMs: Date.now() - started, message: String(err?.message || err), models: [] };
      }
    }

    return { ok: false, provider: providerId, message: 'UNKNOWN_PROVIDER', models: [] };
  }

  const listModels = (settings, signal) => testConnection(settings, signal);

  /* ================================================================== *
   * Built-in (offline) Persian parser
   * ================================================================== */

  const STOP_WORDS = [
    'بهترین', 'بهترینِ', 'ارزانترین', 'ارزان‌ترین', 'ارزون', 'ارزون‌ترین', 'گرانترین', 'گران‌ترین', 'پرفروشترین', 'جدیدترین',
    'پیدا', 'کن', 'کنید', 'بکن', 'بگرد', 'بگرده', 'جستجو', 'سرچ', 'نشان', 'نشون', 'بده',
    'میخوام', 'می‌خوام', 'میخواهم', 'می‌خواهم', 'خوبه', 'لازم', 'دارم', 'داری',
    'دنبال', 'برای', 'از', 'تا', 'بین', 'زیر', 'بالای', 'کمتر', 'بیشتر', 'حداکثر', 'حداقل',
    'تومان', 'تومن', 'ریال', 'میلیون', 'هزار', 'میلیارد', 'قیمت', 'قیمتی',
    'یه', 'یک', 'چند', 'لطفا', 'بزار', 'بذار', 'رو', 'را', 'و', 'که', 'در', 'با', 'بدون',
    'دیجی‌کالا', 'دیجی کالا', 'دیجیکالا', 'باسلام', 'با سلام', 'سایت', 'فروشگاه',
    'خرید', 'بخرم', 'خریدم', 'گزینه', 'گزینه‌ای', 'مدل', 'محصول', 'کالا', 'سبد', 'اضافه',
    // greetings / small talk, so «سلام خوبی؟» yields no product at all
    'سلام', 'درود', 'خوبی', 'خوب', 'چطوری', 'حالت', 'مرسی', 'ممنون', 'متشکر', 'تشکر',
    'hello', 'hi', 'hey', 'thanks', 'thank', 'you', 'how', 'are',
    'find', 'best', 'cheapest', 'the', 'a', 'an', 'for', 'under', 'below', 'show', 'me',
    'please', 'search', 'buy', 'want', 'need', 'top', 'good',
  ];

  const BRANDS = [
    'اپل', 'apple', 'ایفون', 'آیفون', 'iphone', 'ایرپاد', 'airpods', 'airpod',
    'سامسونگ', 'samsung', 'شیائومی', 'xiaomi', 'پوکو', 'poco', 'ردمی', 'redmi',
    'هواوی', 'huawei', 'آنر', 'honor', 'نوکیا', 'nokia', 'موتورولا', 'motorola',
    'سونی', 'sony', 'ال‌جی', 'الجی', 'lg', 'بوش', 'bosch', 'فیلیپس', 'philips',
    'انکر', 'anker', 'جی‌بی‌ال', 'jbl', 'بیتس', 'beats', 'ریلمی', 'realme',
    'نایک', 'nike', 'آدیداس', 'adidas', 'پوما', 'puma', 'نیوبالانس', 'new balance',
    'اسنوا', 'snowa', 'پاکشوما', 'جی‌پلاس', 'gplus', 'هایسنس', 'hisense', 'توشیبا', 'toshiba',
    'دل', 'dell', 'ایسوس', 'asus', 'لنوو', 'lenovo', 'اچ‌پی', 'hp', 'مک‌بوک', 'macbook',
    'ایسر', 'acer', 'ام‌اس‌آی', 'msi', 'ریزر', 'razer', 'لوجیتک', 'logitech',
  ];

  const CATEGORY_HINTS = [
    { re: /(ایرپاد|airpod|هدفون|هندزفری|headphone|earbud|earphone)/i, cat: 'صوتی' },
    { re: /(گوشی|موبایل|phone|mobile|smartphone)/i, cat: 'موبایل' },
    { re: /(لپ ?تاپ|لپتاپ|laptop|notebook)/i, cat: 'لپ‌تاپ' },
    { re: /(تبلت|tablet|ipad|آیپد)/i, cat: 'تبلت' },
    { re: /(ساعت|watch|مچ‌بند|دستبند)/i, cat: 'ساعت' },
    { re: /(کفش|shoes|کتونی|کفش ورزشی|running)/i, cat: 'کفش' },
    { re: /(کتاب|book|رمان|novel)/i, cat: 'کتاب' },
    { re: /(تلویزیون|tv|television)/i, cat: 'تلویزیون' },
    { re: /(یخچال|fridge|refrigerator|لباسشویی|washing|ماشین لباسشویی)/i, cat: 'لوازم خانگی' },
    { re: /(عطر|ادکلن|perfume|cologne)/i, cat: 'عطر' },
    { re: /(کیف|bag|کوله|backpack|کوله‌پشتی)/i, cat: 'کیف' },
    { re: /(دوربین|camera|لنز)/i, cat: 'دوربین' },
    { re: /(کنسول|پلی ?استیشن|playstation|ایکس ?باکس|xbox|نینتندو|nintendo)/i, cat: 'گیمینگ' },
    { re: /(مانیتور|monitor|نمایشگر)/i, cat: 'مانیتور' },
    { re: /(پاوربانک|powerbank|power bank|شارژر|charger)/i, cat: 'لوازم جانبی' },
  ];

  const SORT_RULES = [
    // Colloquial spellings included: «ارزون‌ترین», «ارزون».
    { re: /(ارزان ?ترین|ارزانترین|ارزون ?ترین|ارزونترین|ارزون|ارزان|کمترین قیمت|قیمت پایین|cheapest|lowest price|budget)/i, sort: 'cheapest' },
    { re: /(گران ?ترین|گرانترین|بیشترین قیمت|لوکس ?ترین|most expensive|premium)/i, sort: 'expensive' },
    { re: /(پرفروش ?ترین|پرفروشترین|محبوب ?ترین|پرطرفدار|بیشترین فروش|best ?selling|most popular|popular)/i, sort: 'bestselling' },
    { re: /(جدید ?ترین|جدیدترین|تازه ?ترین|آخرین مدل|newest|latest)/i, sort: 'newest' },
    { re: /(بیشترین تخفیف|تخفیف ?دار|حراج|آفر|off|discount|deal)/i, sort: 'discount' },
    { re: /(بهترین|باکیفیت|بالاترین کیفیت|معتبرترین|best|highest quality|top rated)/i, sort: 'bestselling' },
  ];

  const ATTRIBUTE_RULES = [
    { re: /(بی‌?سیم|بیسیم|wireless)/i, attr: 'بی‌سیم' },
    { re: /(نویز ?کنسلینگ|nc|حذف نویز|noise cancel)/i, attr: 'نویز کنسلینگ' },
    { re: /(ضد ?آب|مقاوم در برابر آب|waterproof|water resistant)/i, attr: 'ضد آب' },
    { re: /(اصل|اورجینال|original|authentic)/i, attr: 'اصل' },
    { re: /(گارانتی|warranty)/i, attr: 'گارانتی' },
    { re: /(سبک|lightweight)/i, attr: 'سبک' },
    { re: /(بزرگ|large|سایز بزرگ)/i, attr: 'سایز بزرگ' },
    { re: /(کودک|بچه|kids|children)/i, attr: 'کودک' },
    { re: /(مردانه|men)/i, attr: 'مردانه' },
    { re: /(زنانه|women|خانم)/i, attr: 'زنانه' },
    { re: /(ورزشی|رانینگ|رانیگ|sport|running|دویدن)/i, attr: 'ورزشی' },
    { re: /(رسمی|formal|اداری)/i, attr: 'رسمی' },
    { re: /(gaming|گیمینگ|بازی)/i, attr: 'گیمینگ' },
    { re: /(5g|۵جی)/i, attr: '5G' },
    { re: /(ssd)/i, attr: 'SSD' },
    { re: /(رم\s*(\d+)|ram\s*(\d+))/i, attr: 'رم' },
  ];

  /** Cheap last-resort query extraction when the LLM is unavailable. */
  function extractQueryFallback(text) {
    const cleaned = normalizeText(toEnglishDigits(String(text || '')));
    // Remove price/budget phrases entirely.
    let s = cleaned.replace(/(از|تا|بین|زیر|بالای|کمتر از|بیشتر از|حداکثر|حداقل)?\s*[\d.,]+\s*(هزار|میلیون|میلیارد)?\s*(تومان|تومن|ریال)?/g, ' ');
    s = s.replace(/\d+/g, ' ');
    const tokens = s
      .split(' ')
      // strip punctuation that would defeat stop-word matching («خوبی؟» → «خوبی»)
      .map((w) => w.replace(/[؟?!.,;:«»"'()\[\]{}٪%*_\-–—]+/g, '').trim())
      .filter((w) => w && w.length > 1 && !STOP_WORDS.includes(w));
    const uniq = [...new Set(tokens)];
    return uniq.slice(0, 6).join(' ');
  }

  /**
   * Fully offline intent parser. Handles the most common Persian shopping
   * commands without any model at all.
   *
   * @param {string} text
   * @param {object} [settings]
   * @returns {object} intent
   */
  function builtinParseIntent(text, settings = {}) {
    const original = String(text || '');
    const norm = normalizeText(toEnglishDigits(original));
    const intent = { ...EMPTY_INTENT, source: 'builtin', maxResults: settings.maxResults || 6 };

    // Store
    if (/(دیجی ?کالا|دیجیکالا|digikala)/i.test(norm)) intent.targetStore = 'digikala';
    else if (/(باسلام|با سلام|basalam)/i.test(norm)) intent.targetStore = 'basalam';

    // Budget
    const budget = parseBudget(original);
    intent.minPrice = budget.min;
    intent.maxPrice = budget.max;

    // Sort
    for (const rule of SORT_RULES) {
      if (rule.re.test(norm)) {
        intent.sort = rule.sort;
        break;
      }
    }

    // Brand
    for (const b of BRANDS) {
      const nb = normalizeText(b);
      if (nb && norm.includes(nb)) {
        intent.brand = b;
        break;
      }
    }

    // Category
    for (const c of CATEGORY_HINTS) {
      if (c.re.test(norm)) {
        intent.category = c.cat;
        break;
      }
    }

    // Attributes
    intent.attributes = [];
    for (const a of ATTRIBUTE_RULES) {
      const m = norm.match(a.re);
      if (m) {
        const value = typeof a.attr === 'string' ? a.attr : m[1];
        if (!intent.attributes.includes(value)) intent.attributes.push(value);
      }
    }

    // Follow-up action (whitelisted in shared/act.js)
    if (/(به سبد|سبد خرید|اضافه به سبد|add to cart|add to basket)/i.test(norm)) intent.action = 'add_to_cart';
    else if (/(بازش کن|باز کن|صفحه.*باز|open it|open the product)/i.test(norm)) intent.action = 'open_product';

    // Query — strip everything structural, keep the descriptive core.
    intent.query = extractQueryFallback(original);
    if (intent.brand && !intent.query.includes(normalizeText(intent.brand))) {
      intent.query = `${intent.brand} ${intent.query}`.trim();
    }

    // Confidence heuristic
    let conf = 0.35;
    if (intent.query) conf += 0.3;
    if (intent.maxPrice || intent.minPrice) conf += 0.15;
    if (intent.brand || intent.category) conf += 0.1;
    if (intent.sort !== 'best_match') conf += 0.1;
    intent.confidence = clamp(conf, 0, 0.85);

    if (!intent.query) {
      intent.intent = 'unknown';
      intent.explanation = 'نتوانستم کالای مشخصی از جمله استخراج کنم.';
    } else {
      const bits = [`جستجوی «${intent.query}»`];
      if (intent.maxPrice) bits.push(`سقف قیمت ${formatMoneyShort(intent.maxPrice)} تومان`);
      if (intent.minPrice) bits.push(`کف قیمت ${formatMoneyShort(intent.minPrice)} تومان`);
      if (intent.sort !== 'best_match') bits.push(`مرتب‌سازی: ${intent.sort}`);
      if (intent.action === 'add_to_cart') bits.push('افزودن به سبد خرید');
      intent.explanation = bits.join(' • ');
    }
    return intent;
  }

  /* ================================================================== *
   * High level: intent
   * ================================================================== */

  /**
   * Parse a natural-language command into a structured intent.
   * Always returns a usable intent — LLM first, rule-based fallback second.
   * `degraded` + `degradedReason` tell the UI when the model could not
   * be trusted (broken JSON even after auto-repair, unreachable, …).
   */
  async function parseIntent(text, settings = {}, { signal } = {}) {
    const fallback = builtinParseIntent(text, settings);
    const provider = settings.provider || 'ollama';

    if (provider === 'builtin' || !String(text || '').trim()) return fallback;

    const res = await completeJson(settings, {
      messages: buildIntentMessages(text),
      validate: validateIntentShape,
      temperature: 0.1,
      timeoutMs: 45000,
      signal,
    });

    if (!res.ok) {
      log.info('intent fell back to builtin parser:', res.error);
      return { ...fallback, degraded: true, degradedReason: res.error || 'BAD_JSON' };
    }

    const intent = sanitizeIntent(res.data, text, settings);
    intent.source = provider;
    intent.repaired = Boolean(res.repaired);
    intent.model = res.model;

    // The local parser is more reliable for numbers — trust it when they disagree wildly.
    if (fallback.maxPrice && (!intent.maxPrice || Math.abs(intent.maxPrice - fallback.maxPrice) / fallback.maxPrice > 0.5)) {
      intent.maxPrice = fallback.maxPrice;
    }
    if (fallback.minPrice && !intent.minPrice) intent.minPrice = fallback.minPrice;
    if (!intent.query) intent.query = fallback.query;

    return intent;
  }

  /* ================================================================== *
   * High level: ranking
   * ================================================================== */

  /**
   * Deterministic local scorer. Runs even with zero models installed and
   * provides the numeric backbone the LLM only refines.
   */
  function localScore(product, intent, lang = 'fa') {
    const reasons = [];
    let score = 40;

    // Query relevance
    const sim = similarity(product.title || '', intent.query || '');
    score += sim * 26;
    if (sim > 0.55) reasons.push(lang === 'en' ? 'Title matches your request closely' : 'عنوان کالا با درخواست شما هم‌خوانی بالایی دارد');

    // Brand
    if (intent.brand) {
      const t = normalizeText(product.title || '') + ' ' + normalizeText(product.brand || '');
      if (t.includes(normalizeText(intent.brand))) {
        score += 12;
        reasons.push(lang === 'en' ? `Genuine ${intent.brand}` : `برند ${intent.brand} مطابقت دارد`);
      } else {
        score -= 18;
      }
    }

    // Attributes
    if (intent.attributes && intent.attributes.length) {
      const t = normalizeText(product.title || '');
      let hits = 0;
      for (const a of intent.attributes) if (t.includes(normalizeText(a))) hits++;
      const ratio = hits / intent.attributes.length;
      score += ratio * 14;
      if (ratio >= 0.5) reasons.push(lang === 'en' ? 'Has the features you asked for' : 'ویژگی‌های خواسته‌شده را دارد');
    }

    // Budget
    const price = Number(product.price) || 0;
    if (price > 0) {
      if (intent.maxPrice) {
        if (price <= intent.maxPrice) {
          const headroom = (intent.maxPrice - price) / intent.maxPrice;
          score += 14 + headroom * 12;
          if (headroom > 0.25) reasons.push(lang === 'en' ? 'Comfortably under your budget' : 'به‌طور محسوسی زیر سقف بودجه است');
          else reasons.push(lang === 'en' ? 'Fits your budget' : 'در بازه بودجه شماست');
        } else {
          const over = (price - intent.maxPrice) / intent.maxPrice;
          score -= 30 + Math.min(40, over * 100);
          reasons.push(lang === 'en' ? `Over budget by ${formatMoneyShort(price - intent.maxPrice)}` : `${formatMoneyShort(price - intent.maxPrice)} تومان بالاتر از بودجه`);
        }
      }
      if (intent.minPrice && price < intent.minPrice) {
        score -= 12;
        reasons.push(lang === 'en' ? 'Below your minimum budget' : 'پایین‌تر از کف بودجه شما');
      }
    } else {
      score -= 20; // no readable price → can't be recommended confidently
    }

    // Rating
    const rating = Number(product.rating);
    if (Number.isFinite(rating) && rating > 0) {
      const norm = rating > 5 ? rating / 20 : rating; // some sites use 0..100
      score += (norm - 3) * 5 + 4;
      const count = Number(product.ratingCount) || 0;
      if (count >= 50) score += 4;
      if (norm >= 4.2) reasons.push(lang === 'en' ? `High rating (${norm.toFixed(1)})` : `امتیاز خریداران ${toPersianDigits(norm.toFixed(1))}`);
    }

    // Discount
    const disc = Number(product.discount) || 0;
    if (disc > 0) {
      score += Math.min(12, disc * 0.8);
      if (disc >= 15) reasons.push(lang === 'en' ? `${disc}% discount right now` : `${toPersianDigits(disc)}٪ تخفیف فعال`);
    }

    // Sort intent
    if (intent.sort === 'cheapest' && price > 0) score += 6;
    if (intent.sort === 'bestselling' && (Number(product.ratingCount) || 0) > 100) score += 6;

    return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 3) };
  }

  /** Sort + score products locally, then optionally let the LLM re-rank. */
  async function rankProducts(products, intent, { settings = {}, userText = '', lang = 'fa', maxPicks = 6, signal } = {}) {
    if (!Array.isArray(products) || !products.length) return [];

    const base = products.map((p) => {
      const { score, reasons } = localScore(p, intent, lang);
      return { ...p, score, reasons };
    });

    // Deterministic pre-sort aligned with the requested sort order.
    const bySort = (a, b) => {
      switch (intent.sort) {
        case 'cheapest':
          return (a.price || Infinity) - (b.price || Infinity);
        case 'expensive':
          return (b.price || 0) - (a.price || 0);
        case 'newest':
          return (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) || b.score - a.score;
        case 'discount':
          return (b.discount || 0) - (a.discount || 0);
        case 'bestselling':
        case 'best_match':
        default:
          return b.score - a.score;
      }
    };
    base.sort(bySort);

    // Hard budget filter (only if it leaves us with something).
    if (intent.maxPrice) {
      const inBudget = base.filter((p) => p.price && p.price <= intent.maxPrice);
      if (inBudget.length >= 2) return finalize(inBudget.slice(0, maxPicks * 3), maxPicks);
    }

    return finalize(base.slice(0, maxPicks * 3), maxPicks);

    async function finalize(pool, picks) {
      const provider = settings.provider || 'ollama';
      if (provider !== 'builtin') {
        const res = await completeJson(settings, {
          messages: buildRankMessages(pool, intent, userText, picks, lang),
          validate: validateRankShape,
          temperature: 0.2,
          timeoutMs: 60000,
          signal,
        });
        if (res.ok && Array.isArray(res.data?.picks) && res.data.picks.length) {
          const byId = new Map(pool.map((p) => [String(p.id), p]));
          const reranked = [];
          for (const item of res.data.picks) {
            const prod = byId.get(String(item?.id));
            if (!prod) continue; // hallucinated id — ignored
            reranked.push({
              ...prod,
              score: clamp(Number(item.score) || prod.score, 0, 100),
              why: item.why ? String(item.why).slice(0, 240) : prod.reasons[0],
              aiRanked: true,
            });
          }
          if (reranked.length) return reranked.slice(0, picks);
        }
        log.info('ranking fell back to local scorer:', res.error || 'no usable picks');
      }
      return pool.slice(0, picks).map((p) => ({ ...p, why: p.reasons[0] || '', aiRanked: false }));
    }
  }

  /* ================================================================== *
   * High level: action planning (validated by shared/act.js)
   * ================================================================== */

  /**
   * Turn the chosen product + intent into a VALIDATED action plan.
   * The model may propose, but shared/act.js disposes: unknown or
   * blocked actions fall back to the deterministic plan.
   *
   * @returns {Promise<{ok:true, plan:object, source:'llm'|'deterministic', repaired?:boolean, degradedReason?:string}>}
   */
  async function planAction(product, intent, settings = {}, { signal, lang = 'fa' } = {}) {
    const fallback = ShopAgent.act.validate(ShopAgent.act.planFromIntent(intent) || { action: 'OPEN_PRODUCT', params: { url: product?.url || '' } });
    const provider = settings.provider || 'ollama';
    if (provider === 'builtin' || !product?.url) return { ok: true, plan: fallback, source: 'deterministic' };

    const res = await completeJson(settings, {
      messages: buildPlanMessages(product, intent, lang),
      validate: validatePlanShape,
      temperature: 0.1,
      timeoutMs: 30000,
      signal,
    });

    if (!res.ok) return { ok: true, plan: fallback, source: 'deterministic', degradedReason: res.error };
    const verdict = ShopAgent.act.validate(res.data);
    if (!verdict.ok) return { ok: true, plan: fallback, source: 'deterministic', degradedReason: verdict.error };
    return { ok: true, plan: verdict, source: 'llm', repaired: Boolean(res.repaired) };
  }

  ShopAgent.llm = {
    PROVIDER_META,
    SORTS,
    FOLLOW_UPS,
    EMPTY_INTENT,
    sanitizeIntent,
    builtinParseIntent,
    extractQueryFallback,
    parseIntent,
    rankProducts,
    planAction,
    localScore,
    chat,
    completeJson,
    streamChat,
    testConnection,
    listModels,
    safeJsonParse,
    parseJsonLoose,
    repairJsonText,
    extractBalanced,
    closeTruncated,
    validateIntentShape,
    validateRankShape,
    validatePlanShape,
    buildIntentMessages,
    buildRankMessages,
    buildPlanMessages,
    buildRepairMessages,
    providerFor,
  };
})(globalThis);
