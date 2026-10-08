/* EngineClient: runs the UV kernel in a Blob-URL Web Worker (file:// safe),
 * with a transparent main-thread fallback. Classic script.
 *
 *   const client = await new UVApp.EngineClient().init();
 *   client.mode                         'worker' | 'main'
 *   client.call(op, ...args) -> Promise  any engine method (FIFO, one at a time)
 *   client.unwrap(opts) / relax / repack / setMesh / ... convenience wrappers
 *   client.onProgress(fn) -> unsubscribe     fn({ op, stage, done, total })
 *   client.cancel() -> Promise           worker: terminate + respawn + replay state; main: cooperative flag
 */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};

  const OPS = ['setMesh', 'meshInfo', 'setCut', 'getCut', 'getManualCut', 'toggleSeamEdge', 'setSeamEdges', 'seamsFromAngle', 'clearSeams',
    'edgeSegments', 'setSourceUV', 'analyzeSource', 'seamsFromSourceUV', 'unwrap', 'relax', 'repack', 'optimizeSearch', 'metrics',
    'snapshot', 'restore', 'adoptSource', 'transformChart', 'defaults', 'capabilities', 'version',
    'planSeams', 'autoUnwrap', 'clearAutoSeams', 'getAutoCut', 'setAutoCut', 'islandOp', 'pinCharts', 'pinnedCharts', 'stitchEdges', 'seamSymmetry'];
  const STATEFUL = ['setMesh', 'setCut', 'setSourceUV'];
  const MUTATES_SEAMS = ['toggleSeamEdge', 'setSeamEdges', 'seamsFromAngle', 'clearSeams', 'seamsFromSourceUV', 'restore', 'adoptSource', 'stitchEdges'];

  function cancelError() { const e = new Error('Operation cancelled'); e.name = 'CancelError'; return e; }
  function copyReplay(value) {
    if (ArrayBuffer.isView(value)) return value.slice();
    if (Array.isArray(value)) return value.map(copyReplay);
    if (value && typeof value === 'object') { const out = {}; for (const key of Object.keys(value)) out[key] = copyReplay(value[key]); return out; }
    return value;
  }

  class EngineClient {
    constructor(options) {
      const o = options || {};
      this.core = o.core || root.UVCore;
      this.forceMain = !!o.forceMain;
      this.readyTimeoutMs = o.readyTimeoutMs || 4000;
      this.workerFactory = o.workerFactory || null;
      this.mode = null;
      this.methods = [];
      this.queue = [];
      this.active = null;
      this.listeners = new Set();
      this.replay = new Map();   // op -> args (state to restore after a hard cancel)
      this.nextId = 1;
      this.mainCancel = false;
      this.restarting = false;
      this.ready = Promise.resolve();   // settles when a restart (after cancel / crash) has replayed state
      this.worker = null;
      this.engine = null;
      this.disposed = false;
      this.abortStart = null;
      for (const op of OPS) if (!this[op]) this[op] = (...args) => this.call(op, ...args);
    }

    async init() {
      if (this.disposed) throw cancelError();
      if (!this.forceMain) {
        try { await this.spawnWorker(); this.mode = 'worker'; return this; }
        catch (err) { this.workerError = err; if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } this.worker = null; } }
      }
      if (this.disposed) throw cancelError();
      this.startMain();
      return this;
    }

    startMain() {
      const C = this.core.build();
      this.engine = new C.UVEngine();
      this.methods = C.publicMethods ? C.publicMethods(this.engine) : OPS.slice();
      this.mode = 'main';
    }

    spawnWorker() {
      return new Promise((resolve, reject) => {
        let worker, url = null;
        // workerMain is a kernel export (not a global): build the kernel and start the loop
        const source = this.core.source() + '\n(function () { var C = UVCore.build(); C.workerMain(C, self); })();\n';
        try {
          if (this.workerFactory) worker = this.workerFactory(source);
          else {
            url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            worker = new Worker(url);
          }
        } catch (e) { if (url) URL.revokeObjectURL(url); reject(e); return; }
        const timer = setTimeout(() => fail(new Error('Worker did not become ready within ' + this.readyTimeoutMs + ' ms')), this.readyTimeoutMs);
        const cleanup = () => { clearTimeout(timer); this.abortStart = null; if (url) URL.revokeObjectURL(url); };
        const fail = (error) => {
          cleanup();
          worker.onmessage = worker.onerror = null;
          try { worker.terminate(); } catch (e) { /* ignore */ }
          reject(error);
        };
        this.abortStart = () => fail(cancelError());
        worker.onmessage = (ev) => {
          const msg = ev.data || {};
          if (msg.type === 'ready') {
            if (this.disposed) { fail(cancelError()); return; }
            cleanup();
            this.worker = worker;
            this.methods = msg.methods || [];
            worker.onmessage = (e) => this.onWorkerMessage(e.data);
            worker.onerror = (e) => this.onWorkerCrash(e);
            resolve();
          }
        };
        worker.onerror = (e) => fail(new Error('Worker failed to start: ' + (e && e.message ? e.message : 'unknown error')));
      });
    }

    onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(p) { for (const fn of this.listeners) { try { fn(p); } catch (e) { /* listener errors never break the engine */ } } }

    call(op, ...args) {
      return new Promise((resolve, reject) => {
        if (this.disposed) { reject(cancelError()); return; }
        this.queue.push({ id: this.nextId++, op, args, resolve, reject, transfer: null });
        this.pump();
      });
    }

    /* Like call(), transferring the given buffers to the worker (the caller loses them). */
    callTransfer(op, args, transfer) {
      return new Promise((resolve, reject) => {
        if (this.disposed) { reject(cancelError()); return; }
        this.queue.push({ id: this.nextId++, op, args, resolve, reject, transfer });
        this.pump();
      });
    }

    record(op, args) {
      if (STATEFUL.indexOf(op) >= 0) {
        if (op === 'setMesh') this.replay.clear();
        this.replay.set(op, args.map(copyReplay));
      }
    }

    pump() {
      if (this.disposed || this.active || !this.queue.length || this.restarting) return;
      const job = this.active = this.queue.shift();
      // Retain a candidate before transferable buffers are detached, but only
      // commit it once the engine confirms that the operation succeeded.
      const candidate = !job.noRecord && STATEFUL.indexOf(job.op) >= 0 ? job.args.map(copyReplay) : null;
      const done = (fn, v) => {
        if (this.active !== job) return;
        this.active = null;
        if (fn === job.resolve && candidate) this.record(job.op, candidate);
        if (fn === job.resolve && MUTATES_SEAMS.indexOf(job.op) >= 0) {
          // A successful mutation is not acknowledged until its replay state is
          // captured. Immediate cancellation must not lose just-edited seams.
          this.refreshSeamReplay(() => fn(v), job.reject);
        } else fn(v);
        this.pump();
      };
      job.done = done;
      if (this.mode === 'worker') {
        const transfer = job.transfer || [];
        const args = job.op === 'setMesh' && ArrayBuffer.isView(job.args[0]) && !job.transfer ? [job.args[0].slice()].concat(job.args.slice(1)) : job.args;
        if (job.op === 'setMesh' && args !== job.args) transfer.push(args[0].buffer);
        try { this.worker.postMessage({ id: job.id, op: job.op, args }, transfer); }
        catch (e) { done(job.reject, e); }
        return;
      }
      // main-thread mode: yield so the UI can paint, then run synchronously
      this.mainCancel = false;
      setTimeout(() => {
        if (this.active !== job) return;
        const engine = this.engine;
        if (typeof engine[job.op] !== 'function') { done(job.reject, new Error('Unknown engine operation: ' + job.op)); return; }
        let last = 0;
        const progress = (stage, d, t) => {
          const now = Date.now();
          if (d !== t && now - last < 33) return;
          last = now;
          this.emit({ op: job.op, stage, done: d, total: t });
        };
        try {
          const r = engine[job.op](...job.args, progress, () => this.mainCancel);
          if (r && r.cancelled && this.mainCancel) done(job.reject, cancelError());
          else done(job.resolve, r);
        } catch (e) { done(job.reject, e); }
      }, 0);
    }

    refreshSeamReplay(resolve, reject) {
      // seams edited incrementally: keep a fresh full copy for replay after a respawn
      this.queue.unshift({ id: this.nextId++, op: 'getManualCut', args: [], resolve: (cut) => { if (cut) this.replay.set('setCut', [cut]); if (resolve) resolve(); }, reject: reject || (() => {}), internal: true });
    }

    onWorkerMessage(msg) {
      const job = this.active;
      if (!job || msg.id !== job.id) return;
      if (msg.type === 'progress') { if (!job.internal) this.emit({ op: job.op, stage: msg.stage, done: msg.done, total: msg.total }); return; }
      if (msg.type === 'result') job.done(job.resolve, msg.result);
      else if (msg.type === 'error') { const e = new Error(msg.message); e.workerStack = msg.stack; job.done(job.reject, e); }
    }

    onWorkerCrash(e) {
      const err = new Error('The engine worker crashed: ' + (e && e.message ? e.message : 'unknown error') + '. Restarting it.');
      if (e && e.preventDefault) e.preventDefault();
      this.hardRestart(err);
    }

    /* Terminates the worker, rejects in-flight and queued work, respawns and replays
     * the engine state (mesh, source UVs, seams). Calls issued while restarting wait
     * in the queue and run after the replay, so they always see the restored state. */
    hardRestart(reason) {
      if (this.disposed) return Promise.resolve();
      if (this.restarting) return this.ready;
      const pending = (this.active ? [this.active] : []).concat(this.queue);
      this.active = null;
      this.queue = [];
      this.restarting = true;
      if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } this.worker = null; }
      for (const j of pending) j.reject(reason);
      const entries = ['setMesh', 'setSourceUV', 'setCut'].filter(op => this.replay.has(op)).map(op => [op, this.replay.get(op)]);
      this.ready = (async () => {
        try { await this.spawnWorker(); this.mode = 'worker'; }
        catch (e) { if (!this.disposed) this.startMain(); }
        if (this.disposed) { this.restarting = false; return; }
        const userJobs = this.queue.splice(0);
        const replayed = entries.map(([op, args]) => new Promise((resolve) => {
          this.queue.push({ id: this.nextId++, op, args: args.map(a => ArrayBuffer.isView(a) ? a.slice() : a), resolve, reject: resolve, internal: true, noRecord: true });
        }));
        this.queue.push(...userJobs);
        this.restarting = false;
        this.pump();
        await Promise.all(replayed);
      })();
      return this.ready;
    }

    async cancel() {
      if (!this.active && !this.queue.length) return false;
      if (this.mode === 'main') {
        this.mainCancel = true;
        const queued = this.queue.splice(0);
        for (const j of queued) j.reject(cancelError());
        return true;
      }
      await this.hardRestart(cancelError());
      return true;
    }

    markStateful(op) { if (STATEFUL.indexOf(op) < 0) STATEFUL.push(op); }

    dispose() {
      this.disposed = true;
      if (this.abortStart) this.abortStart();
      if (this.worker) this.worker.terminate();
      this.worker = null;
      if (this.active) this.active.reject(cancelError());
      this.active = null;
      for (const j of this.queue) j.reject(cancelError());
      this.queue = [];
      this.listeners.clear();
      this.replay.clear();
      this.engine = null;
    }
  }

  UVApp.EngineClient = EngineClient;
})(typeof window !== 'undefined' ? window : globalThis);
