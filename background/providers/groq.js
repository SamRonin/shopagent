/**
 * ShopAgent — background/providers/groq.js
 * ------------------------------------------------------------------
 * Groq Cloud client (OpenAI-compatible endpoint, free API key).
 * Uniform interface: complete() + stream() — stream is SSE based.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { makeLineSplitter, parseSseLine } = ShopAgent.sse;
  const log = ShopAgent.utils.logger('groq');

  const META = {
    id: 'groq',
    needsKey: true,
    local: false,
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
  };

  const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

  function toMessages({ messages, prompt, systemPrompt }) {
    if (Array.isArray(messages) && messages.length) return messages;
    const out = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    out.push({ role: 'user', content: String(prompt ?? '') });
    return out;
  }

  function keyOf(settings) {
    return settings?.groq?.apiKey || '';
  }

  function modelOf(settings, override) {
    return override || settings?.groq?.model || META.defaultModel;
  }

  function buildBody(opts, stream) {
    const temperature = opts.temperature ?? opts.settings?.temperature ?? 0.2;
    return {
      model: modelOf(opts.settings, opts.model),
      messages: toMessages(opts),
      temperature: Math.min(1, Math.max(0, temperature)),
      max_tokens: opts.maxTokens || 1600,
      stream,
      ...(opts.json !== false ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  async function complete(opts = {}) {
    const started = Date.now();
    const key = keyOf(opts.settings);
    if (!key) return { ok: false, error: 'NO_KEY', provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: 0 };
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(
        ENDPOINT,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(buildBody(opts, false)),
        },
        opts.timeoutMs || 60000,
        opts.signal
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body?.error?.message || `Groq HTTP ${res.status}`, provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started, status: res.status };
      }
      const data = await res.json();
      return { ok: true, text: data?.choices?.[0]?.message?.content ?? '', provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started };
    }
  }

  /** SSE streaming: lines of `data: {"choices":[{"delta":{"content":"…"}}]}`. */
  async function stream(opts = {}) {
    const started = Date.now();
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : () => {};
    const key = keyOf(opts.settings);
    if (!key) return { ok: false, error: 'NO_KEY', provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: 0 };
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(
        ENDPOINT,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(buildBody(opts, true)),
        },
        opts.timeoutMs || 90000,
        opts.signal
      );
      if (!res.ok || !res.body) {
        const body = res.body ? await res.text().catch(() => '') : 'NO_STREAM_BODY';
        return { ok: false, error: `Groq HTTP ${res.status}: ${body.slice(0, 200)}`, provider: META.id, model: modelOf(opts.settings, opts.model), latencyMs: Date.now() - started, status: res.status };
      }

      const splitter = makeLineSplitter();
      const reader = res.body.getReader();
      let full = '';
      let firstTokenMs = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of splitter.push(value)) {
          const payload = parseSseLine(line);
          if (!payload) continue;
          const tok = payload?.choices?.[0]?.delta?.content;
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

  async function health(settings, signal) {
    const started = Date.now();
    const key = keyOf(settings);
    if (!key) return { ok: false, provider: META.id, latencyMs: 0, models: [], message: 'NO_KEY' };
    try {
      const res = await ShopAgent.providers.fetchWithTimeout('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } }, 6000, signal);
      if (!res.ok) return { ok: false, provider: META.id, latencyMs: Date.now() - started, models: [], message: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, provider: META.id, latencyMs: Date.now() - started, models: (data?.data || []).map((m) => m.id).filter(Boolean), message: 'ok' };
    } catch (err) {
      return { ok: false, provider: META.id, latencyMs: Date.now() - started, models: [], message: String(err?.message || err) };
    }
  }

  ShopAgent.providers.groq = { META, complete, stream, health };
})(globalThis);
