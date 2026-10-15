/**
 * ShopAgent — background/providers/ollama.js
 * ------------------------------------------------------------------
 * Ollama client (local, offline, zero cost).
 *
 *   complete()  → POST {base}/api/chat            (stream:false)
 *   stream()    → POST {base}/api/chat            (stream:true, NDJSON)
 *   ping()      → GET  {base}/api/tags            (reachability + models)
 *
 * The pure line/response parsers are exported so scripts/selftest.js
 * can verify the wire format without a running Ollama.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const P = ShopAgent.providers;

  const DEFAULT_BASE = 'http://localhost:11434';

  function resolveBase(baseUrl) {
    const raw = String(baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  }

  /** Text of a non-streaming /api/chat response. */
  function extractText(data) {
    return data?.message?.content ?? '';
  }

  /**
   * One NDJSON line of a streaming /api/chat response.
   * @returns {{content:string, done:boolean}|null}
   */
  function parseStreamLine(line) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }
    if (!json || typeof json !== 'object') return null;
    return {
      content: json.message?.content ?? '',
      done: json.done === true,
      error: json.error ? String(json.error) : null,
    };
  }

  function buildBody({ model, messages, json, temperature, keepAlive, stream }) {
    return {
      model: model || 'llama3.2',
      messages,
      stream,
      ...(json ? { format: 'json' } : {}),
      keep_alive: keepAlive || '10m',
      options: { temperature: temperature ?? 0.2, num_ctx: 8192, top_p: 0.9 },
    };
  }

  const provider = {
    id: 'ollama',
    local: true,
    DEFAULT_BASE,
    resolveBase,
    extractText,
    parseStreamLine,

    async complete({ prompt, systemPrompt, messages, model, json = true, temperature, timeoutMs = 60000, signal, baseUrl, keepAlive } = {}) {
      const base = resolveBase(baseUrl);
      const body = buildBody({ model, messages: P.toMessages({ prompt, systemPrompt, messages }), json, temperature, keepAlive, stream: false });
      const started = Date.now();
      try {
        const res = await P.fetchWithTimeout(
          `${base}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          timeoutMs,
          signal
        );
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return { ok: false, error: res.status === 404 ? 'MODEL_MISSING' : `HTTP_${res.status}`, detail: detail.slice(0, 300), model: body.model };
        }
        const data = await res.json();
        return { ok: true, text: extractText(data), model: body.model, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: P.netErrorCode(err), model: body.model, latencyMs: Date.now() - started };
      }
    },

    /** Async generator of text deltas (NDJSON). */
    async *stream({ prompt, systemPrompt, messages, model, json = false, temperature, timeoutMs = 90000, signal, baseUrl, keepAlive } = {}) {
      const base = resolveBase(baseUrl);
      const body = buildBody({ model, messages: P.toMessages({ prompt, systemPrompt, messages }), json, temperature, keepAlive, stream: true });
      let res;
      try {
        res = await P.fetchWithTimeout(
          `${base}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          timeoutMs,
          signal
        );
      } catch (err) {
        throw Object.assign(new Error(P.netErrorCode(err)), { code: P.netErrorCode(err) });
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const code = res.status === 404 ? 'MODEL_MISSING' : `HTTP_${res.status}`;
        throw Object.assign(new Error(code), { code, detail: detail.slice(0, 300) });
      }

      // consumeStream is callback-based; bridge it into a generator with
      // a small queue so deltas flow out as they arrive (low TTFT).
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

    /** Reachability probe used by the side-panel status banner. */
    async ping(baseUrl, { timeoutMs = 4000, signal } = {}) {
      const base = resolveBase(baseUrl);
      const started = Date.now();
      try {
        const res = await P.fetchWithTimeout(`${base}/api/tags`, { method: 'GET' }, timeoutMs, signal);
        if (!res.ok) return { ok: false, online: false, error: `HTTP_${res.status}`, latencyMs: Date.now() - started, models: [] };
        const data = await res.json();
        const models = (data?.models || []).map((m) => m.name || m.model).filter(Boolean);
        return { ok: true, online: true, models, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, online: false, error: P.netErrorCode(err), latencyMs: Date.now() - started, models: [] };
      }
    },
  };

  P.register('ollama', provider);
})(globalThis);
