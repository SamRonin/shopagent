/**
 * ShopAgent — background/providers/sse.js
 * ------------------------------------------------------------------
 * Streaming transport helpers (pure, testable in Node).
 *
 *   • makeLineSplitter() — incremental chunk → line pipeline for both
 *     NDJSON (Ollama) and SSE (Groq / Gemini) formats.
 *   • parseSseLine()     — one "data: {...}" line → parsed payload|null.
 *
 * No fetch logic here: the provider clients own the request; they just
 * feed body chunks into the splitter and get complete lines back.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  /**
   * Incremental decoder that emits complete lines regardless of how the
   * network chunks arrive (works for \n, \r\n and split multi-byte chars).
   * @returns {{push(chunk:string|Uint8Array):string[], flush():string[]}}
   */
  function makeLineSplitter() {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    return {
      push(chunk) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        return lines.filter((l) => l.trim().length);
      },
      flush() {
        // Decode whatever is left in the TextDecoder, then any partial line.
        let rest = '';
        try {
          rest = decoder.decode();
        } catch {}
        const tail = (buffer + rest).trim();
        buffer = '';
        return tail ? [tail] : [];
      },
    };
  }

  /**
   * One SSE line → parsed JSON payload (or null for "[DONE]" sentinels
   * and non-data lines like comments / event names).
   * @param {string} line
   * @returns {*|null}
   */
  function parseSseLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  ShopAgent.sse = { makeLineSplitter, parseSseLine };
})(globalThis);
