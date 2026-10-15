/**
 * ShopAgent — background/providers/groq.js
 * ------------------------------------------------------------------
 * Groq client (OpenAI-compatible, free API key, very fast).
 *
 *   complete()  → POST /openai/v1/chat/completions            (stream:false)
 *   stream()    → POST /openai/v1/chat/completions            (stream:true, SSE)
 *
 * The pure SSE/response parsers are exported for scripts/selftest.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const P = ShopAgent.providers;

  const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
  const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

  /** Text of a non-streaming chat-completions response. */
  function extractText(data) {
    return data?.choices?.[0]?.message?.content ?? '';
  }

  /**
   * One SSE line of a streaming chat-completions response.
   * `data: [DONE]` terminates the stream.
   * @returns {{content:string, done:boolean}|null}
   */
  function parseStreamLine(line) {
    const raw = String(line || '').trim();
    if (!raw.startsWith('data:')) return null;
    const payload = raw.slice(5).trim();
    if (!payload) return null;
    if (payload === '[DONE]') return { content: '', done: true };
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
    const delta = json?.choices?.[0]?.delta?.content;
    const finish = json?.choices?.[0]?.finish_reason;
    return { content: typeof delta === 'string' ? delta : '', done: Boolean(finish), error: json?.error ? String(json.error?.message || json.error) : null };
  }

  function buildBody({ model, messages, json, temperature, stream }) {
    return {
      model: model || DEFAULT_MODEL,
      messages,
      temperature: Math.min(1, Math.max(0, temperature ?? 0.2)),
      max_tokens: 1600,
      stream,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  const provider = {
    id: 'groq',
    local: false,
    DEFAULT_MODEL,
    extractText,
    parseStreamLine,

    async complete({ prompt, systemPrompt, messages, model, json = true, temperature, timeoutMs = 60000, signal, apiKey } = {}) {
      if (!apiKey) return { ok: false, error: 'NO_KEY', model: model || DEFAULT_MODEL };
      const body = buildBody({ model, messages: P.toMessages({ prompt, systemPrompt, messages }), json, temperature, stream: false });
      const started = Date.now();
      try {
        const res = await P.fetchWithTimeout(
          ENDPOINT,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
          },
          timeoutMs,
          signal
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { ok: false, error: `HTTP_${res.status}`, detail: String(data?.error?.message || '').slice(0, 300), model: body.model };
        }
        const data = await res.json();
        return { ok: true, text: extractText(data), model: body.model, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: P.netErrorCode(err), model: body.model, latencyMs: Date.now() - started };
      }
    },

    /** Async generator of text deltas (SSE). */
    async *stream({ prompt, systemPrompt, messages, model, json = false, temperature, timeoutMs = 90000, signal, apiKey } = {}) {
      if (!apiKey) throw Object.assign(new Error('NO_KEY'), { code: 'NO_KEY' });
      const body = buildBody({ model, messages: P.toMessages({ prompt, systemPrompt, messages }), json, temperature, stream: true });
      let res;
      try {
        res = await P.fetchWithTimeout(
          ENDPOINT,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
          },
          timeoutMs,
          signal
        );
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

  P.register('groq', provider);
})(globalThis);
