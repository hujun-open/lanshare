// The direct path: a WebRTC data channel between two browsers.
//
// There is no client and no server here. ICE runs connectivity checks in both
// directions at once, and a pair validates as long as at least one side accepts
// an unsolicited inbound packet: the side that is blocked still gets through
// because its own outbound check creates the firewall state the reply needs.
// If neither side accepts inbound, no pair validates and the caller falls back
// to the relay.

export const HIGH_WATER = 8 * 1024 * 1024;
export const LOW_WATER = 1 * 1024 * 1024;

// How long to wait for a data channel before giving up on the direct path.
export const DIRECT_TIMEOUT_MS = 8000;

/** Wraps an RTCDataChannel in the transport shape the transfer engine expects. */
export class ChannelTransport {
  kind = 'direct';
  onMessage = null;

  constructor(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onmessage = (event) => this.onMessage?.(event.data);
  }

  get open() {
    return this.channel.readyState === 'open';
  }

  get bufferedAmount() {
    return this.channel.bufferedAmount;
  }

  send(data) {
    this.channel.send(data);
  }

  // Resolves once the channel has drained enough to accept more chunks. Without
  // this the send loop would queue an entire file into memory.
  waitUntilWritable() {
    if (this.channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    if (this.channel.readyState !== 'open') {
      return Promise.reject(new Error('data channel closed'));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.channel.removeEventListener('bufferedamountlow', onLow);
        this.channel.removeEventListener('close', onClose);
        this.channel.removeEventListener('error', onClose);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('data channel closed')); };
      this.channel.addEventListener('bufferedamountlow', onLow);
      this.channel.addEventListener('close', onClose);
      this.channel.addEventListener('error', onClose);
    });
  }

  close() {
    try { this.channel.close(); } catch { /* already gone */ }
  }
}

/**
 * Manages one RTCPeerConnection to a single remote peer.
 *
 * Emits: "open" (detail.transport), "failed", "statechange".
 */
export class DirectLink extends EventTarget {
  #pc = null;
  #transport = null;
  #makingOffer = false;
  #ignoreOffer = false;
  #closed = false;

  constructor({ selfId, peerId, signaling, iceServers }) {
    super();
    this.selfId = selfId;
    this.peerId = peerId;
    this.signaling = signaling;
    this.iceServers = iceServers ?? [];
    // Perfect negotiation needs one polite and one impolite peer, decided the
    // same way on both sides so simultaneous offers cannot deadlock.
    this.polite = selfId < peerId;
    this.candidateTypes = new Set();
  }

  get transport() {
    return this.#transport?.open ? this.#transport : null;
  }

  get connectionState() {
    return this.#pc?.connectionState ?? 'new';
  }

  start() {
    if (this.#pc || this.#closed) return;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.#pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.#makingOffer = true;
        await pc.setLocalDescription();
        this.#signal({ description: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        this.#makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.#recordCandidate(candidate);
      this.#signal({ candidate });
    };

    pc.onconnectionstatechange = () => {
      this.dispatchEvent(new CustomEvent('statechange', { detail: { state: pc.connectionState } }));
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.dispatchEvent(new CustomEvent('failed'));
      }
    };

    // A negotiated channel with a fixed ID means both sides can create it
    // independently and still end up with exactly one channel, no matter who
    // reached out first.
    const channel = pc.createDataChannel('lanshare', { negotiated: true, id: 0, ordered: true });
    channel.onopen = () => {
      this.#transport = new ChannelTransport(channel);
      this.dispatchEvent(new CustomEvent('open', { detail: { transport: this.#transport } }));
    };
    channel.onclose = () => {
      if (!this.#closed) this.dispatchEvent(new CustomEvent('failed'));
    };
    this.channel = channel;
  }

  #signal(payload) {
    this.signaling.send({ type: 'signal', to: this.peerId, payload });
  }

  #recordCandidate(candidate) {
    // Chrome hides LAN addresses behind random ".local" mDNS names unless a
    // srflx candidate is available, so the distinction matters when diagnosing
    // why a direct connection failed.
    if (candidate.address?.endsWith('.local')) {
      this.candidateTypes.add('mdns');
    } else if (candidate.type) {
      this.candidateTypes.add(candidate.type);
    }
  }

  /** Applies an offer, answer, or candidate received through the server. */
  async handleSignal(payload) {
    if (this.#closed) return;
    this.start();
    const pc = this.#pc;

    try {
      if (payload.description) {
        const description = payload.description;
        const collision = description.type === 'offer'
          && (this.#makingOffer || pc.signalingState !== 'stable');

        // Only the impolite peer refuses; the polite peer rolls back its own
        // offer and accepts the remote one, which breaks the tie.
        this.#ignoreOffer = !this.polite && collision;
        if (this.#ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.#signal({ description: pc.localDescription });
        }
      } else if (payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (err) {
          // Candidates arriving for an offer we discarded are expected.
          if (!this.#ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('signal handling failed', err);
    }
  }

  /** Reports the nominated candidate pair, used by the diagnostics view. */
  async selectedPair() {
    if (!this.#pc) return null;
    let stats;
    try {
      stats = await this.#pc.getStats();
    } catch {
      return null;
    }
    let pair = null;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        pair = report;
      }
    });
    if (!pair) return null;

    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      local: describeCandidate(local),
      remote: describeCandidate(remote),
      rtt: pair.currentRoundTripTime,
    };
  }

  close() {
    this.#closed = true;
    this.#transport?.close();
    try { this.#pc?.close(); } catch { /* already gone */ }
    this.#pc = null;
  }
}

function describeCandidate(candidate) {
  if (!candidate) return 'unknown';
  const address = candidate.address ?? candidate.ip ?? '?';
  return `${candidate.candidateType ?? '?'} ${address}:${candidate.port ?? '?'} (${candidate.protocol ?? '?'})`;
}
