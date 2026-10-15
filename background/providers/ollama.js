/**
 * ShopAgent — background/providers/ollama.js
 * ------------------------------------------------------------------
 * Client for a local Ollama server (default http://localhost:11434).
 *
 * Uniform provider interface:
 *   complete({ messages | prompt+systemPrompt, model, json, temperature,
 *              timeoutMs, signal, settings }) → { ok, text?, error?, ... }
 *   stream({ ..., onDelta })                      → same result shape,
 *              calling onDelta(deltaText) as NDJSON tokens arrive.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { makeLineSplitter } = ShopAgent.sse;
  const log = ShopAgent.utils.logger('ollama');

  const META = {
    id: 'ollama',
    needsKey: false,
    local: true,
    keyUrl: null,
    defaultModel: 'llama3.2',
    suggestedModels: ['llama3.2', 'llama3.1:8b', 'qwen2.5:7b', 'qwen2.5:3b', 'mistral', 'gemma2:9b', 'phi3'],
    install: 'ollama pull llama3.2',
  };

  /** Normalised base URL without trailing slashes. */
  function baseUrl(settings) {
    const raw = (settings?.ollama?.baseUrl || 'http://localhost:11434').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  }

  function modelOf(settings, override) {
    return override || settings?.ollama?.model || META.defaultModel;
  }

  /** {prompt, systemPrompt} sugar → messages array (uniform interface). */
  function toMessages({ messages, prompt, systemPrompt }) {
    if (Array.isArray(messages) && messages.length) return messages;
    const out = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    out.push({ role: 'user', content: String(prompt ?? '') });
    return out;
  }

  function buildBody(opts, stream) {
    const messages = toMessages(opts);
    const temperature = opts.temperature ?? opts.settings?.temperature ?? 0.2;
    return {
      model: modelOf(opts.settings, opts.model),
      messages,
      stream,
      ...(opts.json !== false ? { format: 'json' } : {}),
      keep_alive: opts.settings?.ollama?.keepAlive || '10m',
      options: { temperature, num_ctx: 8192, top_p: 0.9 },
    };
  }

  async function complete(opts = {}) {
    const base = baseUrl(opts.settings);
    const started = Date.now();
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(
        `${base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(opts, false)),
        },
        opts.timeoutMs || 60000,
        opts.signal
      );
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        return { ok: false, error: `Ollama HTTP ${res.status}: ${body}`, provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started, status: res.status };
      }
      const data = await res.json();
      return { ok: true, text: data?.message?.content ?? '', provider: META.id, model: data?.model || modelOf(opts.settings, opts.model), latencyMs: Date.now() - started };
    } catch (err) {
      const aborted = ShopAgent.errors.classify(err, { provider: META.id }) === ShopAgent.errors.KINDS.ABORTED;
      return { ok: false, error: aborted ? 'TIMEOUT' : String(err?.message || err), provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started };
    }
  }

  /**
   * Streaming chat. Ollama emits NDJSON lines:
   *   {"message":{"content":"tok"},"done":false} … {"done":true}
   */
  async function stream(opts = {}) {
    const base = baseUrl(opts.settings);
    const started = Date.now();
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : () => {};
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(
        `${base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(opts, true)),
        },
        opts.timeoutMs || 90000,
        opts.signal
      );
      if (!res.ok || !res.body) {
        const body = res.body ? (await res.text().catch(() => '')).slice(0, 200) : 'NO_STREAM_BODY';
        return { ok: false, error: `Ollama HTTP ${res.status}: ${body}`, provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started, status: res.status };
      }

      const splitter = makeLineSplitter();
      const reader = res.body.getReader();
      let full = '';
      let firstTokenMs = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of splitter.push(value)) {
          let payload;
          try {
            payload = JSON.parse(line);
          } catch {
            continue;
          }
          const tok = payload?.message?.content;
          if (typeof tok === 'string' && tok.length) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            full += tok;
            onDelta(tok, { full, firstTokenMs });
          }
        }
      }
      return { ok: true, text: full, provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started, firstTokenMs };
    } catch (err) {
      log.warn('stream failed', err?.message || err);
      return { ok: false, error: String(err?.message || err), provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started };
    }
  }

  /** Cheap health probe: list installed models. */
  async function health(settings, signal) {
    const started = Date.now();
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(`${baseUrl(settings)}/api/tags`, { method: 'GET' }, 3500, signal);
      if (!res.ok) return { ok: false, provider: META.id, latencyMs: Date.now() - started, models: [], message: `HTTP ${res.status}` };
      const data = await res.json();
      const models = (data?.models || []).map((m) => m.name || m.model).filter(Boolean);
      return { ok: true, provider: META.id, latencyMs: Date.now() - started, models, message: 'ok' };
    } catch (err) {
      return { ok: false, provider: META.id, latencyMs: Date.now() - started, models: [], message: String(err?.message || err) };
    }
  }

  ShopAgent.providers.ollama = { META, baseUrl, complete, stream, health };
})(globalThis);
