/**
 * ShopAgent — content/actions/scroll.js
 * ------------------------------------------------------------------
 * Soft, eased scrolling that keeps going while the document grows, so
 * infinite-scroll / lazy-image grids fully materialise before extraction.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { sleep, randInt, clamp } = ShopAgent.utils;
  const hud = () => ShopAgent.actions.hud;
  const dom = ShopAgent.actions.dom;

  /** One eased scroll step via requestAnimationFrame. */
  function easedScrollTo(from, to, duration) {
    return new Promise((resolve) => {
      const started = performance.now();
      function frame(now) {
        const p = clamp((now - started) / duration, 0, 1);
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
        window.scrollTo(0, from + (to - from) * eased);
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  async function softScroll({ rounds = 4, stepRatio = 0.85, settleMs = 550, maxIdleRounds = 3 } = {}) {
    hud().setStatus('scrolling');
    let lastHeight = document.documentElement.scrollHeight;
    let idle = 0;
    let totalScrolled = 0;
    const rt = dom.rt;

    for (let r = 0; r < rounds; r++) {
      rt?.throwIfAborted();
      const step = Math.max(300, window.innerHeight * stepRatio);
      const target = window.scrollY + step;
      const from = window.scrollY;
      await easedScrollTo(from, target, randInt(420, 780));

      totalScrolled += step;
      hud().setProgress(clamp((r + 1) / rounds, 0, 1));
      // Nudge the lazy loaders by firing the events they listen for.
      window.dispatchEvent(new Event('scroll'));
      await sleep(settleMs + randInt(0, 250));

      const newHeight = document.documentElement.scrollHeight;
      if (newHeight > lastHeight + 40) {
        lastHeight = newHeight;
        idle = 0;
      } else {
        idle++;
      }
      rt?.emit('scrolling', { round: r + 1, rounds, height: newHeight, loaded: dom.findProductCards(null, 500).length });
      if (idle >= maxIdleRounds) break;
    }

    // Scroll back up gently so the first results are in view for the user.
    const backFrom = window.scrollY;
    await new Promise((resolve) => {
      const started = performance.now();
      function frame(now) {
        const p = clamp((now - started) / 900, 0, 1);
        window.scrollTo(0, backFrom * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });

    return { ok: true, scrolled: Math.round(totalScrolled), height: document.documentElement.scrollHeight, cards: dom.findProductCards(null, 500).length };
  }

  ShopAgent.actions.scroll = { softScroll, easedScrollTo };
})(globalThis);
