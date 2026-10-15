/**
 * ShopAgent — shared/llm.js
 * ------------------------------------------------------------------
 * The AI core. Providers themselves live in background/providers/*
 * (uniform complete/stream interface); this module owns everything
 * ABOVE the transport:
 *
 *   • prompts (intent / ranking / repair)
 *   • the offline rule-based Persian parser (`builtin`)
 *   • intent parsing WITH streaming + one-shot auto-repair
 *   • deterministic local scorer + LLM re-ranking (validated)
 *   • graceful degradation: any model failure falls back to `builtin`
 *     so the extension never becomes useless.
 *
 * Loads in every context; network calls only happen where
 * ShopAgent.providers exists (the service worker).
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, parseBudget, toEnglishDigits, similarity, clamp } = ShopAgent.utils;
  const log = ShopAgent.utils.logger('llm');
  const json = ShopAgent.json;
  const schema = ShopAgent.schema;

  /* ------------------------------------------------------------------ *
   * Provider metadata (UI-facing; runtime META lives in each client)
   * ------------------------------------------------------------------ */

  const PROVIDER_META = {
    ollama: (ShopAgent.providers && ShopAgent.providers.ollama && ShopAgent.providers.ollama.META) || {
      id: 'ollama',
      needsKey: false,
      local: true,
      keyUrl: null,
      defaultModel: 'llama3.2',
      suggestedModels: ['llama3.2', 'llama3.1:8b', 'qwen2.5:7b', 'qwen2.5:3b', 'mistral', 'gemma2:9b', 'phi3'],
      install: 'ollama pull llama3.2',
    },
    groq: (ShopAgent.providers && ShopAgent.providers.groq && ShopAgent.providers.groq.META) || {
      id: 'groq',
      needsKey: true,
      local: false,
      keyUrl: 'https://console.groq.com/keys',
      defaultModel: 'llama-3.3-70b-versatile',
      suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
    },
    gemini: (ShopAgent.providers && ShopAgent.providers.gemini && ShopAgent.providers.gemini.META) || {
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

  const SORTS = schema.SORTS;
  const EMPTY_INTENT = schema.EMPTY_INTENT;

  /* ------------------------------------------------------------------ *
   * Prompts — trimmed to the minimum tokens that keep small models on
   * rails (every extra sentence is context the local model can lose).
   * ------------------------------------------------------------------ */

  const INTENT_SYSTEM_PROMPT = `You are the intent parser of "ShopAgent", a browser automation extension for Iranian e-commerce (Digikala, Basalam).
Convert the user's Persian (or English) shopping request into ONE strict JSON object. No prose, no markdown, no extra keys.

Schema:
{"intent":"search|filter|compare|question|unknown","query":"<max 6 keywords, no price, no store name>","minPrice":<Toman int|null>,"maxPrice":<Toman int|null>,"sort":"best_match|bestselling|cheapest|expensive|newest|discount","brand":"<or null>","category":"<short fa or null>","attributes":["…"],"targetStore":"digikala|basalam|null","maxResults":<1..24>,"confidence":<0..1>,"explanation":"<one short Persian sentence>"}

Rules:
- All prices in Toman (1 Rial = 0.1 Toman). «۳ میلیون تومان» = 3000000.
- «تا/زیر/کمتر از X» → maxPrice=X. «بالای/حداقل X» → minPrice=X. «بین A تا B» → both.
- "query" = only the product ("ایرپاد بی‌سیم"). Never price words, "بهترین", "پیدا کن" or store names.
- «بهترین» without ranking hints → sort "bestselling". Never invent prices/brands.
- Nothing product-like → intent "unknown", query "".

INPUT: بهترین ایرپاد تا ۳ میلیون تومان رو پیدا کن
OUTPUT: {"intent":"search","query":"ایرپاد","minPrice":null,"maxPrice":3000000,"sort":"bestselling","brand":null,"category":"صوتی","attributes":["بی‌سیم"],"targetStore":null,"maxResults":6,"confidence":0.93,"explanation":"دنبال بهترین ایرپاد با سقف سه میلیون تومان هستی."}

INPUT: ارزون‌ترین گوشی شیائومی تو دیجی کالا زیر ۸ میلیون
OUTPUT: {"intent":"search","query":"گوشی شیائومی","minPrice":null,"maxPrice":8000000,"sort":"cheapest","brand":"شیائومی","category":"موبایل","attributes":[],"targetStore":"digikala","maxResults":6,"confidence":0.95,"explanation":"ارزان‌ترین گوشی شیائومی زیر هشت میلیون تومان در دیجی‌کالا."}`;

  const REPAIR_INSTRUCTION = `Your previous answer was invalid and was rejected:
<invalid_output>
{INVALID}
</invalid_output>
Validation errors:
{ERRORS}

Answer again with ONE corrected strict JSON object only — same schema, no prose, no markdown fences. Fix every listed error.`;

  const RANK_SYSTEM_PROMPT = `You are the shopping advisor inside "ShopAgent". Rank the given real products (JSON array) for the user's intent.
Answer with ONE strict JSON object, no prose:
{"picks":[{"id":"<unchanged product id>","rank":<1-based int>,"score":<0..100 int>,"why":"<one short Persian sentence, max 25 words>"}]}
Rules:
- Respect the budget hard: above-maxPrice products only if fewer than 2 in-budget exist (say so in "why").
- Weigh: budget fit, rating, discount, brand match, requested attributes.
- At most {MAX_PICKS} picks. Never invent ids that are not in the input.`;

  /* ------------------------------------------------------------------ *
   * Message builders
   * ------------------------------------------------------------------ */

  function buildIntentMessages(text) {
    return [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: `INPUT: ${text}` },
    ];
  }

  /** Auto-repair round: show the model exactly what was wrong. */
  function buildRepairMessages(baseMessages, invalidOutput, errors) {
    return [
      ...baseMessages,
      { role: 'assistant', content: String(invalidOutput || '').slice(0, 1200) },
      { role: 'user', content: REPAIR_INSTRUCTION.replace('{INVALID}', String(invalidOutput || '').slice(0, 600)).replace('{ERRORS}', errors.map((e) => `- ${e}`).join('\n')) },
    ];
  }

  function buildRankMessages(products, intent, userText, maxPicks, lang) {
    const compact = products.slice(0, 40).map((p, i) => {
      const o = {
        id: p.id || `p${i}`,
        title: (p.title || '').slice(0, 90),
        price: p.price ?? null,
      };
      if (p.originalPrice) o.originalPrice = p.originalPrice;
      if (p.rating) o.rating = p.rating;
      if (p.ratingCount) o.ratingCount = p.ratingCount;
      if (p.discount) o.discount = p.discount;
      if (p.seller) o.seller = String(p.seller).slice(0, 30);
      return o;
    });
    // Send only the intent fields the ranker needs — not the whole object.
    const slimIntent = {
      query: intent.query,
      sort: intent.sort,
      minPrice: intent.minPrice,
      maxPrice: intent.maxPrice,
      brand: intent.brand,
      attributes: intent.attributes,
    };
    return [
      { role: 'system', content: RANK_SYSTEM_PROMPT.replace('{MAX_PICKS}', String(maxPicks)) + (lang === 'en' ? '\nWrite "why" in English.' : '') },
      { role: 'user', content: JSON.stringify({ user_request: String(userText || '').slice(0, 200), parsed_intent: slimIntent, max_picks: maxPicks, products: compact }) },
    ];
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
    { re: /(ارزان ?ترین|ارزانترین|ارزون ?ترین|ارزونترین|ارزون|ارزان|کمترین قیمت|قیمت پایین|cheapest|lowest price|budget)/i, sort: 'cheapest' },
    { re: /(گران ?ترین|گرانترین|بیشترین قیمت|لوکس ?ترین|most expensive|premium)/i, sort: 'expensive' },
    { re: /(پرفروش ?ترین|پرفروشترین|محبوب ?ترین|پرطرفدار|بیشترین فروش|best ?selling|most popular|popular)/i, sort: 'bestselling' },
    { re: /(جدید ?ترین|جدیدترین|تازه ?ترین|آخرین مدل|newest|latest)/i, sort: 'newest' },
    { re: /(بیشترین تخفیف|تخفیف ?دار|حراج|آفر|off|discount|deal)/i, sort: 'discount' },
    { re: /(بهترین|باکیفیت|بالاترین کیفیت|معتبرترین|best|highest quality|top rated)/i, sort: 'bestselling' },
  ];

  const ATTRIBUTE_RULES = [
    { re: /(بی‌?سیم|بیسیم|wireless)/i, attr: 'بی‌سیم' },
    { re: /(نویز ?کنسلینگ|حذف نویز|noise cancel)/i, attr: 'نویز کنسلینگ' },
    { re: /(ضد ?آب|مقاوم در برابر آب|waterproof|water resistant)/i, attr: 'ضد آب' },
    { re: /(اصل|اورجینال|original|authentic)/i, attr: 'اصل' },
    { re: /(گارانتی|warranty)/i, attr: 'گارانتی' },
    { re: /(سبک|lightweight)/i, attr: 'سبک' },
    { re: /(مردانه|men)/i, attr: 'مردانه' },
    { re: /(زنانه|women|خانم)/i, attr: 'زنانه' },
    { re: /(ورزشی|رانینگ|sport|running|دویدن)/i, attr: 'ورزشی' },
    { re: /(رسمی|formal|اداری)/i, attr: 'رسمی' },
    { re: /(gaming|گیمینگ)/i, attr: 'گیمینگ' },
    { re: /(5g|۵جی)/i, attr: '5G' },
    { re: /(ssd)/i, attr: 'SSD' },
  ];

  /** Offline intent parser — handles the most common Persian commands. */
  function builtinParseIntent(text, settings = {}) {
    const original = String(text || '');
    const norm = normalizeText(toEnglishDigits(original));
    const intent = { ...EMPTY_INTENT, source: 'builtin', maxResults: settings.maxResults || 6 };

    if (/(دیجی ?کالا|دیجیکالا|digikala)/i.test(norm)) intent.targetStore = 'digikala';
    else if (/(باسلام|با سلام|basalam)/i.test(norm)) intent.targetStore = 'basalam';

    const budget = parseBudget(original);
    intent.minPrice = budget.min;
    intent.maxPrice = budget.max;

    for (const rule of SORT_RULES) {
      if (rule.re.test(norm)) {
        intent.sort = rule.sort;
        break;
      }
    }
    for (const b of BRANDS) {
      if (norm.includes(normalizeText(b))) {
        intent.brand = b;
        break;
      }
    }
    for (const c of CATEGORY_HINTS) {
      if (c.re.test(norm)) {
        intent.category = c.cat;
        break;
      }
    }
    intent.attributes = [];
    for (const a of ATTRIBUTE_RULES) {
      if (a.re.test(norm)) intent.attributes.push(a.attr);
    }

    intent.query = schema.extractQueryFallback(original, STOP_WORDS);
    if (intent.brand && !intent.query.includes(normalizeText(intent.brand))) {
      intent.query = `${intent.brand} ${intent.query}`.trim();
    }

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
   * Transport bridge — the worker has providers, other contexts do not.
   * ------------------------------------------------------------------ */

  function providersAvailable() {
    return Boolean(ShopAgent.providers && ShopAgent.providers.complete);
  }

  /** Legacy dispatch kept for ad-hoc calls (worker-only). */
  async function chat(settings, { messages, prompt, systemPrompt, json: jsonMode = true, temperature, timeoutMs = 60000, signal, model, onDelta, stream: asStream } = {}) {
    const provider = settings.provider || 'ollama';
    if (provider === 'builtin') return { ok: false, error: 'BUILTIN', provider, model: 'builtin', latencyMs: 0 };
    if (!providersAvailable()) return { ok: false, error: 'NO_PROVIDERS_CONTEXT', provider, model: 'unknown', latencyMs: 0 };
    const opts = { messages, prompt, systemPrompt, json: jsonMode, temperature, timeoutMs, signal, model, settings, onDelta };
    return asStream ? ShopAgent.providers.stream(provider, settings, opts) : ShopAgent.providers.complete(provider, settings, opts);
  }

  /* ------------------------------------------------------------------ *
   * Intent: LLM first → validate → one auto-repair → builtin fallback
   * ------------------------------------------------------------------ */

  /**
   * Parse a natural-language command into a structured intent.
   * Always returns a usable intent.
   * @param {string} text
   * @param {object} settings
   * @param {{signal?:AbortSignal, onDelta?:(delta:string, info:{full:string, firstTokenMs?:number})=>void}} [opts]
   */
  async function parseIntent(text, settings = {}, { signal, onDelta } = {}) {
    const fallback = builtinParseIntent(text, settings);
    const provider = settings.provider || 'ollama';
    if (provider === 'builtin' || !String(text || '').trim()) return fallback;

    const baseMessages = buildIntentMessages(text);
    let lastInvalid = null;
    let lastErrors = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = attempt === 0 ? baseMessages : buildRepairMessages(baseMessages, lastInvalid, lastErrors);
      const res = await chat(settings, { messages, json: true, temperature: 0.1, timeoutMs: 45000, signal, stream: attempt === 0 && typeof onDelta === 'function', onDelta });

      if (!res.ok) {
        log.info('intent fell back to builtin parser:', res.error);
        return { ...fallback, degraded: true, degradedReason: res.error };
      }

      const parsed = json.safeJsonParse(res.text);
      const verdict = schema.validateIntent(parsed, { originalText: text, stopWords: STOP_WORDS });

      if (verdict.ok && verdict.value.query) {
        const intent = verdict.value;
        intent.source = provider;
        intent.latencyMs = res.latencyMs;
        intent.model = res.model;
        if (attempt > 0) intent.repaired = true;
        if (res.firstTokenMs != null) intent.firstTokenMs = res.firstTokenMs;
        return harmonize(intent, fallback);
      }

      lastInvalid = res.text;
      lastErrors = verdict.ok ? ['query خالی برگشت؛ عبارت جستجو را از متن کاربر استخراج کن.'] : verdict.errors;
      log.warn(`intent validation failed (attempt ${attempt + 1}):`, lastErrors.join(' | '));
    }

    // Both attempts failed → builtin, and tell the UI exactly why.
    return { ...fallback, degraded: true, degradedReason: 'BAD_JSON', repairAttempted: true, validationErrors: lastErrors };
  }

  /** The offline parser reads Persian numbers more reliably than small models. */
  function harmonize(intent, fallback) {
    if (fallback.maxPrice && (!intent.maxPrice || Math.abs(intent.maxPrice - fallback.maxPrice) / fallback.maxPrice > 0.5)) {
      intent.maxPrice = fallback.maxPrice;
    }
    if (fallback.minPrice && !intent.minPrice) intent.minPrice = fallback.minPrice;
    if (!intent.query) intent.query = fallback.query;
    return intent;
  }

  /* ------------------------------------------------------------------ *
   * Ranking: deterministic local scorer + validated LLM re-rank
   * ------------------------------------------------------------------ */

  function localScore(product, intent, lang = 'fa') {
    const reasons = [];
    let score = 40;

    const sim = similarity(product.title || '', intent.query || '');
    score += sim * 26;
    if (sim > 0.55) reasons.push(lang === 'en' ? 'Title matches your request closely' : 'عنوان کالا با درخواست شما هم‌خوانی بالایی دارد');

    if (intent.brand) {
      const t = `${normalizeText(product.title || '')} ${normalizeText(product.brand || '')}`;
      if (t.includes(normalizeText(intent.brand))) {
        score += 12;
        reasons.push(lang === 'en' ? `Genuine ${intent.brand}` : `برند ${intent.brand} مطابقت دارد`);
      } else {
        score -= 18;
      }
    }

    if (intent.attributes && intent.attributes.length) {
      const t = normalizeText(product.title || '');
      let hits = 0;
      for (const a of intent.attributes) if (t.includes(normalizeText(a))) hits++;
      const ratio = hits / intent.attributes.length;
      score += ratio * 14;
      if (ratio >= 0.5) reasons.push(lang === 'en' ? 'Has the features you asked for' : 'ویژگی‌های خواسته‌شده را دارد');
    }

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
      score -= 20;
    }

    const rating = Number(product.rating);
    if (Number.isFinite(rating) && rating > 0) {
      const norm = rating > 5 ? rating / 20 : rating;
      score += (norm - 3) * 5 + 4;
      const count = Number(product.ratingCount) || 0;
      if (count >= 50) score += 4;
      if (norm >= 4.2) reasons.push(lang === 'en' ? `High rating (${norm.toFixed(1)})` : `امتیاز خریداران ${ShopAgent.utils.toPersianDigits(norm.toFixed(1))}`);
    }

    const disc = Number(product.discount) || 0;
    if (disc > 0) {
      score += Math.min(12, disc * 0.8);
      if (disc >= 15) reasons.push(lang === 'en' ? `${disc}% discount right now` : `${ShopAgent.utils.toPersianDigits(disc)}٪ تخفیف فعال`);
    }

    if (intent.sort === 'cheapest' && price > 0) score += 6;
    if (intent.sort === 'bestselling' && (Number(product.ratingCount) || 0) > 100) score += 6;

    return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 3) };
  }

  async function rankProducts(products, intent, { settings = {}, userText = '', lang = 'fa', maxPicks = 6, signal } = {}) {
    if (!Array.isArray(products) || !products.length) return [];

    const base = products.map((p) => {
      const { score, reasons } = localScore(p, intent, lang);
      return { ...p, score, reasons };
    });

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

    if (intent.maxPrice) {
      const inBudget = base.filter((p) => p.price && p.price <= intent.maxPrice);
      if (inBudget.length >= 2) return finalize(inBudget.slice(0, maxPicks * 3), maxPicks);
    }
    return finalize(base.slice(0, maxPicks * 3), maxPicks);

    async function finalize(pool, picks) {
      const provider = settings.provider || 'ollama';
      if (provider !== 'builtin' && providersAvailable()) {
        try {
          const res = await chat(settings, { messages: buildRankMessages(pool, intent, userText, picks, lang), json: true, temperature: 0.2, timeoutMs: 60000, signal });
          if (res.ok) {
            const parsed = json.safeJsonParse(res.text);
            const verdict = schema.validateRanking(parsed, pool);
            if (verdict.value.length) {
              return verdict.value.slice(0, picks).map((p) => ({
                ...p,
                why: p.why || p.reasons[0] || '',
                aiRanked: true,
              }));
            }
            log.warn('ranking validation produced no usable picks:', verdict.errors.join(' | '));
          } else {
            log.info('ranking fell back to local scorer:', res.error);
          }
        } catch (err) {
          log.warn('ranking error, using local scorer', err);
        }
      }
      return pool.slice(0, picks).map((p, i) => ({ ...p, rank: i + 1, why: p.reasons[0] || '', aiRanked: false }));
    }
  }

  /* ------------------------------------------------------------------ *
   * Connection helpers
   * ------------------------------------------------------------------ */

  async function testConnection(settings, signal) {
    if (!providersAvailable()) {
      const provider = settings?.provider || 'ollama';
      if (provider === 'builtin') return { ok: true, provider, latencyMs: 0, models: ['rule-based-fa'], message: 'builtin' };
      return { ok: false, provider, latencyMs: 0, models: [], message: 'NO_PROVIDERS_CONTEXT' };
    }
    return ShopAgent.providers.testConnection(settings, signal);
  }

  const listModels = (settings, signal) => testConnection(settings, signal);

  const resolveOllamaUrl = (settings) =>
    (ShopAgent.providers?.ollama ? ShopAgent.providers.ollama.baseUrl(settings) : settings?.ollama?.baseUrl || 'http://localhost:11434');

  ShopAgent.llm = {
    PROVIDER_META,
    SORTS,
    EMPTY_INTENT,
    STOP_WORDS,
    validateIntent: schema.validateIntent,
    validateRanking: schema.validateRanking,
    sanitizeIntent: (raw, originalText, settings) => schema.validateIntent(raw, { originalText, stopWords: STOP_WORDS, settings }).value,
    builtinParseIntent,
    extractQueryFallback: (t) => schema.extractQueryFallback(t, STOP_WORDS),
    parseIntent,
    rankProducts,
    localScore,
    chat,
    testConnection,
    listModels,
    safeJsonParse: json.safeJsonParse,
    resolveOllamaUrl,
    buildIntentMessages,
    buildRepairMessages,
    buildRankMessages,
    INTENT_SYSTEM_PROMPT,
    RANK_SYSTEM_PROMPT,
  };
})(globalThis);
