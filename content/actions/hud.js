/**
 * ShopAgent — content/actions/hud.js
 * ------------------------------------------------------------------
 * The "see it happen" layer: a small status card, an animated ring
 * around the element currently being acted on, a soft ghost cursor and
 * toasts. Purely presentational — disabling it (settings → HUD) removes
 * every node and makes all methods no-ops.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { clamp } = ShopAgent.utils;

  const STATUS_FA = {
    idle: 'آماده',
    typing: 'در حال تایپ',
    scrolling: 'در حال اسکرول',
    analyzing: 'در حال تحلیل صفحه',
    filtering: 'در حال اعمال فیلتر',
    navigating: 'در حال جابه‌جایی',
    thinking: 'در حال تفکر',
    ranking: 'در حال رتبه‌بندی',
    ready: 'انجام شد',
    error: 'خطا',
    stopped: 'متوقف شد',
  };

  let enabled = true;

  const hud = {
    root: null,
    statusEl: null,
    detailEl: null,
    barEl: null,
    ring: null,
    cursor: null,

    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) this.destroy();
    },

    destroy() {
      this.root?.remove();
      this.root = null;
      this.ring?.remove();
      this.ring = null;
      this.cursor?.remove();
      this.cursor = null;
    },

    ensure() {
      if (!enabled) return null;
      if (this.root && document.body.contains(this.root)) return this.root;

      const root = document.createElement('div');
      root.id = 'shopagent-hud';
      root.setAttribute('dir', 'rtl');
      root.innerHTML = `
        <div class="sa-hud-card">
          <div class="sa-hud-head">
            <span class="sa-hud-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 4h10l1.2 2.6a1 1 0 0 1-.9 1.4H6.7a1 1 0 0 1-.9-1.4L7 4Zm-2 6h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/></svg>
            </span>
            <span class="sa-hud-title">خرید‌یار هوشمند</span>
            <button class="sa-hud-close" type="button" aria-label="بستن">&times;</button>
          </div>
          <div class="sa-hud-body">
            <span class="sa-hud-dot"></span>
            <span class="sa-hud-status">آماده</span>
            <span class="sa-hud-detail"></span>
          </div>
          <div class="sa-hud-track"><div class="sa-hud-bar"></div></div>
        </div>`;
      document.documentElement.appendChild(root);

      this.root = root;
      this.statusEl = root.querySelector('.sa-hud-status');
      this.detailEl = root.querySelector('.sa-hud-detail');
      this.barEl = root.querySelector('.sa-hud-bar');
      root.querySelector('.sa-hud-close').addEventListener('click', () => {
        root.classList.add('sa-hidden');
        enabled = false;
        ShopAgent.actions.onHudHidden?.();
      });
      root.classList.remove('sa-hidden');
      return root;
    },

    setStatus(status, detail) {
      if (!enabled) return;
      const root = this.ensure();
      if (!root) return;
      root.classList.remove('sa-hidden');
      root.dataset.status = status;
      if (this.statusEl) this.statusEl.textContent = STATUS_FA[status] || status;
      if (this.detailEl) this.detailEl.textContent = detail || '';
      if (!['typing', 'scrolling', 'filtering', 'analyzing'].includes(status)) this.setProgress(null);
    },

    setProgress(p) {
      if (!this.barEl) return;
      if (p === null || p === undefined) this.barEl.style.width = '0%';
      else this.barEl.style.width = `${clamp(p, 0, 1) * 100}%`;
    },

    done(message) {
      this.setStatus('ready', message || '');
      setTimeout(() => this.setProgress(null), 800);
    },

    fail(message) {
      this.setStatus('error', message || '');
      setTimeout(() => this.setStatus('idle', ''), 6000);
    },

    /** Animated ring around the element currently being acted on. */
    highlight(el, kind = 'field', ms = 2600) {
      if (!el || !enabled) return;
      try {
        const existing = document.getElementById('shopagent-ring');
        if (existing) existing.remove();
        const rect = el.getBoundingClientRect();
        const ring = document.createElement('div');
        ring.id = 'shopagent-ring';
        ring.className = `sa-ring sa-ring-${kind}`;
        ring.style.top = `${rect.top + window.scrollY - 4}px`;
        ring.style.left = `${rect.left + window.scrollX - 4}px`;
        ring.style.width = `${rect.width + 8}px`;
        ring.style.height = `${rect.height + 8}px`;
        document.documentElement.appendChild(ring);
        this.ring = ring;
        this.moveCursorTo(rect);
        clearTimeout(ring._t);
        ring._t = setTimeout(() => ring.remove(), ms);
      } catch {}
    },

    /** A soft "ghost cursor" that travels to the target, like a real user. */
    moveCursorTo(rect) {
      if (!enabled) return;
      try {
        if (!this.cursor) {
          const c = document.createElement('div');
          c.id = 'shopagent-cursor';
          c.className = 'sa-cursor';
          c.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M5 2.5 19 12l-6.4 1.6L9.8 20 5 2.5Z"/></svg>';
          document.documentElement.appendChild(c);
          this.cursor = c;
        }
        const x = rect.left + window.scrollX + Math.min(rect.width * 0.75, rect.width - 14);
        const y = rect.top + window.scrollY + Math.min(rect.height * 0.6, rect.height - 10);
        this.cursor.style.transform = `translate(${x}px, ${y}px)`;
        this.cursor.classList.add('sa-cursor-active');
      } catch {}
    },

    toast(text, ms = 2200) {
      if (!enabled) return;
      try {
        const t = document.createElement('div');
        t.className = 'sa-toast';
        t.textContent = text;
        t.setAttribute('dir', 'rtl');
        document.documentElement.appendChild(t);
        requestAnimationFrame(() => t.classList.add('sa-toast-in'));
        setTimeout(() => {
          t.classList.remove('sa-toast-in');
          setTimeout(() => t.remove(), 320);
        }, ms);
      } catch {}
    },
  };

  ShopAgent.actions = ShopAgent.actions || {};
  ShopAgent.actions.hud = hud;
})(globalThis);
