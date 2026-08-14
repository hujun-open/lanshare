// The transfer engine. It talks to a "transport", which is either a WebRTC data
// channel or a relay tunnel; both expose send / onMessage / bufferedAmount /
// waitUntilWritable, so nothing below cares which path is in use.
//
// Control messages are strings and payload is binary, which is enough framing
// on an ordered reliable stream: an "fstart" marks which file the following
// chunks belong to, and "fend" closes it. A pasted document uses "dstart" and
// "dend" the same way, because rich content with its images inlined runs to
// megabytes and a data channel refuses any single message over 256 KB.

import { MAX_DOC_BYTES } from './rich.js';

export const CHUNK_SIZE = 64 * 1024;

// Sampling window for the live throughput readout.
const RATE_SAMPLE_MS = 250;

// What a received document is called in the transfer list and in saved files.
const DOC_NAME = 'Pasted page';

// A rich message this small is a message, not a transfer, so asking the user to
// approve it would be noise. Anything larger is confirmed like a file.
const AUTO_ACCEPT_DOC_BYTES = 2 * 1024 * 1024;

// The plain-text alternative rides along in the dstart message, so it has to
// stay well inside the smallest single-message limit of the two transports.
const PLAIN_FALLBACK_LIMIT = 32 * 1024;

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

/**
 * Keeps a document in memory and hands it back as text, since a pasted page is
 * meant to be rendered in the inbox rather than saved. Bounded by the size the
 * receiver agreed to in dstart.
 */
class MemorySink {
  #parts = [];

  async write(chunk) {
    this.#parts.push(new Uint8Array(chunk));
  }

  async finish() {
    let total = 0;
    for (const part of this.#parts) total += part.byteLength;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of this.#parts) {
      joined.set(part, at);
      at += part.byteLength;
    }
    this.#parts = [];
    // Decoding once at the end rather than per chunk, because a multi-byte
    // character can straddle a chunk boundary.
    return new TextDecoder().decode(joined);
  }

  async abort() {
    this.#parts = [];
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

export function triggerDownload(blob, name) {
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
 * text, rich, declined.
 */
export class Conversation extends EventTarget {
  #inboundBatch = null;
  // Files and documents share one inbound slot. That is safe because chunks
  // carry no identity of their own: each side serialises its own outbound
  // stream, so only one can be open in a given direction at a time.
  #inbound = null;
  #pendingDecision = null;
  #pendingAcks = new Map();
  #sending = false;
  #cancelled = new Set();

  /**
   * @param {object} options
   * @param {string} options.peerId
   * @param {() => Promise<object>} options.acquireTransport resolves a connected transport
   * @param {(files, peerId) => Promise<{accepted: boolean, handle?: any}>} options.confirmIncoming
   * @param {(size: number, peerId: string) => Promise<boolean>} [options.confirmDoc]
   */
  constructor({ peerId, acquireTransport, confirmIncoming, confirmDoc }) {
    super();
    this.peerId = peerId;
    this.acquireTransport = acquireTransport;
    this.confirmIncoming = confirmIncoming;
    this.confirmDoc = confirmDoc ?? (() => Promise.resolve(true));
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

  /**
   * Sends a sanitized HTML fragment as a document, with a plain-text
   * alternative for the receiver's clipboard. Takes the same lock as a file
   * batch, since two chunk streams in one direction would interleave.
   *
   * @param {{html: string, text?: string}} doc
   */
  async sendDoc({ html, text = '' }) {
    if (this.#sending) {
      throw new Error('a transfer to this device is already running');
    }
    this.#sending = true;
    try {
      await this.#runDoc(html, text);
    } finally {
      this.#sending = false;
    }
  }

  async #runDoc(html, text) {
    const transport = await this.acquireTransport();
    const blob = new Blob([html], { type: 'text/html' });
    if (blob.size > MAX_DOC_BYTES) {
      throw new Error('that is too much formatted content to send at once');
    }

    const id = newId('d');
    const transferId = `doc:${id}`;

    transport.send(JSON.stringify({
      k: 'dstart',
      id,
      size: blob.size,
      text: text.slice(0, PLAIN_FALLBACK_LIMIT),
      ts: Date.now(),
    }));

    const accepted = await this.#awaitDecision(id);
    if (!accepted) {
      this.#emit('declined', { batchId: id });
      return;
    }

    this.#emit('transfer-start', {
      id: transferId, direction: 'send', name: DOC_NAME, size: blob.size,
      peerId: this.peerId, path: transport.kind, role: 'doc',
    });

    try {
      const meter = await this.#pump(transport, blob, transferId, () => this.#cancelled.has(id));
      transport.send(JSON.stringify({ k: 'dend', id }));
      await this.#awaitAck(id);

      this.#emit('transfer-progress', {
        id: transferId, transferred: blob.size, total: blob.size,
        rate: meter.rate, eta: 0, path: transport.kind,
      });
      this.#emit('transfer-done', {
        id: transferId, direction: 'send', name: DOC_NAME, role: 'doc',
      });
    } catch (err) {
      this.#emit('transfer-error', { id: transferId, name: DOC_NAME, error: err.message });
      throw err;
    }
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

    this.#emit('transfer-start', {
      id: transferId, direction: 'send', name: meta.name, size: meta.size,
      peerId: this.peerId, path: transport.kind,
    });

    try {
      transport.send(JSON.stringify({ k: 'fstart', batchId, id: meta.id }));

      const meter = await this.#pump(
        transport, file, transferId, () => this.#cancelled.has(batchId),
      );

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

  /** Chunks a blob onto the transport, reporting progress. Returns the meter. */
  async #pump(transport, blob, transferId, isCancelled) {
    const meter = new RateMeter();
    let offset = 0;

    while (offset < blob.size) {
      if (isCancelled()) throw new Error('cancelled');
      await transport.waitUntilWritable();

      const end = Math.min(offset + CHUNK_SIZE, blob.size);
      const chunk = await blob.slice(offset, end).arrayBuffer();
      transport.send(chunk);
      offset = end;

      // Bytes still sitting in the send buffer have not reached the peer, so
      // subtracting them keeps the progress bar honest on both paths.
      const settled = Math.max(0, offset - transport.bufferedAmount);
      this.#emit('transfer-progress', {
        id: transferId, transferred: settled, total: blob.size,
        rate: meter.update(settled), eta: meter.eta(settled, blob.size),
        path: transport.kind,
      });
    }

    return meter;
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
      case 'dstart': this.#onDocStart(msg, transport); break;
      case 'dend': this.#onDocEnd(msg, transport); break;
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
    this.#inbound = {
      kind: 'file', meta, sink, transferId, received: 0, meter: new RateMeter(), transport,
    };
    this.#emit('transfer-start', {
      id: transferId, direction: 'receive', name: meta.name, size: meta.size,
      peerId: this.peerId, path: transport.kind,
    });
  }

  /**
   * A document is held in memory, so the size agreed in dstart is a hard limit
   * rather than a hint: a peer that keeps sending past it is cut off.
   */
  async #onDocStart(msg, transport) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const size = Number(msg.size);
    if (!id) return;

    if (!Number.isFinite(size) || size <= 0 || size > MAX_DOC_BYTES) {
      transport.send(JSON.stringify({ k: 'decline', batchId: id }));
      return;
    }

    if (size > AUTO_ACCEPT_DOC_BYTES) {
      let accepted = false;
      try {
        accepted = await this.confirmDoc(size, this.peerId);
      } catch {
        accepted = false;
      }
      if (!accepted) {
        transport.send(JSON.stringify({ k: 'decline', batchId: id }));
        return;
      }
    }

    const transferId = `doc:${id}`;
    this.#inbound = {
      kind: 'doc',
      meta: { id, name: DOC_NAME, size, type: 'text/html' },
      sink: new MemorySink(),
      transferId,
      received: 0,
      meter: new RateMeter(),
      transport,
      text: typeof msg.text === 'string' ? msg.text : '',
      ts: msg.ts,
    };

    this.#emit('transfer-start', {
      id: transferId, direction: 'receive', name: DOC_NAME, size,
      peerId: this.peerId, path: transport.kind, role: 'doc',
    });
    transport.send(JSON.stringify({ k: 'accept', batchId: id }));
  }

  async #onChunk(buffer) {
    const inbound = this.#inbound;
    if (!inbound) return;

    if (inbound.kind === 'doc' && inbound.received + buffer.byteLength > inbound.meta.size) {
      this.#inbound = null;
      await inbound.sink.abort();
      this.#emit('transfer-error', {
        id: inbound.transferId, name: inbound.meta.name,
        error: 'the other device sent more than it announced',
      });
      return;
    }

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

  async #onDocEnd(msg, transport) {
    const inbound = this.#inbound;
    if (!inbound || inbound.kind !== 'doc' || inbound.meta.id !== msg.id) return;
    this.#inbound = null;

    try {
      const html = await inbound.sink.finish();
      transport.flushAck?.();
      transport.send(JSON.stringify({ k: 'received', id: msg.id }));
      this.#emit('rich', {
        html, text: inbound.text, ts: inbound.ts, peerId: this.peerId,
      });
      this.#emit('transfer-done', {
        id: inbound.transferId, direction: 'receive', name: DOC_NAME, role: 'doc',
      });
    } catch (err) {
      await inbound.sink.abort();
      this.#emit('transfer-error', {
        id: inbound.transferId, name: DOC_NAME, error: err.message,
      });
    }
  }

  async #onFileEnd(msg, transport) {
    const inbound = this.#inbound;
    if (!inbound || inbound.kind !== 'file' || inbound.meta.id !== msg.id) return;
    this.#inbound = null;

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
    if (!this.#inbound) return;
    await this.#inbound.sink.abort();
    this.#emit('transfer-error', {
      id: this.#inbound.transferId,
      name: this.#inbound.meta.name,
      error: 'cancelled by sender',
    });
    this.#inbound = null;
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
    if (this.#inbound) {
      this.#inbound.sink.abort();
      this.#emit('transfer-error', {
        id: this.#inbound.transferId, name: this.#inbound.meta.name, error: reason,
      });
      this.#inbound = null;
    }
  }
}
