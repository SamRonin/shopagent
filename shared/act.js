/**
 * ShopAgent — shared/act.js
 * ------------------------------------------------------------------
 * The ACTION CONTRACT — the whitelist that stands between a language
 * model and the user's shopping account.
 *
 * Every executable action is declared here with a risk level:
 *
 *   safe      → runs without asking (navigation, reading, sorting)
 *   confirm   → runs only after an explicit approval in the side panel
 *              (Human-in-the-Loop: ADD_TO_CART acts on the account)
 *   blocked   → NEVER automated, no confirmation offered
 *              (PAY / CHECKOUT / PLACE_ORDER / CHANGE_ADDRESS — the
 *               user must do these themselves on the site)
 *
 * `validate()` is the single gate used by the background BEFORE an
 * action is executed, and repeated inside the content script as
 * defence in depth. Unknown actions are rejected, never guessed.
 *
 * Pure module: no DOM, no chrome.*, no network — unit-testable.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  const RISK = { SAFE: 'safe', CONFIRM: 'confirm', BLOCKED: 'blocked' };

  /* ------------------------------------------------------------------ *
   * Catalog
   * ------------------------------------------------------------------ */

  const str = (max = 200, required = false) => ({ type: 'string', max, required });
  const int = (min, max, required = false) => ({ type: 'int', min, max, required });
  const enumOf = (values, required = false) => ({ type: 'enum', values, required });
  const strList = (max = 8, required = false) => ({ type: 'string[]', max, required });
  const url = (required = false) => ({ type: 'url', required });

  const CATALOG = {
    /* ---- safe: read & navigate ---- */
    SEARCH: { risk: RISK.SAFE, params: { query: str(160, true) }, fa: 'جستجوی کالا', en: 'Search for a product' },
    SCROLL: { risk: RISK.SAFE, params: { rounds: int(1, 12) }, fa: 'اسکرول صفحه', en: 'Scroll the page' },
    EXTRACT: { risk: RISK.SAFE, params: { limit: int(1, 200) }, fa: 'خواندن کالاها', en: 'Read the products' },
    SORT: {
      risk: RISK.SAFE,
      params: { mode: enumOf(['best_match', 'bestselling', 'cheapest', 'expensive', 'newest', 'discount'], true) },
      fa: 'مرتب‌سازی نتایج',
      en: 'Sort the results',
    },
    PRICE_FILTER: { risk: RISK.SAFE, params: { min: int(1000, 1e12), max: int(1000, 1e12) }, fa: 'فیلتر قیمت', en: 'Price filter' },
    CLICK_TEXT: { risk: RISK.SAFE, params: { labels: strList(6, true) }, fa: 'کلیک روی متن', en: 'Click a labelled element' },
    GO_NEXT_PAGE: { risk: RISK.SAFE, params: {}, fa: 'صفحهٔ بعد', en: 'Next page' },
    OPEN_PRODUCT: { risk: RISK.SAFE, params: { url: url(true) }, fa: 'باز کردن صفحهٔ کالا', en: 'Open the product page' },

    /* ---- confirm: acts on the account, but reversible ---- */
    ADD_TO_CART: { risk: RISK.CONFIRM, params: {}, fa: 'افزودن به سبد خرید', en: 'Add to the shopping cart' },

    /* ---- blocked: money / identity — never automated ---- */
    PAY: { risk: RISK.BLOCKED, params: {}, fa: 'پرداخت', en: 'Payment' },
    CHECKOUT: { risk: RISK.BLOCKED, params: {}, fa: 'تکمیل خرید', en: 'Checkout' },
    PLACE_ORDER: { risk: RISK.BLOCKED, params: {}, fa: 'ثبت سفارش', en: 'Place the order' },
    CHANGE_ADDRESS: { risk: RISK.BLOCKED, params: {}, fa: 'تغییر آدرس', en: 'Change the address' },
    PAYMENT_METHOD: { risk: RISK.BLOCKED, params: {}, fa: 'تغییر روش پرداخت', en: 'Change the payment method' },
  };

  const SORTS = CATALOG.SORT.params.mode.values;

  /* ------------------------------------------------------------------ *
   * Validation
   * ------------------------------------------------------------------ */

  function checkParam(spec, value) {
    if (value === undefined || value === null || value === '') {
      return spec.required ? 'MISSING' : { ok: true, value: undefined };
    }
    switch (spec.type) {
      case 'string': {
        if (typeof value !== 'string') return 'TYPE';
        const v = value.trim().slice(0, spec.max);
        return v ? { ok: true, value: v } : 'EMPTY';
      }
      case 'string[]': {
        if (!Array.isArray(value)) return 'TYPE';
        const v = value
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim().slice(0, 120))
          .slice(0, spec.max);
        return v.length ? { ok: true, value: v } : 'EMPTY';
      }
      case 'int': {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'TYPE';
        const i = Math.round(n);
        if (i < spec.min || i > spec.max) return 'RANGE';
        return { ok: true, value: i };
      }
      case 'enum':
        return spec.values.includes(value) ? { ok: true, value } : 'ENUM';
      case 'url': {
        if (typeof value !== 'string') return 'TYPE';
        try {
          const u = new URL(value);
          if (!/^https?:$/.test(u.protocol)) return 'ENUM';
          return { ok: true, value: u.href };
        } catch {
          return 'TYPE';
        }
      }
      default:
        return 'TYPE';
    }
  }

  /**
   * Validate a candidate action coming from the model (or the panel).
   * @param {{action:string, params?:object}} candidate
   * @returns {{ok:true, action:string, params:object, risk:string, fa:string, en:string}
   *          |{ok:false, error:'ACTION_INVALID'|'ACTION_BLOCKED', risk:string, action?:string}}
   */
  function validate(candidate) {
    const raw = candidate && typeof candidate === 'object' ? candidate : {};
    const name = String(raw.action || '').toUpperCase().replace(/[\s-]+/g, '_');
    const entry = CATALOG[name];
    if (!entry) return { ok: false, error: 'ACTION_INVALID', risk: 'invalid', action: name || null };

    // Blocked actions are refused BEFORE any parameter handling — a
    // payment must never be one «confirm» click away from happening.
    if (entry.risk === RISK.BLOCKED) return { ok: false, error: 'ACTION_BLOCKED', risk: RISK.BLOCKED, action: name };

    const params = {};
    for (const [key, spec] of Object.entries(entry.params)) {
      const res = checkParam(spec, raw.params ? raw.params[key] : undefined);
      if (typeof res === 'string') {
        return { ok: false, error: 'ACTION_INVALID', risk: 'invalid', action: name, detail: `${key}:${res}` };
      }
      if (res.value !== undefined) params[key] = res.value;
    }
    return { ok: true, action: name, params, risk: entry.risk, fa: entry.fa, en: entry.en };
  }

  /** Localised label for an action name. */
  function label(action, lang = 'fa') {
    const entry = CATALOG[String(action || '').toUpperCase()];
    if (!entry) return '';
    return lang === 'en' ? entry.en : entry.fa;
  }

  /**
   * The confirmation copy shown in the side panel before a `confirm`
   * action runs. Always names the exact action and the product, so the
   * user approves something concrete — never a vague «continue?».
   */
  function buildConfirmation(action, params, lang = 'fa') {
    const name = String(action || '').toUpperCase();
    const what = label(name, lang);
    const product = params && params.productTitle ? String(params.productTitle).slice(0, 120) : '';
    if (lang === 'en') {
      return {
        title: 'Confirm this action',
        body: product
          ? `ShopAgent wants to “${what}” for: ${product}. Approve only if this is what you meant.`
          : `ShopAgent wants to “${what}”. Approve only if this is what you meant.`,
      };
    }
    return {
      title: 'تأیید اکشن',
      body: product
        ? `خرید‌یار می‌خواهد «${what}» را برای این کالا انجام دهد: ${product} — فقط در صورت اطمینان تأیید کن.`
        : `خرید‌یار می‌خواهد «${what}» را انجام دهد. فقط در صورت اطمینان تأیید کن.`,
    };
  }

  /* ------------------------------------------------------------------ *
   * Intent → deterministic plan (offline fallback for planAction)
   * ------------------------------------------------------------------ */

  /** Map the intent's requested follow-up onto a validated action. */
  function planFromIntent(intent) {
    const wanted = String(intent?.action || '').toLowerCase();
    if (wanted === 'add_to_cart') return { action: 'ADD_TO_CART', params: {} };
    if (wanted === 'open_product') return { action: 'OPEN_PRODUCT', params: { url: intent?.productUrl || '' } };
    return null;
  }

  ShopAgent.act = {
    RISK,
    CATALOG,
    SORTS,
    validate,
    label,
    buildConfirmation,
    planFromIntent,
  };
})(globalThis);
