/**
 * ShopAgent — content/actions/events.js
 * ------------------------------------------------------------------
 * Low-level DOM event primitives + human-like typing.
 * Real keydown/keypress/input/keyup sequences, per-character jitter and
 * a React/Vue-safe value setter, so automated typing is indistinguishable
 * from a person's.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { sleep, randInt, clamp } = ShopAgent.utils;
  const dom = ShopAgent.actions.dom;
  const hud = () => ShopAgent.actions.hud;

  const TYPING_DELAY = { slow: [70, 190], normal: [35, 95], fast: [12, 34] };

  function keyToCode(key) {
    if (!key) return 'Unidentified';
    if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    const named = { ' ': 'Space', '،': 'Comma', '٫': 'Period', '.': 'Period', ',': 'Comma', '-': 'Minus', '؟': 'Slash', '/': 'Slash' };
    return named[key] || 'Unidentified';
  }

  function fire(el, type, init = {}) {
    try {
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    } catch {}
  }

  function fireKey(el, type, { key = '', code, keyCode = 0, shiftKey = false, ctrlKey = false, altKey = false, metaKey = false } = {}) {
    try {
      const ev = new KeyboardEvent(type, {
        key,
        code: code || keyToCode(key),
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey,
        ctrlKey,
        altKey,
        metaKey,
        view: window,
      });
      // KeyboardEvent.keyCode is read-only in some engines; force it.
      Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
      Object.defineProperty(ev, 'which', { get: () => keyCode });
      el.dispatchEvent(ev);
    } catch {}
  }

  /** The React/Vue-safe way to write into a controlled input. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function scrollIntoViewSmooth(el) {
    return new Promise((resolve) => {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      } catch {
        try {
          el.scrollIntoView();
        } catch {}
      }
      setTimeout(resolve, 420);
    });
  }

  /**
   * Type into an element exactly the way a person would: focus, then one
   * character at a time with keyboard events, input events and jitter.
   */
  async function typeHuman(el, text, { clear = true, speed } = {}) {
    if (!el) throw new Error('NO_ELEMENT');
    const str = String(text ?? '');
    const settings = dom.rt?.settings || {};
    const [minDelay, maxDelay] = TYPING_DELAY[speed || settings.typingSpeed] || TYPING_DELAY.normal;

    await scrollIntoViewSmooth(el);
    hud().setStatus('typing', `«${str}»`);
    hud().highlight(el, 'field');

    el.focus({ preventScroll: true });
    fire(el, 'focus');
    fire(el, 'focusin');
    try {
      el.click();
    } catch {}
    await sleep(randInt(90, 220));

    if (clear && el.value) {
      // Select-all + delete, like a human clearing the box.
      fireKey(el, 'keydown', { key: 'a', keyCode: 65, ctrlKey: true });
      el.setSelectionRange?.(0, el.value.length);
      await sleep(randInt(40, 90));
      fireKey(el, 'keydown', { key: 'Backspace', keyCode: 8 });
      setNativeValue(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      fireKey(el, 'keyup', { key: 'Backspace', keyCode: 8 });
      fire(el, 'change');
      await sleep(randInt(60, 140));
    }

    let typed = 0;
    for (const ch of str) {
      dom.rt?.throwIfAborted();
      const keyCode = ch.charCodeAt(0);
      fireKey(el, 'keydown', { key: ch, keyCode });
      fireKey(el, 'keypress', { key: ch, keyCode });
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: ch, inputType: 'insertText', isComposing: false }));
      fireKey(el, 'keyup', { key: ch, keyCode });
      typed++;
      if (typed % 5 === 0) hud().setProgress(clamp(typed / Math.max(str.length, 1), 0, 1));
      dom.rt?.emit('typing', { typed, total: str.length });
      // Occasional micro-pause, exactly like a person hesitating.
      await sleep(randInt(minDelay, maxDelay) + (Math.random() < 0.07 ? randInt(120, 320) : 0));
    }

    fire(el, 'change');
    fire(el, 'blur');
    hud().setProgress(1);
    return { ok: true, typed };
  }

  async function pressEnter(el) {
    fireKey(el, 'keydown', { key: 'Enter', keyCode: 13 });
    fireKey(el, 'keypress', { key: 'Enter', keyCode: 13 });
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    fireKey(el, 'keyup', { key: 'Enter', keyCode: 13 });
  }

  ShopAgent.actions.events = { fire, fireKey, setNativeValue, scrollIntoViewSmooth, typeHuman, pressEnter, TYPING_DELAY };
})(globalThis);
