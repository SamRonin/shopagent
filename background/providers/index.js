/**
 * ShopAgent — background/providers/index.js
 * ------------------------------------------------------------------
 * Provider registry + shared transport. Every model backend
 * (ollama.js, groq.js, gemini.js) registers itself here with the SAME
 * interface:
 *
 *   complete({ prompt, systemPrompt, messages, model, json,
 *              temperature, timeoutMs, signal, ...providerOpts })
 *     → { ok, text, model, latencyMs } | { ok:false, error:<CODE> }
 *
 *   stream({ ...same }) → async generator yielding text deltas
 *
 *   ping?(...) → cheap reachability probe (ollama only)
 *
 * `error` is always a stable CODE (see shared/errors.js); turning it
 * into Persian/English guidance is the job of that module, so this
 * layer stays transport-only.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  const registry = {};

  function register(id, mod) {
    if (id && mod && typeof mod.complete === 'function') registry[id] = mod;
  }

  function get(id) {
    return registry[id] || null;
  }

  function list() {
    return Object.keys(registry);
  }

  /** Normalise `{prompt, systemPrompt}` into an OpenAI-style message list. */
  function toMessages({ prompt, systemPrompt, messages } = {}) {
    if (Array.isArray(messages) && messages.length) return messages;
    const out = [];
    if (systemPrompt) out.push({ role: 'system', content: String(systemPrompt) });
    if (prompt !== undefined && prompt !== null && String(prompt).length) out.push({ role: 'user', content: String(prompt) });
    return out;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 45000, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), timeoutMs);
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort(externalSignal.reason || new Error('ABORTED'));
      else externalSignal.addEventListener('abort', () => ctrl.abort(externalSignal.reason || new Error('ABORTED')), { once: true });
    }
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a streaming response body line by line (works for NDJSON and
   * SSE alike — the caller strips the `data:` prefix). Exposed as a
   * standalone function so it can be unit-tested with a fake stream.
   */
  async function consumeStream(body, onLine) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line.trim()) onLine(line);
        }
      }
      const tail = buf.replace(/\r$/, '');
      if (tail.trim()) onLine(tail);
    } finally {
      reader.releaseLock?.();
    }
  }

  /** Map a thrown fetch error onto a stable CODE. */
  function netErrorCode(err) {
    if (!err) return 'UNKNOWN';
    const msg = String(err?.message || err);
    if (err.name === 'AbortError' || /aborted/i.test(msg)) return msg === 'TIMEOUT' ? 'TIMEOUT' : 'ABORTED';
    if (/timed? ?out/i.test(msg)) return 'TIMEOUT';
    if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) return 'NETWORK';
    return 'UNKNOWN';
  }

  ShopAgent.providers = {
    register,
    get,
    list,
    toMessages,
    fetchWithTimeout,
    consumeStream,
    netErrorCode,
  };
})(globalThis);
