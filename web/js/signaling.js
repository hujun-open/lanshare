// Control channel to the server: peer discovery, WebRTC signaling, and the
// relay fallback all share this one WebSocket.
//
// Text frames are JSON control messages. Binary frames are relay payload,
// prefixed with a 4-byte big-endian session ID that selects which relay
// transport should receive them.

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

export const RELAY_HEADER_BYTES = 4;

export class Signaling extends EventTarget {
  #ws = null;
  #attempt = 0;
  #timer = null;
  #stopped = false;
  #binaryHandlers = new Map();

  constructor(identity) {
    super();
    this.identity = identity;
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount() {
    return this.#ws ? this.#ws.bufferedAmount : 0;
  }

  connect() {
    this.#stopped = false;
    this.#open();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
  }

  #url() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({
      id: this.identity.id,
      name: this.identity.name,
      device: this.identity.device,
    });
    return `${scheme}://${location.host}/ws?${params}`;
  }

  #open() {
    this.#emit('status', { state: this.#attempt === 0 ? 'connecting' : 'reconnecting' });

    const ws = new WebSocket(this.#url());
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      this.#emit('status', { state: 'online' });
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.#emit(msg.type, msg);
        return;
      }
      this.#routeBinary(event.data);
    };

    ws.onclose = () => {
      this.#ws = null;
      this.#emit('status', { state: 'offline' });
      if (this.#stopped) return;
      // Exponential backoff, capped, so a server restart is picked up quickly
      // without hammering it while it is down.
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempt, RECONNECT_MAX_MS);
      this.#attempt += 1;
      this.#timer = setTimeout(() => this.#open(), delay);
    };

    ws.onerror = () => ws.close();
  }

  #routeBinary(buffer) {
    if (buffer.byteLength < RELAY_HEADER_BYTES) return;
    const session = new DataView(buffer).getUint32(0, false);
    const handler = this.#binaryHandlers.get(session);
    if (handler) handler(buffer.slice(RELAY_HEADER_BYTES));
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  send(message) {
    if (!this.connected) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  sendBinary(buffer) {
    if (!this.connected) return false;
    this.#ws.send(buffer);
    return true;
  }

  onRelayData(session, handler) {
    this.#binaryHandlers.set(session, handler);
  }

  offRelayData(session) {
    this.#binaryHandlers.delete(session);
  }
}
