/**
 * ShopAgent — shared/guardrails.js
 * ------------------------------------------------------------------
 * The safety layer between "what a model (or a rule) wants to click"
 * and "what may actually be clicked on a store page".
 *
 * Three risk levels:
 *   'blocked'  — never executed, no confirmation possible
 *                (checkout / payment / address / login / OTP / bank cards)
 *   'confirm'  — executed only after an explicit Human-in-the-Loop
 *                approval card in the side panel (cart, buy-now, deletes)
 *   'safe'     — navigation, search, sort/filter, tabs…
 *
 * Pure + stateless: the same table drives content-script click guarding
 * and the side panel's explanation texts.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  /** Hard block — these must never be automated. Normalised (lowercase). */
  const BLOCKED_PATTERNS = [
    'پرداخت', 'پرداخت نهایی', 'ثبت سفارش', 'ثبت نهایی', 'نهایی کردن سفارش', 'تایید سفارش', 'تأیید سفارش',
    'سفارش و پرداخت', 'تکمیل خرید', 'تکمیل سفارش', 'مرحله پرداخت', 'درگاه پرداخت',
    'شماره کارت', 'کد تایید', 'کد تأیید', 'رمز دوم', 'رمز پویا', 'otp', 'cvv', 'cvv2',
    'تغییر آدرس', 'ثبت آدرس', 'ویرایش آدرس', 'حذف آدرس', 'افزودن آدرس',
    'ورود به حساب', 'ثبت‌نام', 'ثبت نام', 'بازیابی رمز', 'تغییر رمز',
    'checkout', 'place order', 'placeOrder', 'payment', 'pay now', 'billing',
    'login', 'sign in', 'signin', 'sign up', 'signup', 'password',
  ];

  /** Explicit user confirmation required (in the side panel). */
  const CONFIRM_PATTERNS = [
    'افزودن به سبد', 'اضافه کردن به سبد', 'به سبد خرید', 'خرید نقدی', 'خرید فوری',
    'ثبت', 'حذف', 'لغو', 'پرداخت در محل', 'نهایی',
    'add to cart', 'add-to-cart', 'addtocart', 'buy now', 'delete', 'remove',
  ];

  /** URL paths that are dangerous regardless of the clicked element. */
  const BLOCKED_URL_RE = /\/(checkout|payment|payments|order|orders|invoice|login|signin|signup|register|address|addresses|account)(\/|$)/i;

  function normalize(s) {
    return String(s || '')
      .replace(/[\u200C\u200D]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Classify a prospective click target.
   * @param {{text?:string, ariaLabel?:string, title?:string, testId?:string, href?:string, tag?:string}} target
   * @returns {{risk:'blocked'|'confirm'|'safe', reason:string, matched?:string}}
   */
  function assessTarget(target = {}) {
    const haystacks = [target.text, target.ariaLabel, target.title, target.testId]
      .map(normalize)
      .filter(Boolean);
    const href = normalize(target.href);

    // 1. Destination URL is authoritative when present.
    if (href && BLOCKED_URL_RE.test(href)) {
      return { risk: 'blocked', reason: 'این مسیر به صفحه پرداخت/حساب کاربری می‌رود و به‌صورت خودکار اجرا نمی‌شود.', matched: href };
    }

    // 2. Text evidence — blocked phrases win over everything.
    for (const p of BLOCKED_PATTERNS) {
      const np = normalize(p);
      for (const h of haystacks) {
        if (h.includes(np)) {
          return { risk: 'blocked', reason: 'اجرای خودکار این دکمه ممنوع است (پرداخت/آدرس/حساب کاربری).', matched: p };
        }
      }
    }

    // 3. Confirmation-required actions.
    for (const p of CONFIRM_PATTERNS) {
      const np = normalize(p);
      for (const h of haystacks) {
        if (h === np || (np.length >= 3 && h.includes(np))) {
          return { risk: 'confirm', reason: 'این کنش روی سبد خرید/داده‌ها اثر می‌گذارد و نیاز به تایید تو دارد.', matched: p };
        }
      }
    }

    return { risk: 'safe', reason: '' };
  }

  /**
   * Risk of merely *visiting* a URL (used before tab navigation).
   * @param {string} url
   */
  function assessUrl(url) {
    if (!url || BLOCKED_URL_RE.test(String(url))) {
      return { risk: 'blocked', reason: 'رفتن خودکار به صفحات پرداخت/حساب کاربری مجاز نیست.', matched: url };
    }
    return { risk: 'safe', reason: '' };
  }

  /**
   * Is this a product page (i.e. a legitimate place to add to cart)?
   * Cheap URL heuristic shared by background + content.
   */
  function isProductUrl(url) {
    return /\/(product|item|p|dp|goods|dkp)[\/\-]/i.test(String(url || ''));
  }

  ShopAgent.guardrails = { BLOCKED_PATTERNS, CONFIRM_PATTERNS, BLOCKED_URL_RE, assessTarget, assessUrl, isProductUrl };
})(globalThis);
