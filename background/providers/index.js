/**
 * ShopAgent — background/providers/index.js
 * ------------------------------------------------------------------
 * Provider registry + the single entry points every caller uses:
 *
 *   providers.complete(providerId, settings, opts)  → { ok, text?, error? }
 *   providers.stream(providerId, settings, opts)    → same + onDelta()
 *   providers.health(providerId, settings, signal)  → { ok, models, latencyMs }
 *   providers.meta(providerId)                      → { id, needsKey, … }
 *
 * Adding a new engine = drop one file in this folder and register it
 * below; nothing else in the codebase changes.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  const REGISTRY = {
    ollama: ShopAgent.providers.ollama,
    groq: ShopAgent.providers.groq,
    gemini: ShopAgent.providers.gemini,
  };

  /** Shared fetch with timeout + external signal bridging. */
  function fetchWithTimeout(url, options = {}, timeoutMs = 45000, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), timeoutMs);
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', () => ctrl.abort(externalSignal.reason), { once: true });
    }
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  ShopAgent.providers.fetchWithTimeout = fetchWithTimeout;

  function client(provider) {
    const c = REGISTRY[provider];
    if (!c) throw new Error(`UNKNOWN_PROVIDER:${provider}`);
    return c;
  }

  function meta(provider) {
    return REGISTRY[provider]?.META || null;
  }

  function complete(provider, settings, opts = {}) {
    return client(provider).complete({ ...opts, settings });
  }

  function stream(provider, settings, opts = {}) {
    return client(provider).stream({ ...opts, settings });
  }

  function health(provider, settings, signal) {
    if (provider === 'builtin') {
      return Promise.resolve({ ok: true, provider, latencyMs: 0, models: ['rule-based-fa'], message: 'builtin' });
    }
    return client(provider).health(settings, signal);
  }

  /** testConnection: health probe + a model-missing hint for Ollama. */
  async function testConnection(settings, signal) {
    const provider = settings.provider || 'ollama';
    const result = await health(provider, settings, signal);
    if (result.ok && provider === 'ollama') {
      const configured = settings.ollama?.model;
      const models = result.models || [];
      if (configured && models.length && !models.some((m) => m === configured || m.startsWith(`${configured}:`))) {
        result.message = `MODEL_MISSING:${configured}`;
      }
    }
    return result;
  }

  ShopAgent.providers.complete = complete;
  ShopAgent.providers.stream = stream;
  ShopAgent.providers.health = health;
  ShopAgent.providers.testConnection = testConnection;
  ShopAgent.providers.meta = meta;
  ShopAgent.providers.list = () => Object.keys(REGISTRY);
})(globalThis);
