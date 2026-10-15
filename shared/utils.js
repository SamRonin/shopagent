/**
 * ShopAgent — shared/utils.js
 * ------------------------------------------------------------------
 * Pure helpers shared by the side panel, the service worker and the
 * content script. No DOM, no chrome.* APIs (except where noted), so the
 * same file can be loaded in every context.
 *
 * Loaded as a classic script; everything is exposed on `globalThis.ShopAgent`.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  /* ------------------------------------------------------------------ *
   * 1. Persian / Arabic digit + text normalisation
   * ------------------------------------------------------------------ */

  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'; // ۰-۹
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'; // ٠-٩

  /** Convert Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII. */
  function toEnglishDigits(input) {
    if (input === null || input === undefined) return '';
    return String(input)
      .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  }

  /** Convert ASCII digits of a string/number to Persian digits. */
  function toPersianDigits(input) {
    if (input === null || input === undefined) return '';
    return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
  }

  /**
   * Aggressive text normalisation used before every comparison:
   * removes ZWNJ/harakat, unifies Arabic & Persian letter variants,
   * collapses whitespace and lower-cases.
   */
  function normalizeText(input) {
    if (input === null || input === undefined) return '';
    let s = String(input);
    // ZWNJ/ZWJ join letters into one word (دیجی‌کالا → دیجیکالا); the other
    // zero-widths, bidi marks and the BOM behave like spaces.
    s = s.replace(/[\u200C\u200D]/g, '');
    s = s.replace(/[\u200B\u200E\u200F\u202A-\u202E\uFEFF]/g, ' ');
    s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, ''); // harakat / Quranic marks
    s = s.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه');
    s = s.replace(/آ/g, 'ا').replace(/[إأ]/g, 'ا');
    s = s.replace(/[\u066C\u066B٬٫،]/g, ','); // Arabic decimal / thousands separators
    s = s.replace(/\u00A0|\u2009|\u202F/g, ' '); // nbsp, thin space
    s = s.replace(/[ً-ٟ]/g, (c) => (/[۰-۹٠-٩]/.test(c) ? c : ' '));
    s = s.replace(/\s+/g, ' ').trim();
    return s.toLowerCase();
  }

  /* ------------------------------------------------------------------ *
   * 2. Money parsing — Toman / Rial / "میلیون" phrasing
   * ------------------------------------------------------------------ */

  const RIAL_RE = /(ریال|ريال|rial)/i;
  const TOMAN_RE = /(تومان|تومن|تمن|toman)/i;

  const MULTIPLIERS = [
    { re: /(میلیارد|ميليارد|بیلیارد|billion)/i, mul: 1e9 },
    { re: /(میلیون|ميليون|million)/i, mul: 1e6 },
    { re: /(هزار|هزارتومان|هزار تومان|کیلو|k\b|thousand)/i, mul: 1e3 },
  ];

  const PLausible_MIN = 500; // below 500 Toman is never a real product price
  const PLausible_MAX = 20_000_000_000; // 20 میلیارد تومان

  /**
   * Strip grouping separators from a numeric-ish substring.
   * `1,234,567` → `1234567`, `۱.۲۳۴.۵۶۷` → `1234567`, `2.5` → `2.5`
   */
  function collapseNumber(raw) {
    let s = toEnglishDigits(raw).replace(/[\s\u00A0,\u066C٬'’]/g, '');
    // A single dot surrounded by 1-3 trailing digits at the end = decimal point.
    const decMatch = s.match(/^(\d+)\.(\d{1,3})$/);
    if (decMatch) return decMatch[1] + '.' + decMatch[2];
    // Otherwise dots/commas are grouping separators.
    return s.replace(/[.,]/g, '');
  }

  /**
   * Extract every money-like value from a string.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {'toman'|'rial'} [opts.defaultUnit='toman'] unit assumed when none is stated
   * @returns {Array<{value:number, unit:string, index:number, raw:string, multiplier:string|null}>}
   */
  function extractMoney(text, opts = {}) {
    const src = String(text ?? '');
    const norm = toEnglishDigits(src);
    const out = [];
    const numberRe = /\d[\d.,\s\u00A0\u066C٬'’]*\d|\d+/g;
    let m;

    while ((m = numberRe.exec(norm)) !== null) {
      const collapsed = collapseNumber(m[0]);
      const numeric = Number(collapsed);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;

      // Look at a small window after (and before) the number for a multiplier word.
      const tail = norm.slice(m.index + m[0].length, m.index + m[0].length + 14);
      const head = norm.slice(Math.max(0, m.index - 14), m.index);
      let multiplier = null;
      let mul = 1;
      for (const entry of MULTIPLIERS) {
        if (entry.re.test(tail)) {
          multiplier = entry.re.source;
          mul = entry.mul;
          break;
        }
      }
      if (mul === 1) {
        for (const entry of MULTIPLIERS) {
          if (entry.re.test(head)) {
            multiplier = entry.re.source;
            mul = entry.mul;
            break;
          }
        }
      }

      const value = numeric * mul;

      // Unit detection: nearest explicit unit wins, else the document default.
      const tailUnit = norm.slice(m.index, m.index + m[0].length + 20);
      const headUnit = norm.slice(Math.max(0, m.index - 20), m.index);
      let unit = opts.defaultUnit || 'toman';
      if (RIAL_RE.test(tailUnit) || RIAL_RE.test(headUnit)) unit = 'rial';
      else if (TOMAN_RE.test(tailUnit) || TOMAN_RE.test(headUnit)) unit = 'toman';

      out.push({
        value: unit === 'rial' ? Math.round(value / 10) : Math.round(value),
        unit,
        index: m.index,
        raw: src.slice(m.index, m.index + m[0].length + (multiplier ? 14 : 0)).trim(),
        multiplier,
      });
      // Guard against pathological loops on zero-width matches.
      if (m.index === numberRe.lastIndex) numberRe.lastIndex++;
    }
    return out;
  }

  /**
   * Convenience wrapper: return the single best price (in Toman) of a string.
   *
   * @param {string} text
   * @param {{prefer?:'first'|'max'|'min', min?:number, max?:number}} [opts]
   * @returns {number|null}
   */
  function parsePrice(text, opts = {}) {
    const all = extractMoney(text, opts);
    const lo = opts.min ?? PLausible_MIN;
    const hi = opts.max ?? PLausible_MAX;
    const plausible = all.filter((c) => c.value >= lo && c.value <= hi);
    const pool = plausible.length ? plausible : all;
    if (!pool.length) return null;
    if (opts.prefer === 'max') return pool.reduce((a, b) => (b.value > a.value ? b : a)).value;
    if (opts.prefer === 'min') return pool.reduce((a, b) => (b.value < a.value ? b : a)).value;
    return pool[0].value;
  }

  /**
   * Parse a natural-language budget phrase such as
   *   «تا ۳ میلیون تومان»  → { max: 3000000 }
   *   «بین ۵۰۰ هزار تا ۲ میلیون» → { min: 500000, max: 2000000 }
   *
   * @param {string} text
   * @returns {{min:number|null, max:number|null}}
   */
  function parseBudget(text) {
    const src = normalizeText(toEnglishDigits(String(text ?? '')));
    const result = { min: null, max: null };
    if (!src) return result;

    // NOTE: «بالای» is a *minimum* marker, so it must NOT appear here.
    const upperMarker = /(تا|حداکثر|نهایت|کمتر از|زیر|at most|under|below|max|up to)\s*([^،,؛;\n]*)/i;
    const lowerMarker = /(از|حداقل|بالای|بیش از|more than|at least|over|min|from)\s*([^،,؛;\n]*)/i;
    const betweenMarker = /بین\s*(.+?)\s*(?:تا|و|-|–)\s*(.+?)(?:\s*(?:تومان|ریال|tomans?|rial))?\s*(?:$|[،,؛;.])/i;

    const between = src.match(betweenMarker);
    if (between) {
      result.min = parsePrice(between[1], { prefer: 'first' });
      result.max = parsePrice(between[2], { prefer: 'first' });
      if (result.min && result.max && result.min > result.max) {
        [result.min, result.max] = [result.max, result.min];
      }
      return result;
    }

    const up = src.match(upperMarker);
    if (up) result.max = parsePrice(up[2], { prefer: 'max' });

    const down = src.match(lowerMarker);
    if (down) {
      const v = parsePrice(down[2], { prefer: 'min' });
      // «بالای ۲ میلیون» is a *minimum*, «زیر ۲ میلیون» is a *maximum*.
      if (/^(بالای|بیش از|more than|over|at least|min)/i.test(down[1])) result.min = v;
      else if (result.max === null) result.min = v;
    }

    // «۳ میلیون تومان» with no marker → treat as a ceiling.
    if (result.min === null && result.max === null) {
      const bare = parsePrice(src, { prefer: 'max' });
      if (bare) result.max = bare;
    }
    return result;
  }

  /** Format a Toman amount with thousand separators. */
  function formatMoney(value, { digits = 'fa', unit = true } = {}) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Math.round(Number(value));
    const grouped = n.toLocaleString('en-US');
    const body = digits === 'fa' ? toPersianDigits(grouped) : grouped;
    return unit ? `${body} تومان` : body;
  }

  /** Short human form: 3,000,000 → «۳ میلیون». */
  function formatMoneyShort(value, { digits = 'fa' } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    let out;
    if (abs >= 1e9) out = `${trim(n / 1e9)} میلیارد`;
    else if (abs >= 1e6) out = `${trim(n / 1e6)} میلیون`;
    else if (abs >= 1e3) out = `${trim(n / 1e3)} هزار`;
    else out = String(n);
    return digits === 'fa' ? toPersianDigits(out) : out;

    function trim(x) {
      return String(Math.round(x * 100) / 100).replace(/\.0+$/, '');
    }
  }

  /* ------------------------------------------------------------------ *
   * 3. Small generic helpers
   * ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function uid(prefix = 'sa') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function debounce(fn, wait = 250) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Jaccard-ish token overlap in [0,1] — used for title/query relevance. */
  function similarity(a, b) {
    const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
    const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    // Partial (substring) credit for Persian morphology.
    if (hit === 0) {
      for (const x of ta) {
        for (const y of tb) {
          if (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))) hit += 0.5;
        }
      }
    }
    return clamp(hit / Math.max(ta.size, tb.size), 0, 1);
  }

  /** Absolute URL resolver that tolerates protocol-less hrefs. */
  function absoluteUrl(href, base) {
    if (!href) return null;
    try {
      return new URL(href, base || (typeof location !== 'undefined' ? location.href : undefined)).href;
    } catch {
      return null;
    }
  }

  /**
   * Tiny structured logger. Set `ShopAgent.utils.setLogLevel('debug')`
   * (or the "Debug logs" switch in settings) to see everything.
   */
  const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  let currentLevel = LOG_LEVELS.info;

  function setLogLevel(level) {
    currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }

  function logger(tag) {
    const emit = (lvl, args) => {
      if (LOG_LEVELS[lvl] > currentLevel) return;
      const fn = console[lvl] || console.log;
      fn(`%c ShopAgent %c ${tag} `, 'background:#0f766e;color:#fff;border-radius:3px 0 0 3px;padding:1px 4px', 'background:#f1f5f9;color:#0f172a;border-radius:0 3px 3px 0;padding:1px 4px', ...args);
    };
    return {
      error: (...a) => emit('error', a),
      warn: (...a) => emit('warn', a),
      info: (...a) => emit('info', a),
      debug: (...a) => emit('debug', a),
    };
  }

  ShopAgent.utils = {
    FA_DIGITS,
    AR_DIGITS,
    toEnglishDigits,
    toPersianDigits,
    normalizeText,
    extractMoney,
    parsePrice,
    parseBudget,
    formatMoney,
    formatMoneyShort,
    sleep,
    randInt,
    clamp,
    uid,
    debounce,
    escapeHtml,
    similarity,
    absoluteUrl,
    logger,
    setLogLevel,
    LOG_LEVELS,
  };
})(globalThis);
