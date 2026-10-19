// Main-thread side of the engine worker: a tiny promise-based RPC.

export class EngineClient {
  constructor() {
    this.worker = new Worker(new URL('../workers/engine-worker.js', import.meta.url));
    this.nextId = 1;
    this.pending = new Map();
    this.progressHandlers = new Map();
    this.onLog = null;
    this.worker.onmessage = (event) => this.#receive(event.data);
    this.worker.onerror = (event) => {
      const error = { code: 'WORKER', message: event.message || 'The engine worker crashed.' };
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
  }

  #receive(msg) {
    if (msg.type === 'progress') {
      const fn = this.progressHandlers.get(msg.id);
      if (fn) fn(msg);
      return;
    }
    if (msg.type === 'log') {
      if (this.onLog) this.onLog(msg.message);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    this.progressHandlers.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(msg.error);
  }

  #call(type, payload = {}, transfer = [], onProgress = null) {
    const id = this.nextId++;
    if (onProgress) this.progressHandlers.set(id, onProgress);
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ id, type, ...payload }, transfer);
    promise.requestId = id;
    return promise;
  }

  load() {
    return this.#call('load');
  }

  /** OBJ / STEP / 3MF bytes -> binary STL bytes (Uint8Array). */
  async convert(kind, bytes) {
    const copy = bytes.slice().buffer;
    const result = await this.#call('convert', { kind, bytes: copy }, [copy]);
    return new Uint8Array(result.stl);
  }

  arrange(layers, blob, manifest, operation = 'arrange') {
    const copy = blob.slice().buffer;
    return this.#call('arrange', { layers, blob: copy, manifest, operation }, [copy]);
  }

  /** Slice one or more plates. Returns { promise, cancel }. */
  slice(layers, blob, manifest, plateIds, onProgress, packaged = false, shift = null) {
    const copy = blob.slice().buffer;
    const promise = this.#call('slice', { layers, blob: copy, manifest, plateIds, packaged, shift }, [copy], onProgress);
    const id = promise.requestId;
    return {
      promise,
      cancel: () => this.#call('cancel', { target: id }),
    };
  }

  /** OrcaSlicer project (.3mf) bytes for the whole plate set. */
  async exportProject(layers, blob, manifest) {
    const copy = blob.slice().buffer;
    const result = await this.#call('exportProject', { layers, blob: copy, manifest }, [copy]);
    return { bytes: new Uint8Array(result.bytes), skipped: result.skipped };
  }
}
