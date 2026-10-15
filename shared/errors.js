/**
 * ShopAgent — shared/errors.js
 * ------------------------------------------------------------------
 * One place that turns a raw failure (Error, string, or a stable CODE
 * from a provider) into clear, actionable Persian/English guidance.
 *
 * The background service worker is the only place that can see the
 * network for real, so every message it broadcasts for a failure goes
 * through `describe()` here. The side panel reuses the same table for
 * its inline alerts, so wording never drifts between surfaces.
 *
 * Codes are stable identifiers; `describe()` maps them to prose.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  /** Pull a stable code out of whatever a layer threw. */
  function codeOf(input) {
    if (!input) return 'UNKNOWN';
    if (typeof input === 'string') return input;
    if (input.code && typeof input.code === 'string') return input.code;
    const msg = String(input.message || input.error || input);
    if (/^[A-Z][A-Z0-9_]*$/.test(msg)) return msg;
    return msg;
  }

  /**
   * @param {any} input  Error | string | {error}
   * @param {{provider?:string, lang?:'fa'|'en', model?:string}} [opts]
   * @returns {string} human guidance in the requested language
   */
  function describe(input, opts = {}) {
    const lang = opts.lang === 'en' ? 'en' : 'fa';
    const provider = opts.provider || '';
    const code = codeOf(input);

    // Provider-specific guidance first: a failed fetch to a LOCAL service
    // is almost always "service not running", not a generic network error.
    if (provider === 'ollama') {
      if (code === 'NETWORK' || code === 'UNKNOWN') return TABLE.OLLAMA_OFFLINE[lang];
      if (code === 'HTTP_404') return TABLE.MODEL_MISSING[lang];
    }

    const row = TABLE[code] || TABLE[code.split(':')[0]];
    if (row) return row[lang];

    // HTTP fallbacks for codes we did not enumerate.
    const http = code.match(/^HTTP_(\d{3})$/);
    if (http) {
      const n = Number(http[1]);
      if (n === 401 || n === 403) return TABLE.HTTP_401[lang];
      if (n === 404) return provider === 'ollama' ? TABLE.MODEL_MISSING[lang] : TABLE.HTTP_404[lang];
      if (n === 429) return TABLE.HTTP_429[lang];
      if (n >= 500) return TABLE.HTTP_5XX[lang];
      return TABLE.UNKNOWN[lang];
    }

    return provider === 'ollama' ? TABLE.OLLAMA_OFFLINE[lang] : TABLE.UNKNOWN[lang];
  }

  const TABLE = {
    /* ---- network / connectivity ---- */
    NETWORK: {
      fa: 'درخواست ناموفق بود: یا اتصال اینترنت قطع است، یا مرورگر درخواست را بلاک کرده (CORS). اینترنت را بررسی کن و دوباره تلاش کن.',
      en: 'The request failed: either the internet is down or the browser blocked it (CORS). Check your connection and retry.',
    },
    OFFLINE: {
      fa: 'به نظر می‌رسد آفلاین هستی. ابتدا به اینترنت وصل شو.',
      en: 'You appear to be offline. Connect to the internet first.',
    },
    TIMEOUT: {
      fa: 'مدل دیر جواب داد و وقت تمام شد (تایم‌اوت). یک مدل سبک‌تر انتخاب کن یا دوباره تلاش کن.',
      en: 'The model took too long (timeout). Pick a lighter model or retry.',
    },
    ABORTED: {
      fa: 'اجرا متوقف شد.',
      en: 'The run was stopped.',
    },

    /* ---- provider specific ---- */
    OLLAMA_OFFLINE: {
      fa: 'سرویس Ollama روی http://localhost:11434 در دسترس نیست. یک ترمینال باز کن و «ollama serve» را اجرا کن، سپس با «ollama pull llama3.2» مدل را نصب کن.',
      en: 'Ollama is not reachable at http://localhost:11434. Run “ollama serve” in a terminal, then “ollama pull llama3.2”.',
    },
    MODEL_MISSING: {
      fa: 'مدل انتخاب‌شده روی Ollama نصب نیست. در ترمینال بزن: ollama pull <model> (مثلاً ollama pull llama3.2).',
      en: 'The selected model is not installed in Ollama. Run: ollama pull <model> (e.g. ollama pull llama3.2).',
    },
    NO_KEY: {
      fa: 'کلید API وارد نشده است. از تنظیمات، کلید رایگان پرووایدر را وارد کن.',
      en: 'No API key configured. Add the provider’s free key in settings.',
    },
    HTTP_401: {
      fa: 'کلید API نامعتبر یا منقضی شده است. کلید را در تنظیمات بررسی کن.',
      en: 'The API key is invalid or expired. Check it in settings.',
    },
    HTTP_429: {
      fa: 'محدودیت نرخ درخواست (rate limit) فعال شد. چند لحظه صبر کن و دوباره تلاش کن.',
      en: 'Rate limit reached. Wait a moment and retry.',
    },
    HTTP_404: {
      fa: 'آدرس یا نام مدل پیدا نشد (۴۰۴). نام مدل را در تنظیمات بررسی کن.',
      en: 'Endpoint or model not found (404). Check the model name in settings.',
    },
    HTTP_5XX: {
      fa: 'سرویس پرووایدر موقتاً در دسترس نیست (خطای سرور). کمی بعد دوباره تلاش کن.',
      en: 'The provider is temporarily unavailable (server error). Retry shortly.',
    },

    /* ---- model output / validation ---- */
    BAD_JSON: {
      fa: 'پاسخ مدل JSON معتبر نبود. یک بار درخواست اصلاح ارسال شد اما باز هم ناموفق بود؛ به تحلیل‌گر داخلی (آفلاین) برگشت ختم.',
      en: 'The model reply was not valid JSON. One repair attempt failed too, so the offline parser was used.',
    },
    INVALID_SCHEMA: {
      fa: 'ساختار پاسخ مدل با قرارداد اکشن‌ها مطابقت نداشت. به حالت امن (اجرای نشدن) برگشت ختم.',
      en: 'The model reply did not match the action contract, so nothing was executed.',
    },
    REPAIR_FAILED: {
      fa: 'تلاش برای اصلاح خودکار پاسخ مدل ناموفق بود.',
      en: 'The automatic repair of the model reply failed.',
    },
    STREAM_UNSUPPORTED: {
      fa: 'پرووایدر انتخاب‌شده پاسخ زنده (استریم) نمی‌دهد. برای گفتگو، Ollama یا Groq یا Gemini را از تنظیمات انتخاب کن.',
      en: 'The selected provider does not support streamed answers. Pick Ollama, Groq or Gemini in settings for chat.',
    },
    STREAM_ERROR: {
      fa: 'جریان پاسخ مدل قطع شد.',
      en: 'The model stream was interrupted.',
    },

    /* ---- actions ---- */
    ACTION_BLOCKED: {
      fa: 'این اکشن به‌طور خودکار انجام نمی‌شود (پرداخت، ثبت سفارش یا تغییر آدرس). لطفاً خودت در سایت انجامش بده.',
      en: 'This action is never automated (payment, placing an order, changing an address). Please do it yourself on the site.',
    },
    ACTION_INVALID: {
      fa: 'اکشن دریافتی نامعتبر بود و اجرا نشد.',
      en: 'The received action was invalid and was not executed.',
    },
    ACTION_UNCONFIRMED: {
      fa: 'تأییدیهٔ شما دریافت نشد؛ اکشن اجرا نشد.',
      en: 'Your confirmation was not received; the action was not executed.',
    },

    /* ---- page / tab ---- */
    TAB_ERROR: {
      fa: 'مشکل در باز کردن یا پیدا کردن تب مرورگر. یک تب از فروشگاه را دستی باز کن و دوباره تلاش کن.',
      en: 'A problem occurred while opening or finding the browser tab. Open a store tab manually and retry.',
    },
    TAB_GONE: {
      fa: 'تب بسته شد. دوباره تلاش کن.',
      en: 'The tab was closed. Try again.',
    },
    TAB_TIMEOUT: {
      fa: 'صفحه زیاد طول کشید تا لود شود. اتصال اینترنت را بررسی کن و دوباره تلاش کن.',
      en: 'The page took too long to load. Check your connection and retry.',
    },
    INJECT_FAILED: {
      fa: 'تزریق اسکریپت به صفحه ناموفق بود. صفحه را رفرش کن و دوباره امتحان کن.',
      en: 'Injecting the script failed. Reload the page and try again.',
    },
    NO_SEARCH_INPUT: {
      fa: 'کادر جستجو روی صفحه پیدا نشد. صفحه را رفرش کن یا آدرس جستجو را دستی باز کن.',
      en: 'The search box was not found on the page. Reload it or open the search URL manually.',
    },
    SEARCH_DID_NOT_NAVIGATE: {
      fa: 'جستجو ثبت نشد و صفحهٔ نتایج باز نشد. یک بار دستی جستجو کن تا ببینیم سلکتورها هنوز کار می‌کنند.',
      en: 'The search did not submit and the results page did not open. Try a manual search once to check the selectors still work.',
    },
    NO_BUY_BUTTON: {
      fa: 'دکمهٔ «افزودن به سبد خرید» روی صفحهٔ کالا پیدا نشد. شاید صفحه فرمت جدیدی دارد؛ دستی اضافه کن.',
      en: 'The “add to cart” button was not found on the product page. The page may have a new layout — add it manually.',
    },
    ACTION_FAILED: {
      fa: 'اجرای اکشن روی صفحه ناموفق بود.',
      en: 'Executing the action on the page failed.',
    },
    CONFIRM_EXPIRED: {
      fa: 'زمان تأیید به پایان رسید. اگر هنوز می‌خواهی، دوباره درخواست بده.',
      en: 'The confirmation window expired. Request it again if you still want it.',
    },
    CONTENT_UNREACHABLE: {
      fa: 'نتونستم به صفحهٔ فروشگاه وصل شوم. صفحه را یک بار رفرش کن و دوباره امتحان کن.',
      en: 'Could not reach the store page. Reload the page and try again.',
    },
    NOT_ON_RESULTS_PAGE: {
      fa: 'صفحهٔ نتایج جستجو تشخیص داده نشد. یک بار صفحهٔ فروشگاه را رفرش کن و دوباره امتحان کن.',
      en: 'The search-results page could not be detected. Reload the store page once and try again.',
    },
    NO_SEARCH_PATH: {
      fa: 'برای این فروشگاه مسیر جستجو مشخص نیست. آدرس صفحهٔ جستجو را دستی باز کن.',
      en: 'No search path is known for this store. Open its search page manually.',
    },
    NO_TAB: {
      fa: 'تب فعالی پیدا نشد. یک تب باز کن و دوباره امتحان کن.',
      en: 'No active tab was found. Open a tab and try again.',
    },
    EMPTY_QUERY: {
      fa: 'نتونستم بفهمم دنبال چه کالایی هستی. واضح‌تر بگو، مثلاً «ایرپاد تا ۳ میلیون».',
      en: 'I could not identify a product. Try something like “AirPods under 3M Tomans”.',
    },
    EXTRACT_FAILED: {
      fa: 'خواندن کالاها از صفحه ناموفق بود. صفحه را رفرش کن و دوباره تلاش کن.',
      en: 'Reading products from the page failed. Reload and retry.',
    },

    /* ---- fallback ---- */
    UNKNOWN: {
      fa: 'خطای ناشناخته‌ای رخ داد. اگر تکرار شد، لاگ‌های دیباگ را از تنظیمات روشن کن.',
      en: 'An unknown error occurred. If it repeats, enable debug logs in settings.',
    },
  };

  ShopAgent.errors = { describe, codeOf, TABLE };
})(globalThis);
