/* Web Worker message loop around one UVEngine. Pure JS: this factory is
 * evaluated inside the Blob-URL worker built by src/client/engine-client.js.
 *
 * Protocol (ARCHITECTURE.md §4.12; generic so new engine methods need no changes):
 *   main -> worker : { id, op, args }              op = any public engine method,
 *                                                  or '__ping' | '__methods'
 *   Engine calls are synchronous inside the worker, so cancellation terminates
 *   the worker (EngineClient.cancel). Methods starting with '_' are private.
 *   worker -> main : { type: 'ready', methods }
 *                    { id, type: 'progress', stage, done, total }   (<= 1 per 33 ms per stage)
 *                    { id, type: 'result', result }                 (typed arrays transferred)
 *                    { id, type: 'error', message, stack }
 */
UVCore.define('worker-main', function (C) {
  'use strict';

  function publicMethods(obj) {
    const names = new Set();
    for (let p = obj; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === 'constructor' || k.charAt(0) === '_') continue;
        if (typeof obj[k] === 'function') names.add(k);
      }
    }
    return Array.from(names).sort();
  }

  /* Every distinct ArrayBuffer referenced by typed arrays inside `value`. */
  function collectTransfers(value) {
    const out = [], seen = new Set();
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 6) return;
      if (ArrayBuffer.isView(v)) {
        const b = v.buffer;
        if (b && !seen.has(b) && !(typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer)) { seen.add(b); out.push(b); }
        return;
      }
      if (v instanceof ArrayBuffer) { if (!seen.has(v)) { seen.add(v); out.push(v); } return; }
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };
    walk(value, 0);
    return out;
  }

  function workerMain(Core, scope) {
    scope = scope || (typeof self !== 'undefined' ? self : null);
    if (!scope || typeof scope.postMessage !== 'function') return null;
    const engine = new Core.UVEngine();
    const methods = publicMethods(engine);

    scope.onmessage = async (ev) => {
      const msg = ev.data || {};
      const { id, op } = msg;
      const args = Array.isArray(msg.args) ? msg.args : [];
      if (op === '__ping') { scope.postMessage({ id, type: 'result', result: 'pong' }); return; }
      if (op === '__methods') { scope.postMessage({ id, type: 'result', result: methods }); return; }
      if (typeof op !== 'string' || methods.indexOf(op) < 0) {
        scope.postMessage({ id, type: 'error', message: 'Unknown engine operation: ' + op, stack: '' });
        return;
      }
      const last = new Map();
      const progress = (stage, done, total) => {
        const t = Date.now(), prev = last.get(stage) || 0;
        if (done !== total && t - prev < 33) return;
        last.set(stage, t);
        scope.postMessage({ id, type: 'progress', stage, done, total });
      };
      const shouldCancel = () => false;
      try {
        let result = engine[op](...args, progress, shouldCancel);
        if (result && typeof result.then === 'function') result = await result;
        const transfer = collectTransfers(result);
        scope.postMessage({ id, type: 'result', result }, transfer);
      } catch (err) {
        scope.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack ? String(err.stack) : '' });
      }
    };
    scope.postMessage({ type: 'ready', methods });
    return engine;
  }

  return { workerMain, collectTransfers, publicMethods };
});
