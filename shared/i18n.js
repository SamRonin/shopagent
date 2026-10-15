/**
 * ShopAgent — shared/i18n.js
 * ------------------------------------------------------------------
 * Runtime translation layer. Works in every extension context and falls
 * back to `chrome.i18n.getMessage` for manifest-level strings.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { normalizeText } = ShopAgent.utils;

  const DEFAULT_LANG = 'fa';
  let currentLang = DEFAULT_LANG;

  const hasChromeI18n = typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage;

  /** Best-effort detection of the browser UI language. */
  function detectLang() {
    if (hasChromeI18n) {
      const ui = String(chrome.i18n.getUILanguage() || '').toLowerCase();
      if (ui.startsWith('fa') || ui.startsWith('en')) return ui.startsWith('fa') ? 'fa' : 'en';
    }
    const nav = (typeof navigator !== 'undefined' && navigator.language) || '';
    return nav.toLowerCase().startsWith('fa') ? 'fa' : 'en';
  }

  function dict(lang) {
    return (ShopAgent.LOCALES && ShopAgent.LOCALES[lang]) || ShopAgent.LOCALES[DEFAULT_LANG] || {};
  }

  /**
   * Translate a key.
   * @param {string} key
   * @param {Record<string,string|number>} [vars] `{n}` style placeholders
   */
  function t(key, vars) {
    let str = dict(currentLang)[key];
    if (str === undefined) str = dict(DEFAULT_LANG)[key];
    if (str === undefined && hasChromeI18n) {
      const fromChrome = chrome.i18n.getMessage(key.replace(/\./g, '_'));
      if (fromChrome) str = fromChrome;
    }
    if (str === undefined) str = key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  }

  function setLang(lang) {
    const code = String(lang || DEFAULT_LANG).toLowerCase();
    currentLang = code.startsWith('en') ? 'en' : 'fa';
    if (typeof document !== 'undefined' && document.documentElement) apply(document);
    return currentLang;
  }

  function getLang() {
    return currentLang;
  }

  function getDir() {
    return currentLang === 'fa' ? 'rtl' : 'ltr';
  }

  /**
   * Walk the DOM and apply translations to any node carrying a
   * `data-i18n`, `data-i18n-placeholder`, `data-i18n-title` or
   * `data-i18n-aria` attribute.
   */
  function apply(rootEl) {
    const doc = rootEl && rootEl.ownerDocument ? rootEl.ownerDocument : typeof document !== 'undefined' ? document : null;
    if (!doc) return;

    doc.documentElement.lang = currentLang;
    doc.documentElement.dir = getDir();

    const scope = rootEl || doc;
    const targets = [scope];
    if (scope.querySelectorAll) targets.push(...scope.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria]'));

    for (const el of targets) {
      if (!el || !el.getAttribute) continue;
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
      const ph = el.getAttribute('data-i18n-placeholder');
      if (ph) el.setAttribute('placeholder', t(ph));
      const ti = el.getAttribute('data-i18n-title');
      if (ti) el.setAttribute('title', t(ti));
      const aria = el.getAttribute('data-i18n-aria');
      if (aria) el.setAttribute('aria-label', t(aria));
    }
  }

  ShopAgent.i18n = {
    t,
    setLang,
    getLang,
    getDir,
    apply,
    detectLang,
    DEFAULT_LANG,
  };
})(globalThis);
