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
 * Every LLM path is *optional*: if the model is unreachable or answers
 * garbage, we transparently degrade to `builtin` so the extension never
 * becomes useless. Nothing here ever calls a paid endpoint.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, parseBudget, parsePrice, toEnglishDigits, similarity, clamp, sleep } = ShopAgent.utils;
  const log = ShopAgent.utils.logger('llm');

  /* ------------------------------------------------------------------ *
   * Provider metadata (used by the settings UI)
   * ------------------------------------------------------------------ */

  const PROVIDER_META = {
    ollama: {
      id: 'ollama',
      needsKey: false,
      local: true,
      keyUrl: null,
      defaultModel: 'llama3.2',
      suggestedModels: ['llama3.2', 'llama3.1:8b', 'qwen2.5:7b', 'qwen2.5:3b', 'mistral', 'gemma2:9b', 'phi3'],
      install: 'ollama pull llama3.2',
    },
    groq: {
      id: 'groq',
      needsKey: true,
      local: false,
      keyUrl: 'https://console.groq.com/keys',
      defaultModel: 'llama-3.3-70b-versatile',
      suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768'],
    },
    gemini: {
      id: 'gemini',
      needsKey: true,
      local: false,
      keyUrl: 'https://aistudio.google.com/app/apikey',
      defaultModel: 'gemini-2.0-flash',
      suggestedModels: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'],
    },
    builtin: {
      id: 'builtin',
      needsKey: false,
      local: true,
      keyUrl: null,
      defaultModel: 'rule-based-fa',
      suggestedModels: ['rule-based-fa'],
    },
  };

  /* ------------------------------------------------------------------ *
   * Intent schema
   * ------------------------------------------------------------------ */

  const SORTS = ['best_match', 'bestselling', 'cheapest', 'expensive', 'newest', 'discount'];

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
    out.confidence = clamp(Number(out.confidence) || 0, 0, 1);
    out.explanation = String(out.explanation || '').slice(0, 400);
    out.maxResults = clamp(parseInt(out.maxResults, 10) || settings?.maxResults || 6, 1, 24);

    for (const k of ['minPrice', 'maxPrice']) {
      const raw = out[k];
      if (raw === null || raw === undefined || raw === '') {
        out[k] = null;
        continue;
      }
      const n = Number(raw);
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

  /* ------------------------------------------------------------------ *
   * Built-in (offline) Persian parser
   * ------------------------------------------------------------------ */

  const STOP_WORDS = [
    'بهترین', 'بهترینِ', 'ارزانترین', 'ارزان‌ترین', 'گرانترین', 'پرفروشترین', 'جدیدترین',
    'پیدا', 'کن', 'کنید', 'بکن', 'بگرد', 'بگرده', 'جستجو', 'سرچ', 'نشان', 'نشون', 'بده',
    'میخوام', 'می‌خوام', 'میخواهم', 'می‌خواهم', 'خوبه', 'لازم', 'دارم', 'داری',
    'دنبال', 'برای', 'از', 'تا', 'بین', 'زیر', 'بالای', 'کمتر', 'بیشتر', 'حداکثر', 'حداقل',
    'تومان', 'تومن', 'ریال', 'میلیون', 'هزار', 'میلیارد', 'قیمت', 'قیمتی',
    'یه', 'یک', 'چند', 'لطفا', 'بزار', 'بذار', 'رو', 'را', 'و', 'که', 'در', 'با', 'بدون',
    'دیجی‌کالا', 'دیجی کالا', 'دیجیکالا', 'باسلام', 'با سلام', 'سایت', 'فروشگاه',
    'خرید', 'بخرم', 'خریدم', 'گزینه', 'گزینه‌ای', 'مدل', 'محصول', 'کالا',
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
    'انکر', 'anker', 'جی‌بی‌ال', 'jbl', 'بیتس', 'beats', 'شیائومی', 'ریلمی', 'realme',
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
      if (intent.maxPrice) bits.push(`سقف قیمت ${ShopAgent.utils.formatMoneyShort(intent.maxPrice)} تومان`);
      if (intent.minPrice) bits.push(`کف قیمت ${ShopAgent.utils.formatMoneyShort(intent.minPrice)} تومان`);
      if (intent.sort !== 'best_match') bits.push(`مرتب‌سازی: ${intent.sort}`);
      intent.explanation = bits.join(' • ');
    }
    return intent;
  }

  /* ------------------------------------------------------------------ *
   * Prompting
   * ------------------------------------------------------------------ */

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
  "maxResults": <integer 1..24>,
  "confidence": <float 0..1>,
  "explanation": "<one short Persian sentence describing what you understood>"
}

Rules:
- ALL prices MUST be in Toman. 1 Rial = 0.1 Toman. «۳ میلیون تومان» = 3000000. «۵۰۰ هزار تومان» = 500000. «۲ میلیارد ریال» = 200000000 Toman.
- «تا X» / «زیر X» / «کمتر از X» => maxPrice = X. «بالای X» / «از X» / «حداقل X» => minPrice = X. «بین A تا B» => both.
- Keep "query" clean: only the product itself (e.g. "ایرپاد بی‌سیم"). Never include price words, "بهترین", "پیدا کن" or store names.
- If the user says «بهترین» without other ranking hints, use sort "bestselling".
- Never invent a price or brand that is not in the text.
- If nothing product-like can be found, set intent "unknown" and query "".

Examples:
INPUT: بهترین ایرپاد تا ۳ میلیون تومان رو پیدا کن
OUTPUT: {"intent":"search","query":"ایرپاد","minPrice":null,"maxPrice":3000000,"sort":"bestselling","brand":null,"category":"صوتی","attributes":["بی‌سیم"],"targetStore":null,"maxResults":6,"confidence":0.93,"explanation":"دنبال بهترین ایرپاد با سقف قیمت سه میلیون تومان هستی."}

INPUT: ارزون‌ترین گوشی شیائومی تو دیجی کالا زیر ۸ میلیون
OUTPUT: {"intent":"search","query":"گوشی شیائومی","minPrice":null,"maxPrice":8000000,"sort":"cheapest","brand":"شیائومی","category":"موبایل","attributes":[],"targetStore":"digikala","maxResults":6,"confidence":0.95,"explanation":"ارزان‌ترین گوشی شیائومی زیر هشت میلیون تومان در دیجی‌کالا."}

INPUT: کفش رانینگ مردانه بین ۵۰۰ هزار تا ۲ میلیون باسلام
OUTPUT: {"intent":"search","query":"کفش رانینگ مردانه","minPrice":500000,"maxPrice":2000000,"sort":"best_match","brand":null,"category":"کفش","attributes":["مردانه","ورزشی"],"targetStore":"basalam","maxResults":6,"confidence":0.9,"explanation":"کفش دویدن مردانه در بازه قیمت مشخص‌شده از باسلام."}`;

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
      brand: p.brand || null,
      url: undefined,
    }));
    return [
      { role: 'system', content: RANK_SYSTEM_PROMPT + (lang === 'en' ? '\nWrite "why" in English.' : '') },
      {
        role: 'user',
        content: JSON.stringify(
          {
            user_request: userText,
            parsed_intent: intent,
            max_picks: maxPicks,
            products: compact,
          },
          null,
          0
        ),
      },
    ];
  }

  /* ------------------------------------------------------------------ *
   * JSON safety
   * ------------------------------------------------------------------ */

  /** Extract the first JSON object/array from a model response. */
  function safeJsonParse(text) {
    if (typeof text !== 'string') return null;
    const cleaned = text
      .replace(/^\uFEFF/, '')
      .replace(/```json/gi, '```')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {}
    // Fenced block
    const fence = cleaned.match(/```([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {}
    }
    // First balanced {...} or [...]
    for (const open of ['{', '[']) {
      const start = cleaned.indexOf(open);
      if (start === -1) continue;
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
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
          if (depth === 0) {
            try {
              return JSON.parse(cleaned.slice(start, i + 1));
            } catch {}
            break;
          }
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  async function fetchWithTimeout(url, options = {}, timeoutMs = 45000, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), timeoutMs);
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', () => ctrl.abort(externalSignal.reason), { once: true });
    }
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function resolveOllamaUrl(settings) {
    const raw = (settings?.ollama?.baseUrl || 'http://localhost:11434').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  }

  /**
   * Single chat entry point used by every provider.
   * @returns {Promise<{ok:boolean, text?:string, error?:string, provider:string, model:string, latencyMs:number}>}
   */
  async function chat(settings, { messages, json = true, temperature, timeoutMs = 60000, signal } = {}) {
    const provider = settings.provider || 'ollama';
    const started = Date.now();
    const temp = temperature ?? settings.temperature ?? 0.2;

    if (provider === 'builtin') {
      return { ok: false, error: 'BUILTIN', provider, model: 'builtin', latencyMs: 0 };
    }

    try {
      if (provider === 'ollama') {
        const base = resolveOllamaUrl(settings);
        const model = settings.ollama?.model || PROVIDER_META.ollama.defaultModel;
        const res = await fetchWithTimeout(
          `${base}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              stream: false,
              ...(json ? { format: 'json' } : {}),
              keep_alive: settings.ollama?.keepAlive || '10m',
              options: { temperature: temp, num_ctx: 8192, top_p: 0.9 },
            }),
          },
          timeoutMs,
          signal
        );
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const data = await res.json();
        const text = data?.message?.content ?? '';
        return { ok: true, text, provider, model, latencyMs: Date.now() - started };
      }

      if (provider === 'groq') {
        const key = settings.groq?.apiKey;
        if (!key) throw new Error('NO_KEY');
        const model = settings.groq?.model || PROVIDER_META.groq.defaultModel;
        const res = await fetchWithTimeout(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              messages,
              temperature: clamp(temp, 0, 1),
              max_tokens: 1600,
              ...(json ? { response_format: { type: 'json_object' } } : {}),
            }),
          },
          timeoutMs,
          signal
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error?.message || `Groq HTTP ${res.status}`);
        }
        const data = await res.json();
        return { ok: true, text: data?.choices?.[0]?.message?.content ?? '', provider, model, latencyMs: Date.now() - started };
      }

      if (provider === 'gemini') {
        const key = settings.gemini?.apiKey;
        if (!key) throw new Error('NO_KEY');
        const model = settings.gemini?.model || PROVIDER_META.gemini.defaultModel;
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const contents = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: system ? { parts: [{ text: system }] } : undefined,
              contents,
              generationConfig: {
                temperature: clamp(temp, 0, 2),
                maxOutputTokens: 2048,
                ...(json ? { responseMimeType: 'application/json' } : {}),
              },
            }),
          },
          timeoutMs,
          signal
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error?.message || `Gemini HTTP ${res.status}`);
        }
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        return { ok: true, text, provider, model, latencyMs: Date.now() - started };
      }

      throw new Error(`UNKNOWN_PROVIDER:${provider}`);
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? 'TIMEOUT' : String(err?.message || err);
      log.warn('chat failed', provider, msg);
      return { ok: false, error: msg, provider, model: settings?.[provider]?.model || 'unknown', latencyMs: Date.now() - started };
    }
  }

  /* ------------------------------------------------------------------ *
   * Connection test + model discovery
   * ------------------------------------------------------------------ */

  async function testConnection(settings, signal) {
    const provider = settings.provider || 'ollama';
    const started = Date.now();

    if (provider === 'builtin') {
      return { ok: true, provider, latencyMs: 0, message: 'builtin', models: ['rule-based-fa'] };
    }
    if (provider === 'ollama') {
      try {
        const base = resolveOllamaUrl(settings);
        const res = await fetchWithTimeout(`${base}/api/tags`, { method: 'GET' }, 8000, signal);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data?.models || []).map((m) => m.name || m.model).filter(Boolean);
        const configured = settings.ollama?.model;
        return {
          ok: true,
          provider,
          latencyMs: Date.now() - started,
          models,
          message: configured && models.length && !models.some((m) => m === configured || m.startsWith(configured + ':'))
            ? `MODEL_MISSING:${configured}`
            : 'ok',
        };
      } catch (err) {
        return { ok: false, provider, latencyMs: Date.now() - started, message: String(err?.message || err), models: [] };
      }
    }
    if (provider === 'groq') {
      const key = settings.groq?.apiKey;
      if (!key) return { ok: false, provider, latencyMs: 0, message: 'NO_KEY', models: [] };
      try {
        const res = await fetchWithTimeout('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } }, 10000, signal);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return { ok: true, provider, latencyMs: Date.now() - started, models: (data?.data || []).map((m) => m.id).filter(Boolean), message: 'ok' };
      } catch (err) {
        return { ok: false, provider, latencyMs: Date.now() - started, message: String(err?.message || err), models: [] };
      }
    }
    if (provider === 'gemini') {
      const key = settings.gemini?.apiKey;
      if (!key) return { ok: false, provider, latencyMs: 0, message: 'NO_KEY', models: [] };
      try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`, {}, 10000, signal);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data?.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''));
        return { ok: true, provider, latencyMs: Date.now() - started, models, message: 'ok' };
      } catch (err) {
        return { ok: false, provider, latencyMs: Date.now() - started, message: String(err?.message || err), models: [] };
      }
    }
    return { ok: false, provider, message: 'UNKNOWN_PROVIDER', models: [] };
  }

  const listModels = (settings, signal) => testConnection(settings, signal);

  /* ------------------------------------------------------------------ *
   * High level: intent
   * ------------------------------------------------------------------ */

  /**
   * Parse a natural-language command into a structured intent.
   * Always returns a usable intent — LLM first, rule-based fallback second.
   */
  async function parseIntent(text, settings = {}, { signal } = {}) {
    const fallback = builtinParseIntent(text, settings);
    const provider = settings.provider || 'ollama';

    if (provider === 'builtin' || !String(text || '').trim()) return fallback;

    const res = await chat(settings, { messages: buildIntentMessages(text), json: true, temperature: 0.1, timeoutMs: 45000, signal });
    if (!res.ok) {
      log.info('intent fell back to builtin parser:', res.error);
      return { ...fallback, explanation: fallback.explanation, degraded: true, degradedReason: res.error };
    }

    const parsed = safeJsonParse(res.text);
    if (!parsed || typeof parsed !== 'object') {
      return { ...fallback, degraded: true, degradedReason: 'BAD_JSON' };
    }

    const intent = sanitizeIntent(parsed, text, settings);
    intent.source = provider;
    intent.latencyMs = res.latencyMs;
    intent.model = res.model;

    // The local parser is more reliable for numbers — trust it when they disagree wildly.
    if (fallback.maxPrice && (!intent.maxPrice || Math.abs(intent.maxPrice - fallback.maxPrice) / fallback.maxPrice > 0.5)) {
      intent.maxPrice = fallback.maxPrice;
    }
    if (fallback.minPrice && !intent.minPrice) intent.minPrice = fallback.minPrice;
    if (!intent.query) intent.query = fallback.query;

    return intent;
  }

  /* ------------------------------------------------------------------ *
   * High level: ranking
   * ------------------------------------------------------------------ */

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
          reasons.push(lang === 'en' ? `Over budget by ${ShopAgent.utils.formatMoneyShort(price - intent.maxPrice)}` : `${ShopAgent.utils.formatMoneyShort(price - intent.maxPrice)} تومان بالاتر از بودجه`);
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
      if (norm >= 4.2) reasons.push(lang === 'en' ? `High rating (${norm.toFixed(1)})` : `امتیاز خریداران ${ShopAgent.utils.toPersianDigits(norm.toFixed(1))}`);
    }

    // Discount
    const disc = Number(product.discount) || 0;
    if (disc > 0) {
      score += Math.min(12, disc * 0.8);
      if (disc >= 15) reasons.push(lang === 'en' ? `${disc}% discount right now` : `${ShopAgent.utils.toPersianDigits(disc)}٪ تخفیف فعال`);
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
        try {
          const res = await chat(settings, {
            messages: buildRankMessages(pool, intent, userText, picks, lang),
            json: true,
            temperature: 0.2,
            timeoutMs: 60000,
            signal,
          });
          if (res.ok) {
            const parsed = safeJsonParse(res.text);
            const list = Array.isArray(parsed?.picks) ? parsed.picks : Array.isArray(parsed) ? parsed : null;
            if (list && list.length) {
              const byId = new Map(pool.map((p) => [String(p.id), p]));
              const reranked = [];
              for (const item of list) {
                const prod = byId.get(String(item?.id));
                if (!prod) continue;
                reranked.push({
                  ...prod,
                  score: clamp(Number(item.score) || prod.score, 0, 100),
                  why: item.why ? String(item.why).slice(0, 240) : prod.reasons[0],
                  aiRanked: true,
                });
              }
              if (reranked.length) return reranked.slice(0, picks);
            }
          } else {
            log.info('ranking fell back to local scorer:', res.error);
          }
        } catch (err) {
          log.warn('ranking error, using local scorer', err);
        }
      }
      return pool.slice(0, picks).map((p) => ({ ...p, why: p.reasons[0] || '', aiRanked: false }));
    }
  }

  ShopAgent.llm = {
    PROVIDER_META,
    SORTS,
    EMPTY_INTENT,
    sanitizeIntent,
    builtinParseIntent,
    extractQueryFallback,
    parseIntent,
    rankProducts,
    localScore,
    chat,
    testConnection,
    listModels,
    safeJsonParse,
    resolveOllamaUrl,
    buildIntentMessages,
  };
})(globalThis);
