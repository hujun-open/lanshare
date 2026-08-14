// Bootstrap and orchestration.
//
// For each peer in the roster there is one PeerLink, which owns the attempt at
// a direct WebRTC connection, the relay fallback, and the transfer state. The
// direct attempt starts as soon as a peer appears so the badge on its tile
// tells the truth before anyone tries to send anything.

import { Signaling } from './signaling.js';
import { DirectLink, DIRECT_TIMEOUT_MS } from './peer.js';
import { openRelaySession, handleRelayAck, handleRelayClose, RelayTransport } from './relay.js';
import { Conversation } from './transfer.js';
import { UI } from './ui.js';

const config = await loadConfig();
const identity = loadIdentity();

const ui = new UI({
  onSendFiles: (peerId, files) => sendFiles(peerId, files),
  onSendMessage: (peerId, message) => sendMessage(peerId, message),
  onRename: (name) => rename(name),
});

const signaling = new Signaling(identity);
const links = new Map();

ui.setServerUrls(shareUrls());
wireSignaling();
signaling.connect();

// --------------------------------------------------------------- identity

async function loadConfig() {
  try {
    const response = await fetch('/config', { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch {
    // Fall through to defaults; the page still works, just without STUN.
  }
  return { iceServers: [], serverIPs: [], httpPort: location.port, shareSuffix: '' };
}

function loadIdentity() {
  let id = localStorage.getItem('lanshare.id');
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('lanshare.id', id);
  }
  // Match the server's allowed alphabet so the ID survives the round trip.
  id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return {
    id,
    // An empty name lets the server assign a stable one derived from the ID.
    name: localStorage.getItem('lanshare.name') ?? '',
    device: detectDevice(),
  };
}

function detectDevice() {
  const ua = navigator.userAgent;
  if (/iPad|Android(?!.*Mobile)|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'phone';
  return 'desktop';
}

function rename(name) {
  identity.name = name;
  localStorage.setItem('lanshare.name', name);
  signaling.send({ type: 'hello', name });
}

function shareUrls() {
  const scheme = location.protocol.replace(':', '');
  const port = config.httpPort ?? location.port;
  const suffix = config.shareSuffix ?? '';
  return (config.serverIPs ?? []).map((ip) => `${scheme}://${ip}:${port}${suffix}`);
}

// -------------------------------------------------------------- signaling

function wireSignaling() {
  signaling.addEventListener('status', (e) => ui.setStatus(e.detail.state));

  signaling.addEventListener('welcome', (e) => {
    const { self, peers, room } = e.detail;
    ui.setSelf(self.name, room);
    if (!identity.name) identity.name = self.name;
    for (const peer of peers ?? []) addPeer(peer);
  });

  signaling.addEventListener('peer-join', (e) => addPeer(e.detail.peer));

  signaling.addEventListener('peer-leave', (e) => {
    const id = e.detail.id;
    ui.removePeer(id);
    links.get(id)?.dispose('the other device disconnected');
    links.delete(id);
  });

  signaling.addEventListener('signal', (e) => {
    linkFor(e.detail.from).handleSignal(e.detail.payload);
  });

  signaling.addEventListener('relay-incoming', (e) => {
    linkFor(e.detail.from).attachIncomingRelay(e.detail.session);
  });

  signaling.addEventListener('relay-ack', (e) => handleRelayAck(e.detail.session, e.detail.bytes));
  signaling.addEventListener('relay-close', (e) => handleRelayClose(e.detail.session));
  signaling.addEventListener('error', (e) => ui.toast(e.detail.error, 'error'));
}

function addPeer(peer) {
  if (!peer) return;
  ui.upsertPeer(peer);
  linkFor(peer.id).warmUp();
}

function linkFor(peerId) {
  let link = links.get(peerId);
  if (!link) {
    link = new PeerLink(peerId);
    links.set(peerId, link);
  }
  return link;
}

// ------------------------------------------------------------------ links

class PeerLink {
  #direct = null;
  #directReady = null;
  #relay = null;
  #pending = null;
  #state = 'idle';

  constructor(peerId) {
    this.peerId = peerId;
    this.conversation = new Conversation({
      peerId,
      acquireTransport: () => this.acquire(),
      confirmIncoming: (files) => ui.confirmIncoming(files, peerId),
      confirmDoc: (size) => ui.confirmDoc(size, peerId),
    });

    this.conversation.addEventListener('transfer-start', (e) => ui.transferStart(e.detail));
    this.conversation.addEventListener('transfer-progress', (e) => ui.transferProgress(e.detail));
    this.conversation.addEventListener('transfer-done', (e) => ui.transferDone(e.detail));
    this.conversation.addEventListener('transfer-error', (e) => ui.transferError(e.detail));
    this.conversation.addEventListener('text', (e) => ui.addText(e.detail.peerId, e.detail.body, e.detail.ts));
    this.conversation.addEventListener('rich', (e) => ui.addRich(e.detail.peerId, e.detail));
    this.conversation.addEventListener('declined', () => {
      ui.toast(`${ui.peerName(peerId)} declined the transfer.`);
    });
  }

  #setState(state) {
    this.#state = state;
    ui.setPeerState(this.peerId, state);
  }

  /** Starts the direct attempt early so the tile can report the real path. */
  warmUp() {
    if (this.#direct) return;
    this.#setState('connecting');
    this.#startDirect();
    this.#directReady.then((transport) => {
      if (!transport && this.#state !== 'direct') this.#setState('relay');
    });
  }

  #startDirect() {
    if (this.#direct) return;

    this.#direct = new DirectLink({
      selfId: identity.id,
      peerId: this.peerId,
      signaling,
      iceServers: config.iceServers ?? [],
    });

    this.#directReady = new Promise((resolve) => {
      let settled = false;
      const finish = (transport) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(transport);
      };
      // ICE gets a bounded window. If no candidate pair validates in that time,
      // a firewall is almost certainly dropping the checks and the relay is the
      // only way through.
      const timer = setTimeout(() => finish(null), DIRECT_TIMEOUT_MS);

      this.#direct.addEventListener('open', (e) => {
        // A direct channel may also open after the deadline, in which case it
        // still upgrades the badge and gets used for the next transfer.
        this.conversation.attach(e.detail.transport);
        this.#setState('direct');
        finish(e.detail.transport);
      });
      this.#direct.addEventListener('failed', () => finish(null));
    });

    this.#direct.start();
  }

  handleSignal(payload) {
    this.#startDirect();
    this.#direct.handleSignal(payload);
  }

  attachIncomingRelay(session) {
    const relay = new RelayTransport({ signaling, session, peerId: this.peerId });
    this.#relay = relay;
    this.conversation.attach(relay);
    if (this.#state !== 'direct') this.#setState('relay');
  }

  /** Resolves the transport a transfer should use, preferring the direct path. */
  acquire() {
    const direct = this.#direct?.transport;
    if (direct) return Promise.resolve(direct);
    if (this.#relay?.open) return Promise.resolve(this.#relay);
    if (this.#pending) return this.#pending;

    this.#pending = this.#connect().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #connect() {
    this.#startDirect();
    if (this.#state === 'idle') this.#setState('connecting');

    const direct = await this.#directReady;
    if (direct?.open) return direct;

    if (this.#relay?.open) return this.#relay;

    const relay = await openRelaySession(signaling, this.peerId);
    this.#relay = relay;
    this.conversation.attach(relay);
    this.#setState('relay');
    return relay;
  }

  /** Reports the nominated ICE candidate pair, for the diagnostics readout. */
  selectedPair() {
    return this.#direct?.selectedPair() ?? Promise.resolve(null);
  }

  dispose(reason) {
    this.conversation.abortAll(reason);
    this.#direct?.close();
    this.#relay?.close();
    this.#direct = null;
    this.#relay = null;
  }
}

// --------------------------------------------------------------- actions

async function sendFiles(peerId, files) {
  try {
    await linkFor(peerId).conversation.sendFiles(files);
  } catch (err) {
    ui.toast(err.message, 'error');
  }
}

/** A composed message: formatted when the user pasted rich content, else text. */
async function sendMessage(peerId, { text, html }) {
  const conversation = linkFor(peerId).conversation;
  try {
    if (html) {
      await conversation.sendDoc({ html, text });
      ui.toast(`Formatted text sent to ${ui.peerName(peerId)}`, 'success');
      return;
    }
    await conversation.sendText(text);
    ui.toast(`Text sent to ${ui.peerName(peerId)}`, 'success');
  } catch (err) {
    ui.toast(err.message, 'error');
  }
}

window.addEventListener('beforeunload', () => {
  for (const link of links.values()) link.dispose('page closed');
  signaling.stop();
});
