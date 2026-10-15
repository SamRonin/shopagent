/**
 * ShopAgent — shared/errors.js
 * ------------------------------------------------------------------
 * One place where raw technical failures become clear, actionable
 * Persian messages for the side panel (with an English mirror for the
 * EN UI). Also classifies the *kind* of failure so the UI and the
 * provider banner can react (e.g. flip Ollama to "down").
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  const KINDS = {
    OLLAMA_DOWN: 'ollama_down',
    TIMEOUT: 'timeout',
    NETWORK: 'network',
    CORS: 'cors',
    NO_KEY: 'no_key',
    AUTH: 'auth',
    RATE_LIMIT: 'rate_limit',
    MODEL_MISSING: 'model_missing',
    BAD_JSON: 'bad_json',
    HTTP: 'http',
    ABORTED: 'aborted',
    UNKNOWN: 'unknown',
  };

  const MESSAGES = {
    ollama_down: {
      fa: 'سرویس Ollama روی این دستگاه در دسترس نیست. در ترمینال «ollama serve» را اجرا کن (یا آدرس سرور را در تنظیمات چک کن) و دوباره امتحان کن.',
      en: 'Ollama is not reachable on this machine. Run "ollama serve" in a terminal (or check the server URL in settings) and try again.',
    },
    timeout: {
      fa: 'مدل دیر جواب داد و اتصال قطع شد. اگر مدل لوکال است، یک مدل سبک‌تر (مثل qwen2.5:3b) امتحان کن یا دوباره تلاش کن.',
      en: 'The model took too long to respond. For a local model, try a lighter one (e.g. qwen2.5:3b) or retry.',
    },
    network: {
      fa: 'اتصال اینترنت برقرار نیست یا سرور در دسترس نیست. شبکه را چک کن و دوباره تلاش کن.',
      en: 'No internet connection or the server is unreachable. Check your network and retry.',
    },
    cors: {
      fa: 'درخواست به دلیل محدودیت امنیتی مرورگر (CORS) رد شد. مطمئن شو درخواست از داخل خود اکستنشن ارسال می‌شود.',
      en: 'The request was blocked by browser CORS policy. Make sure it is sent from the extension background.',
    },
    no_key: {
      fa: 'کلید API این سرویس وارد نشده است. از بخش تنظیمات ← هسته هوش مصنوعی کلید رایگان بگیر.',
      en: 'No API key configured. Get a free key via Settings → AI engine.',
    },
    auth: {
      fa: 'کلید API نامعتبر یا منقضی است. یک کلید تازه در تنظیمات وارد کن.',
      en: 'The API key is invalid or expired. Enter a fresh key in settings.',
    },
    rate_limit: {
      fa: 'سقف استفاده رایگان این سرویس موقتاً پر شده. چند دقیقه صبر کن یا مدل لوکال Ollama را انتخاب کن.',
      en: 'Rate limit reached. Wait a few minutes or switch to the local Ollama engine.',
    },
    model_missing: {
      fa: 'مدل انتخابی روی Ollama نصب نیست. در ترمینال بزن: ollama pull <model>',
      en: 'The selected model is not installed. Run: ollama pull <model>',
    },
    bad_json: {
      fa: 'خروجی مدل قابل تفسیر نبود (حتی بعد از تلاش برای اصلاح). یک مدل قوی‌تر انتخاب کن یا به تحلیل‌گر داخلی سوییچ کن.',
      en: 'The model output could not be parsed even after auto-repair. Try a stronger model or the builtin engine.',
    },
    http: {
      fa: 'سرور مدل یک خطا برگرداند. جزئیات در کد زیر آمده است.',
      en: 'The model server returned an error. Details in the code below.',
    },
    aborted: {
      fa: 'عملیات متوقف شد.',
      en: 'Operation stopped.',
    },
    unknown: {
      fa: 'یک خطای غیرمنتظره رخ داد. جزئیات: {detail}',
      en: 'Unexpected error. Details: {detail}',
    },
  };

  /**
   * Classify any thrown error / fetch failure into a KINDS key.
   * @param {*} err
   * @param {{provider?:string, status?:number, body?:string}} [hints]
   */
  function classify(err, hints = {}) {
    const raw = String((err && (err.message || err)) || '');
    const lower = raw.toLowerCase();
    const provider = hints.provider || '';

    if (/aborted|aborterror|stopped/i.test(raw) || err?.name === 'AbortError') return KINDS.ABORTED;
    if (hints.status === 401 || hints.status === 403 || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('api key not valid')) return KINDS.AUTH;
    if (hints.status === 429 || lower.includes('rate limit') || lower.includes('quota') || lower.includes('too many requests')) return KINDS.RATE_LIMIT;
    if (provider === 'ollama' && (lower.includes('failed to fetch') || lower.includes('load failed') || lower.includes('networkerror') || lower.includes('connection refused') || lower.includes('econnrefused'))) return KINDS.OLLAMA_DOWN;
    if (lower.includes('failed to fetch') || lower.includes('load failed') || lower.includes('networkerror') || lower.includes('err_internet') || lower.includes('network')) return KINDS.NETWORK;
    if (lower.includes('cors')) return KINDS.CORS;
    if (lower.includes('timeout') || lower.includes('timed out')) return KINDS.TIMEOUT;
    if (lower.includes('no_key')) return KINDS.NO_KEY;
    if (lower.startsWith('model_missing')) return KINDS.MODEL_MISSING;
    if (lower.includes('bad_json') || lower.includes('unexpected token') || lower.includes('json')) return KINDS.BAD_JSON;
    if (hints.status) return KINDS.HTTP;
    return KINDS.UNKNOWN;
  }

  /**
   * Human message for an error.
   * @param {*} err raw error (its message is kept as the technical code)
   * @param {{lang?:string, provider?:string, status?:number}} [opts]
   * @returns {{kind:string, message:string, code:string}}
   */
  function friendly(err, opts = {}) {
    const lang = opts.lang === 'en' ? 'en' : 'fa';
    const kind = classify(err, opts);
    let tpl = MESSAGES[kind][lang];
    const code = String((err && (err.message || err)) || 'unknown').slice(0, 220);
    if (kind === KINDS.UNKNOWN) tpl = tpl.replace('{detail}', lang === 'fa' ? code : code);
    return { kind, message: tpl, code };
  }

  ShopAgent.errors = { KINDS, MESSAGES, classify, friendly };
})(globalThis);
