// The fallback path: payload tunnelled through the signaling WebSocket.
//
// This is only reached when neither browser would accept an unsolicited inbound
// packet, so ICE could not validate any candidate pair. Both sides are
// outbound-only to the server, which is the one connection guaranteed to work.
//
// Frame layout on the wire is [4-byte session][1-byte kind][payload]. The
// server routes on the session alone and never parses the rest, so control
// messages and file chunks share one ordered stream exactly as they do on a
// data channel.

const KIND_BINARY = 0;
const KIND_TEXT = 1;

// Bytes allowed in flight before the sender waits for the receiver to catch up.
// This is what stops a fast sender from making the server buffer a whole file.
const CREDIT_WINDOW = 4 * 1024 * 1024;

// How much the receiver takes in before telling the sender about it.
const ACK_INTERVAL = 512 * 1024;

// Local socket backpressure, since a WebSocket has no drain event.
const WS_HIGH_WATER = 4 * 1024 * 1024;
const POLL_MS = 25;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Live relay transports by session ID, so server control messages can find them. */
const activeRelays = new Map();

export function handleRelayAck(session, bytes) {
  activeRelays.get(session)?.applyAck(bytes);
}

export function handleRelayClose(session) {
  activeRelays.get(session)?.markClosed();
}

/**
 * Asks the server for a relay session to a peer and resolves once it is ready.
 */
export function openRelaySession(signaling, peerId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const onReady = (event) => {
      if (event.detail.id !== peerId) return;
      cleanup();
      resolve(new RelayTransport({ signaling, session: event.detail.session, peerId }));
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(event.detail.error ?? 'relay refused'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signaling.removeEventListener('relay-ready', onReady);
      signaling.removeEventListener('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('relay setup timed out'));
    }, timeoutMs);

    signaling.addEventListener('relay-ready', onReady);
    signaling.addEventListener('error', onError);

    if (!signaling.send({ type: 'relay-open', to: peerId })) {
      cleanup();
      reject(new Error('not connected to the server'));
    }
  });
}

export class RelayTransport {
  kind = 'relay';
  onMessage = null;

  #sent = 0;
  #acked = 0;
  #received = 0;
  #ackedUpTo = 0;
  #closed = false;

  constructor({ signaling, session, peerId }) {
    this.signaling = signaling;
    this.session = session;
    this.peerId = peerId;
    activeRelays.set(session, this);
    signaling.onRelayData(session, (payload) => this.#receive(payload));
  }

  get open() {
    return !this.#closed && this.signaling.connected;
  }

  get bufferedAmount() {
    return this.#sent - this.#acked;
  }

  send(data) {
    if (this.#closed) throw new Error('relay closed');
    if (typeof data === 'string') {
      this.#write(KIND_TEXT, encoder.encode(data));
    } else {
      this.#write(KIND_BINARY, new Uint8Array(data));
    }
  }

  #write(kind, bytes) {
    const frame = new Uint8Array(5 + bytes.byteLength);
    new DataView(frame.buffer).setUint32(0, this.session, false);
    frame[4] = kind;
    frame.set(bytes, 5);
    if (!this.signaling.sendBinary(frame.buffer)) {
      throw new Error('not connected to the server');
    }
    this.#sent += bytes.byteLength;
  }

  #receive(payload) {
    if (payload.byteLength < 1) return;
    const view = new Uint8Array(payload);
    const kind = view[0];
    const body = payload.slice(1);

    this.#received += body.byteLength;
    if (this.#received - this.#ackedUpTo >= ACK_INTERVAL) {
      this.#ackedUpTo = this.#received;
      this.signaling.send({ type: 'relay-ack', session: this.session, bytes: this.#received });
    }

    if (kind === KIND_TEXT) {
      this.onMessage?.(decoder.decode(body));
    } else {
      this.onMessage?.(body);
    }
  }

  applyAck(bytes) {
    this.#acked = Math.max(this.#acked, bytes);
  }

  markClosed() {
    if (this.#closed) return;
    this.#closed = true;
    activeRelays.delete(this.session);
    this.signaling.offRelayData(this.session);
  }

  #writable() {
    return this.#sent - this.#acked <= CREDIT_WINDOW
      && this.signaling.bufferedAmount <= WS_HIGH_WATER;
  }

  // A WebSocket exposes no drain event, so writability is polled. The interval
  // is short enough that it never becomes the bottleneck on a LAN.
  waitUntilWritable() {
    if (this.#writable()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (this.#closed || !this.signaling.connected) {
          clearInterval(timer);
          reject(new Error('relay closed'));
        } else if (this.#writable()) {
          clearInterval(timer);
          resolve();
        }
      }, POLL_MS);
    });
  }

  /** Flushes the final ack so the sender sees the transfer complete. */
  flushAck() {
    if (this.#closed || this.#received === this.#ackedUpTo) return;
    this.#ackedUpTo = this.#received;
    this.signaling.send({ type: 'relay-ack', session: this.session, bytes: this.#received });
  }

  close() {
    if (this.#closed) return;
    this.signaling.send({ type: 'relay-close', session: this.session });
    this.markClosed();
  }
}
