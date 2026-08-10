// All DOM work lives here. Values that came from another peer are only ever
// written with textContent, never as HTML.

import { canStreamToDisk, safeFileName } from './transfer.js';

const DEVICE_ICONS = {
  desktop: '\u{1F5A5}\u{FE0F}',
  laptop: '\u{1F4BB}',
  phone: '\u{1F4F1}',
  tablet: '\u{1F4DF}',
};

const MAX_TRANSFER_ROWS = 40;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return 'almost done';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.ceil(seconds % 60)}s left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

const RELAY_EXPLANATION =
  'Going through the server because a firewall blocked the direct connection between the two devices.';

/** Clipboard API when allowed; execCommand fallback for plain HTTP LAN URLs. */
async function copyToClipboard(text, selectEl) {
  try {
    if (navigator.permissions?.query) {
      await navigator.permissions.query({ name: 'clipboard-write' });
    }
  } catch { /* permission name unsupported */ }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* fall through */ }
  }

  const range = document.createRange();
  range.selectNodeContents(selectEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('copy');
  sel.removeAllRanges();
  if (!ok) throw new Error('copy failed');
}

export class UI {
  #peers = new Map();
  #transfers = new Map();

  constructor(handlers) {
    this.handlers = handlers;

    this.statusEl = document.getElementById('status');
    this.selfNameEl = document.getElementById('self-name');
    this.selfSubnetEl = document.getElementById('self-subnet');
    this.gridEl = document.getElementById('peer-grid');
    this.emptyEl = document.getElementById('empty-state');
    this.urlsEl = document.getElementById('server-urls');
    this.transfersSection = document.getElementById('transfers-section');
    this.transferListEl = document.getElementById('transfer-list');
    this.inboxSection = document.getElementById('inbox-section');
    this.inboxListEl = document.getElementById('inbox-list');
    this.toastStack = document.getElementById('toast-stack');

    this.acceptDialog = document.getElementById('accept-dialog');
    this.textDialog = document.getElementById('text-dialog');

    this.tileTemplate = document.getElementById('peer-tile-template');
    this.transferTemplate = document.getElementById('transfer-item-template');

    this.selfNameEl.addEventListener('click', () => this.#renameSelf());

    // One hidden input, reused for every "send files" action.
    this.filePicker = document.createElement('input');
    this.filePicker.type = 'file';
    this.filePicker.multiple = true;
    this.filePicker.hidden = true;
    document.body.appendChild(this.filePicker);

    // Dropping a file anywhere other than a tile should do nothing rather than
    // navigating away from the page.
    for (const event of ['dragover', 'drop']) {
      document.addEventListener(event, (e) => e.preventDefault());
    }
  }

  // ------------------------------------------------------------- chrome

  setStatus(state) {
    const labels = {
      connecting: 'Connecting',
      reconnecting: 'Reconnecting',
      online: 'Connected',
      offline: 'Disconnected',
    };
    const classes = {
      connecting: 'status-connecting',
      reconnecting: 'status-connecting',
      online: 'status-online',
      offline: 'status-offline',
    };
    this.statusEl.textContent = labels[state] ?? state;
    this.statusEl.className = `status ${classes[state] ?? 'status-offline'}`;
  }

  setSelf(name, subnet) {
    this.selfNameEl.textContent = name;
    this.selfSubnetEl.textContent = subnet ? `on ${subnet}` : '';
  }

  setServerUrls(urls) {
    this.urlsEl.replaceChildren();
    for (const url of urls) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = url;
      li.appendChild(code);
      this.urlsEl.appendChild(li);
    }
  }

  #renameSelf() {
    const current = this.selfNameEl.textContent;
    const next = window.prompt('What should this device be called?', current);
    if (next === null) return;
    const trimmed = next.trim().slice(0, 40);
    if (!trimmed || trimmed === current) return;
    this.selfNameEl.textContent = trimmed;
    this.handlers.onRename(trimmed);
  }

  // -------------------------------------------------------------- peers

  upsertPeer(peer) {
    let entry = this.#peers.get(peer.id);
    if (!entry) {
      entry = this.#createTile(peer);
      this.#peers.set(peer.id, entry);
      this.gridEl.appendChild(entry.el);
    }
    entry.peer = peer;
    entry.nameEl.textContent = peer.name;
    entry.iconEl.textContent = DEVICE_ICONS[peer.device] ?? DEVICE_ICONS.desktop;
    this.#syncEmptyState();
  }

  removePeer(id) {
    const entry = this.#peers.get(id);
    if (!entry) return;
    entry.el.remove();
    this.#peers.delete(id);
    this.#syncEmptyState();
  }

  peerName(id) {
    return this.#peers.get(id)?.peer.name ?? 'the other device';
  }

  setPeerState(id, state) {
    const entry = this.#peers.get(id);
    if (!entry) return;
    const label = {
      idle: 'Ready',
      connecting: 'Connecting',
      direct: 'Direct',
      relay: 'Relayed',
      failed: 'Unreachable',
    }[state] ?? state;
    entry.badgeEl.textContent = label;
    entry.badgeEl.className = `peer-badge ${state}`;
    entry.badgeEl.title = state === 'relay' ? RELAY_EXPLANATION : '';
  }

  #createTile(peer) {
    const el = this.tileTemplate.content.firstElementChild.cloneNode(true);
    const nameEl = el.querySelector('[data-role="name"]');
    const iconEl = el.querySelector('[data-role="icon"]');
    const badgeEl = el.querySelector('[data-role="badge"]');
    const sendFilesBtn = el.querySelector('[data-role="send-files"]');
    const sendTextBtn = el.querySelector('[data-role="send-text"]');

    const pickFiles = () => {
      this.filePicker.value = '';
      this.filePicker.onchange = () => {
        if (this.filePicker.files.length) {
          this.handlers.onSendFiles(peer.id, this.filePicker.files);
        }
      };
      this.filePicker.click();
    };

    sendFilesBtn.addEventListener('click', (e) => { e.stopPropagation(); pickFiles(); });
    sendTextBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const body = await this.promptText(peer.id);
      if (body) this.handlers.onSendText(peer.id, body);
    });
    el.addEventListener('click', pickFiles);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); }
    });

    let dragDepth = 0;
    el.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth += 1;
      el.classList.add('dragover');
    });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('dragleave', () => {
      dragDepth -= 1;
      if (dragDepth <= 0) { dragDepth = 0; el.classList.remove('dragover'); }
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      el.classList.remove('dragover');
      if (e.dataTransfer?.files?.length) {
        this.handlers.onSendFiles(peer.id, e.dataTransfer.files);
      }
    });

    return { el, peer, nameEl, iconEl, badgeEl };
  }

  #syncEmptyState() {
    this.emptyEl.classList.toggle('hidden', this.#peers.size > 0);
  }

  // ---------------------------------------------------------- transfers

  transferStart({ id, direction, name, size, peerId, path }) {
    const el = this.transferTemplate.content.firstElementChild.cloneNode(true);
    const refs = {
      el,
      nameEl: el.querySelector('[data-role="name"]'),
      metaEl: el.querySelector('[data-role="meta"]'),
      barEl: el.querySelector('[data-role="bar"]'),
      detailEl: el.querySelector('[data-role="detail"]'),
      pathEl: el.querySelector('[data-role="path"]'),
    };
    const verb = direction === 'send' ? 'to' : 'from';
    refs.nameEl.textContent = name;
    refs.metaEl.textContent = `${formatBytes(size)} ${verb} ${this.peerName(peerId)}`;
    refs.detailEl.textContent = 'Starting';
    this.#setPathBadge(refs.pathEl, path);

    this.#transfers.set(id, refs);
    this.transferListEl.prepend(el);
    this.transfersSection.classList.remove('hidden');

    while (this.transferListEl.children.length > MAX_TRANSFER_ROWS) {
      this.transferListEl.lastElementChild.remove();
    }
  }

  transferProgress({ id, transferred, total, rate, eta, path }) {
    const refs = this.#transfers.get(id);
    if (!refs) return;
    const percent = total > 0 ? Math.min(100, (transferred / total) * 100) : 0;
    refs.barEl.style.width = `${percent}%`;
    const parts = [`${formatBytes(transferred)} of ${formatBytes(total)}`];
    if (rate) parts.push(formatRate(rate));
    const remaining = formatDuration(eta);
    if (remaining) parts.push(remaining);
    refs.detailEl.textContent = parts.join('  \u00B7  ');
    this.#setPathBadge(refs.pathEl, path);
  }

  transferDone({ id, direction, name }) {
    const refs = this.#transfers.get(id);
    if (!refs) return;
    refs.el.classList.add('done');
    refs.barEl.style.width = '100%';
    refs.detailEl.textContent = direction === 'send' ? 'Sent' : 'Saved';
    this.toast(`${direction === 'send' ? 'Sent' : 'Received'} ${name}`, 'success');
  }

  transferError({ id, name, error }) {
    const refs = this.#transfers.get(id);
    if (refs) {
      refs.el.classList.add('failed');
      refs.detailEl.textContent = error;
    }
    this.toast(`${name}: ${error}`, 'error');
  }

  #setPathBadge(el, path) {
    if (!path) return;
    el.textContent = path === 'relay' ? 'via server' : 'direct';
    el.className = `path-badge ${path}`;
    el.title = path === 'relay' ? RELAY_EXPLANATION : 'Peer-to-peer, not touching the server.';
  }

  // -------------------------------------------------------------- inbox

  addText(peerId, body, ts) {
    const item = document.createElement('li');
    item.className = 'inbox-item';

    const head = document.createElement('div');
    head.className = 'inbox-head';
    const who = document.createElement('span');
    who.className = 'muted small';
    const when = ts ? new Date(ts) : new Date();
    who.textContent = `From ${this.peerName(peerId)} at ${when.toLocaleTimeString()}`;
    const pre = document.createElement('pre');
    pre.className = 'inbox-body';
    pre.textContent = body;

    const copy = document.createElement('button');
    copy.className = 'button small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await copyToClipboard(body, pre);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch {
        this.toast('Clipboard access was blocked; select the text and copy it manually.', 'error');
      }
    });
    head.append(who, copy);

    item.append(head, pre);
    this.inboxListEl.prepend(item);
    this.inboxSection.classList.remove('hidden');
    this.toast(`Text received from ${this.peerName(peerId)}`, 'success');
  }

  // ------------------------------------------------------------ dialogs

  /**
   * Asks the user whether to accept a batch. When the browser can stream to
   * disk, the save location is picked here because the click that closes the
   * dialog is the user gesture the picker requires.
   */
  confirmIncoming(files, peerId) {
    const total = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    document.getElementById('accept-title').textContent =
      files.length === 1 ? 'Incoming file' : `Incoming files (${files.length})`;
    document.getElementById('accept-summary').textContent =
      `${this.peerName(peerId)} wants to send ${formatBytes(total)}.`;

    const list = document.getElementById('accept-files');
    list.replaceChildren();
    for (const file of files) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = formatBytes(file.size);
      li.append(name, size);
      list.appendChild(li);
    }

    return new Promise((resolve) => {
      const onClose = async () => {
        this.acceptDialog.removeEventListener('close', onClose);
        if (this.acceptDialog.returnValue !== 'accept') {
          resolve({ accepted: false });
          return;
        }
        let handle = null;
        if (files.length === 1 && canStreamToDisk()) {
          try {
            handle = await window.showSaveFilePicker({
              suggestedName: safeFileName(files[0].name),
            });
          } catch {
            // Cancelling the picker just means we assemble in memory instead.
            handle = null;
          }
        }
        resolve({ accepted: true, handle });
      };
      this.acceptDialog.returnValue = '';
      this.acceptDialog.addEventListener('close', onClose);
      this.acceptDialog.showModal();
    });
  }

  promptText(peerId) {
    document.getElementById('text-target').textContent = this.peerName(peerId);
    const body = document.getElementById('text-body');
    body.value = '';

    return new Promise((resolve) => {
      const onClose = () => {
        this.textDialog.removeEventListener('close', onClose);
        resolve(this.textDialog.returnValue === 'send' ? body.value : null);
      };
      this.textDialog.returnValue = '';
      this.textDialog.addEventListener('close', onClose);
      this.textDialog.showModal();
      body.focus();
    });
  }

  toast(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    this.toastStack.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}
