// The transfer engine. It talks to a "transport", which is either a WebRTC data
// channel or a relay tunnel; both expose send / onMessage / bufferedAmount /
// waitUntilWritable, so nothing below cares which path is in use.
//
// Control messages are strings and payload is binary, which is enough framing
// on an ordered reliable stream: an "fstart" marks which file the following
// chunks belong to, and "fend" closes it.

export const CHUNK_SIZE = 64 * 1024;

// Sampling window for the live throughput readout.
const RATE_SAMPLE_MS = 250;

/** Tracks throughput without letting a single slow chunk swing the readout. */
class RateMeter {
  #lastAt = performance.now();
  #lastBytes = 0;
  #rate = 0;

  constructor() {
    this.startedAt = performance.now();
  }

  update(totalBytes) {
    const now = performance.now();
    const elapsed = now - this.#lastAt;
    if (elapsed >= RATE_SAMPLE_MS) {
      const instant = ((totalBytes - this.#lastBytes) * 1000) / elapsed;
      // Smooth so the number is readable rather than twitchy.
      this.#rate = this.#rate === 0 ? instant : this.#rate * 0.6 + instant * 0.4;
      this.#lastAt = now;
      this.#lastBytes = totalBytes;
    }
    return this.#rate;
  }

  get rate() {
    return this.#rate;
  }

  eta(transferred, total) {
    if (this.#rate <= 0 || transferred >= total) return null;
    return (total - transferred) / this.#rate;
  }
}

/** Buffers chunks in memory. Large blobs are paged to disk by the browser. */
class BlobSink {
  #chunks = [];

  constructor(meta) {
    this.meta = meta;
  }

  async write(chunk) {
    this.#chunks.push(chunk);
  }

  async finish() {
    const blob = new Blob(this.#chunks, { type: this.meta.type || 'application/octet-stream' });
    this.#chunks = [];
    triggerDownload(blob, this.meta.name);
  }

  async abort() {
    this.#chunks = [];
  }
}

/** Streams straight to a file the user chose. Needs a secure context. */
class StreamSink {
  constructor(meta, writable) {
    this.meta = meta;
    this.writable = writable;
  }

  async write(chunk) {
    await this.writable.write(chunk);
  }

  async finish() {
    await this.writable.close();
  }

  async abort() {
    try { await this.writable.abort(); } catch { /* nothing to undo */ }
  }
}

/** True when the browser can stream a download straight to disk. */
export function canStreamToDisk() {
  return typeof window.showSaveFilePicker === 'function' && window.isSecureContext;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFileName(name);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Strips any path components a peer may have put in a file name. */
export function safeFileName(name) {
  const base = String(name ?? 'download').split(/[\\/]/).pop().trim();
  return base.replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 180) || 'download';
}

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * One peer's worth of transfer state: an outbound queue and the inbound
 * assembly machine.
 *
 * Events: transfer-start, transfer-progress, transfer-done, transfer-error,
 * text, declined.
 */
export class Conversation extends EventTarget {
  #inboundBatch = null;
  #inboundFile = null;
  #pendingDecision = null;
  #pendingAcks = new Map();
  #sending = false;
  #cancelled = new Set();

  /**
   * @param {object} options
   * @param {string} options.peerId
   * @param {() => Promise<object>} options.acquireTransport resolves a connected transport
   * @param {(files, peerId) => Promise<{accepted: boolean, handle?: any}>} options.confirmIncoming
   */
  constructor({ peerId, acquireTransport, confirmIncoming }) {
    super();
    this.peerId = peerId;
    this.acquireTransport = acquireTransport;
    this.confirmIncoming = confirmIncoming;
  }

  /** Routes a transport's messages here. Both paths may be attached at once. */
  attach(transport) {
    transport.onMessage = (data) => this.#onMessage(data, transport);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------------------------------------------------------------- sending

  async sendText(body) {
    const transport = await this.acquireTransport();
    transport.send(JSON.stringify({ k: 'text', id: newId('t'), body, ts: Date.now() }));
  }

  async sendFiles(fileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    if (this.#sending) {
      throw new Error('a transfer to this device is already running');
    }
    this.#sending = true;
    try {
      await this.#runBatch(files);
    } finally {
      this.#sending = false;
    }
  }

  async #runBatch(files) {
    const transport = await this.acquireTransport();
    const batchId = newId('b');
    const metas = files.map((file) => ({
      id: newId('f'),
      name: file.name,
      size: file.size,
      type: file.type,
    }));

    transport.send(JSON.stringify({ k: 'batch', batchId, files: metas }));

    const accepted = await this.#awaitDecision(batchId);
    if (!accepted) {
      this.#emit('declined', { batchId });
      return;
    }

    for (let i = 0; i < files.length; i += 1) {
      if (this.#cancelled.has(batchId)) break;
      await this.#sendOne(transport, files[i], metas[i], batchId);
    }
  }

  #awaitDecision(batchId, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingDecision = null;
        reject(new Error('the other device did not respond'));
      }, timeoutMs);
      this.#pendingDecision = { batchId, resolve, timer };
    });
  }

  async #sendOne(transport, file, meta, batchId) {
    const transferId = `${batchId}:${meta.id}`;
    const meter = new RateMeter();

    this.#emit('transfer-start', {
      id: transferId, direction: 'send', name: meta.name, size: meta.size,
      peerId: this.peerId, path: transport.kind,
    });

    try {
      transport.send(JSON.stringify({ k: 'fstart', batchId, id: meta.id }));

      let offset = 0;
      while (offset < file.size) {
        if (this.#cancelled.has(batchId)) throw new Error('cancelled');
        await transport.waitUntilWritable();

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = await file.slice(offset, end).arrayBuffer();
        transport.send(chunk);
        offset = end;

        // Bytes still sitting in the send buffer have not reached the peer, so
        // subtracting them keeps the progress bar honest on both paths.
        const settled = Math.max(0, offset - transport.bufferedAmount);
        this.#emit('transfer-progress', {
          id: transferId, transferred: settled, total: file.size,
          rate: meter.update(settled), eta: meter.eta(settled, file.size),
          path: transport.kind,
        });
      }

      transport.send(JSON.stringify({ k: 'fend', batchId, id: meta.id }));
      await this.#awaitAck(meta.id);

      this.#emit('transfer-progress', {
        id: transferId, transferred: file.size, total: file.size,
        rate: meter.rate, eta: 0, path: transport.kind,
      });
      this.#emit('transfer-done', { id: transferId, direction: 'send', name: meta.name });
    } catch (err) {
      this.#emit('transfer-error', { id: transferId, name: meta.name, error: err.message });
      throw err;
    }
  }

  #awaitAck(fileId, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingAcks.delete(fileId);
        reject(new Error('the other device never confirmed the file'));
      }, timeoutMs);
      this.#pendingAcks.set(fileId, { resolve, timer });
    });
  }

  cancel(batchId) {
    this.#cancelled.add(batchId);
  }

  // -------------------------------------------------------------- receiving

  #onMessage(data, transport) {
    if (typeof data !== 'string') {
      this.#onChunk(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.k) {
      case 'batch': this.#onBatch(msg, transport); break;
      case 'accept': this.#resolveDecision(msg.batchId, true); break;
      case 'decline': this.#resolveDecision(msg.batchId, false); break;
      case 'fstart': this.#onFileStart(msg, transport); break;
      case 'fend': this.#onFileEnd(msg, transport); break;
      case 'received': this.#resolveAck(msg.id); break;
      case 'text': this.#emit('text', { body: msg.body, ts: msg.ts, peerId: this.peerId }); break;
      case 'cancel': this.#onRemoteCancel(); break;
      default: break;
    }
  }

  #resolveDecision(batchId, accepted) {
    const pending = this.#pendingDecision;
    if (!pending || pending.batchId !== batchId) return;
    clearTimeout(pending.timer);
    this.#pendingDecision = null;
    pending.resolve(accepted);
  }

  #resolveAck(fileId) {
    const pending = this.#pendingAcks.get(fileId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingAcks.delete(fileId);
    pending.resolve();
  }

  async #onBatch(msg, transport) {
    const files = Array.isArray(msg.files) ? msg.files : [];
    let decision = { accepted: false };
    try {
      decision = await this.confirmIncoming(files, this.peerId);
    } catch {
      decision = { accepted: false };
    }

    if (!decision.accepted) {
      transport.send(JSON.stringify({ k: 'decline', batchId: msg.batchId }));
      return;
    }

    this.#inboundBatch = {
      batchId: msg.batchId,
      files: new Map(files.map((f) => [f.id, f])),
      handle: decision.handle ?? null,
    };
    transport.send(JSON.stringify({ k: 'accept', batchId: msg.batchId }));
  }

  async #onFileStart(msg, transport) {
    const batch = this.#inboundBatch;
    if (!batch || batch.batchId !== msg.batchId) return;
    const meta = batch.files.get(msg.id);
    if (!meta) return;

    let sink;
    if (batch.handle) {
      try {
        sink = new StreamSink(meta, await batch.handle.createWritable());
      } catch {
        sink = new BlobSink(meta);
      }
      // A picked handle applies to a single file only.
      batch.handle = null;
    } else {
      sink = new BlobSink(meta);
    }

    const transferId = `${msg.batchId}:${msg.id}`;
    this.#inboundFile = {
      meta, sink, transferId, received: 0, meter: new RateMeter(), transport,
    };
    this.#emit('transfer-start', {
      id: transferId, direction: 'receive', name: meta.name, size: meta.size,
      peerId: this.peerId, path: transport.kind,
    });
  }

  async #onChunk(buffer) {
    const inbound = this.#inboundFile;
    if (!inbound) return;
    await inbound.sink.write(buffer);
    inbound.received += buffer.byteLength;
    this.#emit('transfer-progress', {
      id: inbound.transferId,
      transferred: inbound.received,
      total: inbound.meta.size,
      rate: inbound.meter.update(inbound.received),
      eta: inbound.meter.eta(inbound.received, inbound.meta.size),
      path: inbound.transport.kind,
    });
  }

  async #onFileEnd(msg, transport) {
    const inbound = this.#inboundFile;
    if (!inbound || inbound.meta.id !== msg.id) return;
    this.#inboundFile = null;

    try {
      await inbound.sink.finish();
      // Make sure the sender's credit window sees the final bytes before it
      // waits on the confirmation below.
      transport.flushAck?.();
      transport.send(JSON.stringify({ k: 'received', id: msg.id }));
      this.#emit('transfer-done', {
        id: inbound.transferId, direction: 'receive', name: inbound.meta.name,
      });
    } catch (err) {
      await inbound.sink.abort();
      this.#emit('transfer-error', {
        id: inbound.transferId, name: inbound.meta.name, error: err.message,
      });
    }
  }

  async #onRemoteCancel() {
    if (!this.#inboundFile) return;
    await this.#inboundFile.sink.abort();
    this.#emit('transfer-error', {
      id: this.#inboundFile.transferId,
      name: this.#inboundFile.meta.name,
      error: 'cancelled by sender',
    });
    this.#inboundFile = null;
  }

  /** Fails anything in flight, used when the peer disappears. */
  abortAll(reason) {
    if (this.#pendingDecision) {
      clearTimeout(this.#pendingDecision.timer);
      this.#pendingDecision.resolve(false);
      this.#pendingDecision = null;
    }
    for (const [, pending] of this.#pendingAcks) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.#pendingAcks.clear();
    if (this.#inboundFile) {
      this.#inboundFile.sink.abort();
      this.#emit('transfer-error', {
        id: this.#inboundFile.transferId, name: this.#inboundFile.meta.name, error: reason,
      });
      this.#inboundFile = null;
    }
  }
}
