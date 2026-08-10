// Diagnostics: what this browser can gather, what the server sees, and whether
// the pieces that make a direct connection possible are actually working.

import { formatBytes } from './ui.js';
import { canStreamToDisk } from './transfer.js';

const REFRESH_MS = 3000;
const GATHER_TIMEOUT_MS = 6000;

const config = await fetchJSON('/config') ?? { iceServers: [] };

renderClientInfo();
runIceProbe();
refreshServer();
setInterval(refreshServer, REFRESH_MS);

document.getElementById('rerun').addEventListener('click', runIceProbe);

async function fetchJSON(path) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch {
    // Reported through the UI by the caller.
  }
  return null;
}

// ------------------------------------------------------------- ICE probe

/**
 * Gathers ICE candidates against the configured STUN server. This is the same
 * machinery a real connection uses, so what shows up here is what a peer would
 * have to work with.
 */
async function gatherCandidates(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.createDataChannel('probe');
  const candidates = [];

  const finished = new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) { done(); return; }
      candidates.push(candidate);
    };
  });

  await pc.setLocalDescription(await pc.createOffer());
  await finished;
  pc.close();
  return candidates;
}

async function runIceProbe() {
  const verdict = document.getElementById('ice-verdict');
  const rows = document.getElementById('ice-rows');
  verdict.className = 'verdict pending';
  verdict.textContent = 'Gathering ICE candidates\u2026';
  rows.replaceChildren();

  const candidates = await gatherCandidates(config.iceServers ?? []);

  let sawReflexive = false;
  let sawRealHost = false;
  let sawMdns = false;

  for (const candidate of candidates) {
    const address = candidate.address ?? '';
    const isMdns = address.endsWith('.local');
    if (candidate.type === 'srflx') sawReflexive = true;
    if (candidate.type === 'host' && isMdns) sawMdns = true;
    if (candidate.type === 'host' && !isMdns) sawRealHost = true;

    const tr = document.createElement('tr');
    for (const value of [isMdns ? 'host (mDNS)' : candidate.type, `${address}:${candidate.port ?? ''}`, candidate.protocol ?? '']) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    rows.appendChild(tr);
  }

  if (candidates.length === 0) {
    verdict.className = 'verdict warn';
    verdict.textContent = 'No ICE candidates at all. WebRTC looks blocked in this browser, so every transfer will be relayed through the server.';
  } else if (sawReflexive) {
    verdict.className = 'verdict good';
    verdict.textContent = 'STUN answered. Your browser has a real IP candidate, so a direct connection needs no multicast.';
  } else if (sawRealHost) {
    verdict.className = 'verdict good';
    verdict.textContent = 'Real host candidates are available, so peers can address this machine directly.';
  } else if (sawMdns) {
    verdict.className = 'verdict warn';
    verdict.textContent = 'Only mDNS candidates. STUN did not answer, so a direct connection depends on multicast UDP 5353 reaching the other machine.';
  } else {
    verdict.className = 'verdict warn';
    verdict.textContent = 'No usable local candidates were gathered.';
  }
}

// ----------------------------------------------------------------- panels

function renderClientInfo() {
  setKV('client-info', [
    ['Secure context', window.isSecureContext ? 'yes' : 'no (plain HTTP)'],
    ['Streaming saves', canStreamToDisk() ? 'available' : 'unavailable, files assemble in memory'],
    ['STUN configured', (config.iceServers?.length ?? 0) > 0 ? config.iceServers[0].urls.join(', ') : 'none'],
    ['Chunk size', formatBytes(config.chunkSize ?? 0)],
  ]);
}

async function refreshServer() {
  const diag = await fetchJSON('/api/diag');
  if (!diag) {
    setKV('server-info', [['Status', 'unreachable']]);
    return;
  }

  setKV('server-info', [
    ['Version', diag.version],
    ['LAN addresses', (diag.serverIPs ?? []).join(', ') || 'none found'],
    ['HTTP port', String(diag.httpPort)],
    ['STUN', diag.stunEnabled ? `UDP ${diag.stunPort}, ${diag.stunRequests} requests answered` : 'disabled'],
    ['TLS', diag.tls ? 'self-signed' : 'off'],
    ['Your address', diag.yourIp],
    ['Your room', diag.yourSubnet],
    ['Connected peers', String(diag.stats.peerCount)],
    ['Relay sessions', `${diag.stats.activeRelaySessions} active, ${diag.stats.totalRelaySessions} total`],
    ['Relayed bytes', formatBytes(diag.stats.relayBytes)],
  ]);

  renderRooms(diag.stats.rooms ?? []);
}

function renderRooms(rooms) {
  const host = document.getElementById('rooms');
  host.replaceChildren();
  if (rooms.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No peers connected.';
    host.appendChild(p);
    return;
  }
  for (const room of rooms) {
    const heading = document.createElement('h3');
    heading.textContent = room.subnet;
    const list = document.createElement('ul');
    for (const peer of room.peers) {
      const li = document.createElement('li');
      li.textContent = `${peer.name} (${peer.device})`;
      list.appendChild(li);
    }
    host.append(heading, list);
  }
}

function setKV(id, pairs) {
  const host = document.getElementById(id);
  host.replaceChildren();
  for (const [key, value] of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    host.append(dt, dd);
  }
}
