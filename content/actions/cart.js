/**
 * ShopAgent — content/actions/cart.js
 * ------------------------------------------------------------------
 * The add-to-cart action: discovered five ways (see actions/dom.js),
 * risk-assessed through the guardrails, and ONLY executed after the
 * user approves the confirmation card in the side panel.
 * Checkout / address / login targets are hard-blocked and never reach
 * a confirmation prompt.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { sleep, normalizeText } = ShopAgent.utils;
  const dom = ShopAgent.actions.dom;
  const hud = () => ShopAgent.actions.hud;
  const guard = () => ShopAgent.actions.guard;
  const G = ShopAgent.guardrails;

  /** Is this tab actually on a product page? (Not a listing / homepage.) */
  function onProductPage() {
    const cls = ShopAgent.sites.classifyUrl(location.href);
    if (cls.results || cls.home) return false;
    const hasH1 = Boolean(document.querySelector('h1'));
    return G.isProductUrl(location.href) || hasH1;
  }

  /**
   * Find the cart button, retrying while the buy-bar lazy-loads.
   * @returns {Promise<HTMLElement|null>}
   */
  async function locateCartButton(adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    return dom.waitFor(() => dom.findCartButton(ad), { timeout: 8000, interval: 260 });
  }

  /** Best-effort verification that the cart actually changed. */
  async function verifyCartChanged(before) {
    await sleep(1200);
    const sig = cartSignal();
    if (before.count !== null && sig.count !== null && sig.count > before.count) return true;
    if (!before.text && sig.text) return true;
    if (before.text && sig.text && sig.text !== before.text && /(سبد|cart|موجود در)/i.test(sig.text)) return true;
    // Many stores turn the button into «موجود در سبد» / a checkmark.
    const btn = await locateCartButton();
    const btnText = btn ? normalizeText(btn.textContent || '') : '';
    return /موجود در سبد|در سبد شما|added to cart/i.test(btnText);
  }

  /** Cheap cart-state signature: badge counts + button text. */
  function cartSignal() {
    const badge = document.querySelector('[class*="cart" i] [class*="badge" i], [data-testid*="cart-count"], [class*="cart-count"]');
    const count = badge ? Number(normalizeText(toEnglishDigitsSafe(badge.textContent)).replace(/\D/g, '')) || null : null;
    const btn = document.querySelector('[data-testid*="add-to-cart"], button[class*="add-to-cart" i]');
    return { count, text: btn ? normalizeText(btn.textContent || '') : null };
  }

  function toEnglishDigitsSafe(s) {
    return ShopAgent.utils.toEnglishDigits(String(s ?? ''));
  }

  /**
   * The guarded add-to-cart entry point. Returns a structured result the
   * side panel can present verbatim.
   */
  async function addToCart(adapter) {
    const ad = adapter || ShopAgent.adapters.current();
    hud().setStatus('cart');

    if (!onProductPage()) {
      hud().fail('این صفحه، صفحهٔ محصول نیست');
      return { ok: false, reason: 'NOT_PRODUCT_PAGE' };
    }

    const btn = await locateCartButton(ad);
    if (!btn) {
      hud().fail('دکمهٔ افزودن به سبد پیدا نشد');
      return { ok: false, reason: 'CART_BUTTON_NOT_FOUND' };
    }

    // Risk assessment — blocked targets never ask, they just refuse.
    const verdict = guard().assessElement(btn);
    if (verdict.risk === 'blocked') {
      hud().fail('اجرای این کنش ممنوع است');
      return { ok: false, reason: 'BLOCKED_ACTION', detail: verdict.reason, matched: verdict.matched };
    }

    // Human-in-the-Loop: explicit approval in the side panel.
    const approved = await guard().confirmWithUser({
      title: verdict.label || normalizeText(btn.textContent).slice(0, 60) || 'افزودن به سبد',
      detail: verdict.reason || 'این کنش کالا را به سبد خرید اضافه می‌کند و نیاز به تایید تو دارد.',
      risk: verdict.risk || 'confirm',
      url: location.href,
      matched: verdict.matched || '',
    });
    if (!approved) {
      hud().setStatus('stopped', 'تایید نشد');
      return { ok: false, reason: 'DENIED_BY_USER' };
    }

    const before = cartSignal();
    hud().highlight(btn, 'click');
    await sleep(150);
    btn.click();

    const changed = await verifyCartChanged(before);
    if (changed) {
      hud().done('به سبد خرید اضافه شد');
      return { ok: true, reason: 'ADDED', verified: true };
    }
    // Click fired but the store gave no readable feedback — be honest.
    hud().setStatus('ready', 'کلیک انجام شد؛ وضعیت سبد نامشخص');
    return { ok: true, reason: 'CLICKED_UNVERIFIED', verified: false };
  }

  ShopAgent.actions.cart = { addToCart, locateCartButton, onProductPage };
})(globalThis);
