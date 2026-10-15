/**
 * ShopAgent — content/actions/guard.js
 * ------------------------------------------------------------------
 * The content-side of the Human-in-the-Loop pipeline.
 *
 *   assessElement(el)  → { risk, reason, label, matched }   (pure check)
 *   confirmWithUser(…) → Promise<boolean>                    (panel round-trip)
 *
 * Risk rules themselves are shared (shared/guardrails.js) so the side
 * panel and the content script always agree on what is dangerous.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText } = ShopAgent.utils;
  const G = ShopAgent.guardrails;
  const log = ShopAgent.utils.logger('guard');

  /**
   * Build the classification input for a live element and run the shared
   * risk table on it.
   */
  function assessElement(el) {
    if (!el) return { risk: 'safe', reason: '' };
    const anchor = el.closest('a,button,[role="button"],label,li') || el;
    const verdict = G.assessTarget({
      text: el.textContent || anchor.textContent || '',
      ariaLabel: el.getAttribute('aria-label') || anchor.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || anchor.getAttribute('title') || '',
      testId: el.getAttribute('data-testid') || anchor.getAttribute('data-testid') || '',
      href: anchor.getAttribute('href') || '',
      tag: anchor.tagName,
    });
    // Attach a human label for the confirmation card.
    const label = normalizeText(el.textContent || el.getAttribute('aria-label') || '').slice(0, 60);
    return { ...verdict, label };
  }

  /**
   * Ask the user through the side panel. Resolves false on denial,
   * timeout (90 s, handled in the worker) or if no panel is listening —
   * an unanswered confirmation is ALWAYS a "no".
   * @returns {Promise<boolean>}
   */
  function confirmWithUser({ title, detail, risk = 'confirm', url = '', matched = '' } = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'SHOPAGENT_CONFIRM_REQUEST',
            requestId: `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            title,
            detail,
            risk,
            url,
            matched,
          },
          (res) => {
            const err = chrome.runtime.lastError;
            if (err) {
              log.warn('confirm round-trip failed:', err.message);
              return resolve(false);
            }
            resolve(Boolean(res && res.approved));
          }
        );
      } catch (e) {
        log.warn('confirm send failed', e);
        resolve(false);
      }
    });
  }

  ShopAgent.actions.guard = { assessElement, confirmWithUser };
})(globalThis);
