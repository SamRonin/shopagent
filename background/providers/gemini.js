/**
 * ShopAgent — background/providers/gemini.js
 * ------------------------------------------------------------------
 * Google Gemini client (free tier).
 *
 *   complete()  → POST :generateContent                    (non-streaming)
 *   stream()    → POST :streamGenerateContent?alt=sse      (SSE)
 *
 * The pure SSE/response parsers are exported for scripts/selftest.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const P = ShopAgent.providers;

  const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
  const DEFAULT_MODEL = 'gemini-2.0-flash';

  /** Concatenated text of a generateContent response. */
  function extractText(data) {
    return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }

  /**
   * One SSE line of a streamGenerateContent response.
   * @returns {{content:string, done:boolean}|null}
   */
  function parseStreamLine(line) {
    const raw = String(line || '').trim();
    if (!raw.startsWith('data:')) return null;
    const payload = raw.slice(5).trim();
    if (!payload || payload === '[DONE]') return payload === '[DONE]' ? { content: '', done: true } : null;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
    if (json?.error) return { content: '', done: true, error: String(json.error.message || json.error) };
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const content = parts.map((p) => p.text || '').join('');
    // A finishReason means this candidate is complete.
    const done = Boolean(json?.candidates?.[0]?.finishReason);
    return { content, done, error: null };
  }

  function buildPayload({ messages, json, temperature, stream }) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    return {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: {
        temperature: Math.min(2, Math.max(0, temperature ?? 0.2)),
        maxOutputTokens: 2048,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    };
  }

  const provider = {
    id: 'gemini',
    local: false,
    DEFAULT_MODEL,
    extractText,
    parseStreamLine,

    async complete({ prompt, systemPrompt, messages, model, json = true, temperature, timeoutMs = 60000, signal, apiKey } = {}) {
      if (!apiKey) return { ok: false, error: 'NO_KEY', model: model || DEFAULT_MODEL };
      const payload = buildPayload({ messages: P.toMessages({ prompt, systemPrompt, messages }), json, temperature, stream: false });
      const url = `${API_ROOT}/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const started = Date.now();
      try {
        const res = await P.fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs, signal);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { ok: false, error: `HTTP_${res.status}`, detail: String(data?.error?.message || '').slice(0, 300), model: model || DEFAULT_MODEL };
        }
        const data = await res.json();
        return { ok: true, text: extractText(data), model: model || DEFAULT_MODEL, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: P.netErrorCode(err), model: model || DEFAULT_MODEL, latencyMs: Date.now() - started };
      }
    },

    /** Async generator of text deltas (SSE). */
    async *stream({ prompt, systemPrompt, messages, model, json = false, temperature, timeoutMs = 90000, signal, apiKey } = {}) {
      if (!apiKey) throw Object.assign(new Error('NO_KEY'), { code: 'NO_KEY' });
      const payload = buildPayload({ messages: P.toMessages({ prompt, systemPrompt, messages }), json, temperature, stream: true });
      const url = `${API_ROOT}/${encodeURIComponent(model || DEFAULT_MODEL)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      let res;
      try {
        res = await P.fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs, signal);
      } catch (err) {
        throw Object.assign(new Error(P.netErrorCode(err)), { code: P.netErrorCode(err) });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(new Error(`HTTP_${res.status}`), { code: `HTTP_${res.status}`, detail: String(data?.error?.message || '').slice(0, 300) });
      }

      const queue = [];
      let wake = null;
      let failure = null;
      let finished = false;
      const flush = () => {
        if (wake) {
          wake();
          wake = null;
        }
      };

      const pump = P.consumeStream(res.body, (line) => {
        const chunk = parseStreamLine(line);
        if (!chunk) return;
        if (chunk.error) {
          failure = Object.assign(new Error('STREAM_ERROR'), { code: 'STREAM_ERROR', detail: chunk.error });
          return;
        }
        if (chunk.content) queue.push(chunk.content);
        if (chunk.done) finished = true;
      })
        .then(() => {
          finished = true;
          flush();
        })
        .catch((err) => {
          failure = err;
          finished = true;
          flush();
        });

      for (;;) {
        while (queue.length) yield queue.shift();
        if (failure) throw failure;
        if (finished) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        if (failure && !queue.length) throw failure;
      }
    },
  };

  P.register('gemini', provider);
})(globalThis);
