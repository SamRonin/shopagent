/**
 * ShopAgent — content/adapters/index.js
 * ------------------------------------------------------------------
 * Cross-store button discovery — the resilience layer that requirement
 * «پایداری سلکتورها» asks for. Digikala and Basalam ship obfuscated
 * class hashes that change with every build, so buy buttons are found
 * through five ordered tiers, from strongest to weakest evidence:
 *
 *   1. adapter-declared selectors      (data-testid, stable hooks)
 *   2. semantic data-testid / aria     (add-to-cart, سبد خرید)
 *   3. class-name hints                (addToCart, buy-box …)
 *   4. visible button TEXT            («افزودن به سدد خرید», «خرید نقدی»)
 *   5. STRUCTURAL                     (primary-looking button inside a
 *                                      buy box / product-action area)
 *
 * Pure helpers live here so they can be unit-tested without a DOM; the
 * DOM-touching discovery resolves `ShopAgent.actions.dom` lazily, so
 * load order does not matter as long as this file loads before use.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText, toEnglishDigits } = ShopAgent.utils;

  /* ------------------------------------------------------------------ *
   * Tier tables (store-agnostic)
   * ------------------------------------------------------------------ */

  const TESTID_TIER = [
    '[data-testid*="add-to-cart" i]',
    '[data-testid*="addToCart"]',
    '[data-testid*="add-to-basket" i]',
    '[data-testid*="buyButton"]',
  ];

  const ARIA_TIER = [
    'button[aria-label*="سبد خرید"]',
    'button[aria-label*="افزودن به سبد"]',
    'button[aria-label*="add to cart" i]',
    'button[aria-label*="add to basket" i]',
  ];

  const CLASS_TIER = [
    'button[class*="add-to-cart" i]',
    'button[class*="addToCart"]',
    'button[class*="addCart" i]',
    'a[class*="add-to-cart" i]',
    'button[class*="buy-box" i]',
  ];

  /** Containers that hold the product-page buy box. */
  const BUY_BOX_TIER = [
    '[class*="buy-box" i]',
    '[class*="buyBox"]',
    '[class*="product-action" i]',
    '[class*="productAction"]',
    '[class*="purchase" i]',
    'main',
  ];

  /** Button texts that mean «buy» — Persian first, colloquial spellings included. */
  const ADD_TO_CART_LABELS = [
    'افزودن به سبد خرید',
    'افزودن به سبد',
    'اضافه به سبد خرید',
    'اضافه به سبد',
    'خرید نقدی',
    'خرید با افزودن به سبد',
    'add to cart',
    'add to basket',
    'buy now',
  ];

  /** Texts that mean «already in the cart». */
  const IN_CART_LABELS = ['در سبد خرید', 'به سبد اضافه شد', 'مشاهده سبد', 'in your cart', 'in cart', 'view cart'];

  /** Cart-count badge candidates, used to verify a successful add. */
  const CART_COUNT_SELECTORS = [
    '[data-testid*="cart-count" i]',
    '[class*="cart-count" i]',
    '[class*="cartCount"]',
    '[aria-label*="سبد خرید"] span',
    'a[href*="/cart"] span',
  ];

  /* ------------------------------------------------------------------ *
   * Pure helpers (unit-testable)
   * ------------------------------------------------------------------ */

  /** Normalised comparison form of a visible label list. */
  function labelKeys(labels) {
    return (labels || []).map((l) => normalizeText(toEnglishDigits(String(l)))).filter(Boolean);
  }

  /**
   * True when the element's own text is *only* a buy label (or the buy
   * label plus whitespace/digits) — avoids matching a product title
   * that merely contains the phrase.
   */
  function isExactBuyLabel(text, keys) {
    const t = normalizeText(toEnglishDigits(String(text || '')));
    if (!t || t.length > 40) return false;
    return keys.some((k) => t === k);
  }

  /** Read the visible cart-count badge (0 when absent). */
  function readCartCount(doc) {
    for (const sel of CART_COUNT_SELECTORS) {
      let nodes;
      try {
        nodes = doc.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const n of nodes) {
        // No capture group in the regex → the whole match is m[0].
        const m = toEnglishDigits(n.textContent || '').match(/\d{1,4}/);
        if (m) return Number(m[0]);
      }
    }
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * DOM discovery (needs the actions/dom helpers at call time)
   * ------------------------------------------------------------------ */

  function dom() {
    return ShopAgent.actions && ShopAgent.actions.dom;
  }

  /** How «primary» (call-to-action looking) a button is, 0..100. */
  function primaryScore(btn) {
    let score = 0;
    try {
      const style = getComputedStyle(btn);
      const bg = style.backgroundColor || '';
      // A filled (non-transparent) background is the strongest CTA signal.
      if (bg && !/rgba?\([^)]*,\s*0\)/.test(bg) && bg !== 'transparent') score += 45;
      const rect = btn.getBoundingClientRect();
      if (rect.width > 90 && rect.height > 28) score += 20;
      if (btn.querySelector('svg')) score += 10;
      const text = normalizeText(btn.textContent || '');
      if (text.length > 1 && text.length < 40) score += 15;
      if (/disabled/.test(String(btn.className || '')) || btn.disabled) score -= 60;
    } catch {}
    return score;
  }

  /**
   * Tiered buy-button discovery.
   * @param {Document|Element} scope
   * @param {object} adapter  store adapter from shared/sites.js
   * @returns {{el:Element, tier:number, method:string}|null}
   */
  function findBuyButton(scope, adapter) {
    const d = dom();
    if (!d) return null;
    const root = scope || document;

    // Tier 1 — adapter-declared, stable hooks.
    let el = d.queryFirst(adapter?.selectors?.addToCart || [], root);
    if (el) return { el, tier: 1, method: 'adapter-selector' };

    // Tier 2 — semantic data-testid.
    el = d.queryFirst(TESTID_TIER, root);
    if (el) return { el, tier: 2, method: 'data-testid' };

    // Tier 3 — ARIA.
    el = d.queryFirst(ARIA_TIER, root);
    if (el) return { el, tier: 3, method: 'aria-label' };

    // Tier 4 — class-name hints.
    el = d.queryFirst(CLASS_TIER, root);
    if (el) return { el, tier: 4, method: 'class-hint' };

    // Tier 5 — visible button text (adapter labels first, then generic).
    const labels = [...(adapter?.labels?.addToCart || []), ...ADD_TO_CART_LABELS];
    el = d.findByText(labels, root, { tags: 'button,a,span,div' });
    if (el) return { el, tier: 5, method: 'button-text' };

    // Tier 6 — structural: the most CTA-looking button inside a buy box.
    let best = null;
    let bestScore = 0;
    for (const containerSel of BUY_BOX_TIER) {
      let boxes;
      try {
        boxes = root.querySelectorAll(containerSel);
      } catch {
        continue;
      }
      for (const box of boxes) {
        if (!d.isVisible(box)) continue;
        let btns;
        try {
          btns = box.querySelectorAll('button, a[role="button"], a');
        } catch {
          continue;
        }
        for (const btn of btns) {
          if (!d.isVisible(btn)) continue;
          const s = primaryScore(btn);
          if (s > bestScore) {
            bestScore = s;
            best = btn;
          }
        }
      }
      if (best && bestScore >= 65) break;
    }
    if (best) return { el: best, tier: 6, method: 'structural' };

    return null;
  }

  /**
   * Evidence that the item actually reached the cart:
   * an «in cart» label appeared, or the cart-count badge grew.
   */
  function detectInCart(scope, adapter, countBefore) {
    const d = dom();
    if (!d) return { ok: false, reason: 'NO_DOM_HELPERS' };
    const root = scope || document;
    const labels = [...(adapter?.labels?.inCart || []), ...IN_CART_LABELS];
    const hit = d.findByText(labels, root, { tags: 'button,span,div,a,p' });
    const countAfter = readCartCount(root);
    return {
      ok: Boolean(hit) || countAfter > countBefore,
      label: hit ? normalizeText(hit.textContent || '').slice(0, 60) : null,
      countBefore,
      countAfter,
    };
  }

  ShopAgent.adapters = {
    TESTID_TIER,
    ARIA_TIER,
    CLASS_TIER,
    BUY_BOX_TIER,
    ADD_TO_CART_LABELS,
    IN_CART_LABELS,
    CART_COUNT_SELECTORS,
    labelKeys,
    isExactBuyLabel,
    readCartCount,
    findBuyButton,
    detectInCart,
    primaryScore,
  };
})(globalThis);
