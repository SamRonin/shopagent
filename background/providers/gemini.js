/**
 * ShopAgent — background/providers/gemini.js
 * ------------------------------------------------------------------
 * Google Gemini client (free tier, generateContent API).
 * Uniform interface: complete() + stream() — stream uses ?alt=sse.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { makeLineSplitter, parseSseLine } = ShopAgent.sse;
  const log = ShopAgent.utils.logger('gemini');

  const META = {
    id: 'gemini',
    needsKey: true,
    local: false,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.0-flash',
    suggestedModels: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'],
  };

  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  function keyOf(settings) {
    return settings?.gemini?.apiKey || '';
  }

  function modelOf(settings, override) {
    return override || settings?.gemini?.model || META.defaultModel;
  }

  /** OpenAI-ish messages → Gemini systemInstruction + contents. */
  function toGeminiShape({ messages, prompt, systemPrompt }) {
    let msgs = Array.isArray(messages) && messages.length ? messages : [];
    if (!msgs.length) {
      msgs = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: String(prompt ?? '') });
    }
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = msgs
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    return { system, contents };
  }

  function buildBody(opts) {
    const { system, contents } = toGeminiShape(opts);
    const temperature = opts.temperature ?? opts.settings?.temperature ?? 0.2;
    return {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        temperature: Math.min(2, Math.max(0, temperature)),
        maxOutputTokens: opts.maxTokens || 2048,
        ...(opts.json !== false ? { responseMimeType: 'application/json' } : {}),
      },
    };
  }

  function url(settings, model, stream) {
    const method = stream ? 'streamGenerateContent?alt=sse&key=' : 'generateContent?key=';
    return `${BASE}/${encodeURIComponent(model)}:${method}${encodeURIComponent(keyOf(settings))}`;
  }

  async function complete(opts = {}) {
    const started = Date.now();
    const model = modelOf(opts.settings, opts.model);
    if (!keyOf(opts.settings)) return { ok: false, error: 'NO_KEY', provider: META.id, model, latencyMs: 0 };
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(
        url(opts.settings, model, false),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(opts)) },
        opts.timeoutMs || 60000,
        opts.signal
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body?.error?.message || `Gemini HTTP ${res.status}`, provider: META.id, model, latencyMs: Date.now() - started, status: res.status };
      }
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      return { ok: true, text, provider: META.id, model, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), provider: META.id, model, latencyMs: Date.now() - started };
    }
  }

  /** SSE streaming: each event carries one full candidate chunk. */
  async function stream(opts = {}) {
    const started = Date.now();
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : () => {};
    const model = modelOf(opts.settings, opts.model);
    if (!keyOf(opts.settings)) return { ok: false, error: 'NO_KEY', provider: META.id, model, latencyMs: 0 };
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(
        url(opts.settings, model, true),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(opts)) },
        opts.timeoutMs || 90000,
        opts.signal
      );
      if (!res.ok || !res.body) {
        const body = res.body ? await res.text().catch(() => '') : 'NO_STREAM_BODY';
        return { ok: false, error: `Gemini HTTP ${res.status}: ${body.slice(0, 200)}`, provider: META.id, model, latencyMs: Date.now() - started, status: res.status };
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
          const tok = (payload?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          if (tok.length) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            full += tok;
            onDelta(tok, { full, firstTokenMs });
          }
        }
      }
      return { ok: true, text: full, provider: META.id, model, latencyMs: Date.now() - started, firstTokenMs };
    } catch (err) {
      log.warn('stream failed', err?.message || err);
      return { ok: false, error: String(err?.message || err), provider: META.id, model, latencyMs: Date.now() - started };
    }
  }

  async function health(settings, signal) {
    const started = Date.now();
    const key = keyOf(settings);
    if (!key) return { ok: false, provider: META.id, latencyMs: 0, models: [], message: 'NO_KEY' };
    try {
      const res = await ShopAgent.providers.fetchWithTimeout(`${BASE}?key=${encodeURIComponent(key)}&pageSize=100`, {}, 6000, signal);
      if (!res.ok) return { ok: false, provider: META.id, latencyMs: Date.now() - started, models: [], message: `HTTP ${res.status}` };
      const data = await res.json();
      const models = (data?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''));
      return { ok: true, provider: META.id, latencyMs: Date.now() - started, models, message: 'ok' };
    } catch (err) {
      return { ok: false, provider: META.id, latencyMs: Date.now() - started, models: [], message: String(err?.message || err) };
    }
  }

  ShopAgent.providers.gemini = { META, complete, stream, health };
})(globalThis);
