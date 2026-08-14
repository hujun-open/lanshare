// All DOM work lives here. Values that came from another peer are only ever
// written with textContent, never as HTML.
//
// Formatted messages are the one exception, and they are kept at arm's length:
// the markup is sanitized again on arrival and then rendered inside an iframe
// with no allow-scripts and no allow-same-origin, so it runs no code and cannot
// see this page. It is never inserted into this document.

import { canStreamToDisk, safeFileName, triggerDownload } from './transfer.js';
import { hasFormatting, sanitizeHtml } from './sanitize.js';
import { buildDocument, capturePaste, imageFileToTag, prepareRichPaste } from './rich.js';

const DEVICE_ICONS = {
  desktop: '\u{1F5A5}\u{FE0F}',
  laptop: '\u{1F4BB}',
  phone: '\u{1F4F1}',
  tablet: '\u{1F4DF}',
};

const MAX_TRANSFER_ROWS = 40;

// A pasted message under this size gets no row in the transfer list: it behaves
// like a message, and the inbox item it produces is the feedback that matters.
const QUIET_DOC_BYTES = 256 * 1024;

// How much markup the source view will show before it stops being useful.
const SOURCE_VIEW_LIMIT = 200 * 1024;

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

/** Puts both flavours on the clipboard so a paste elsewhere keeps formatting. */
async function copyRichToClipboard(html, text) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    return;
  }
  // Off a secure context there is no rich clipboard at all, so plain text is
  // the most that can be offered.
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('no clipboard access');
}

/**
 * Inserts already-sanitized markup at the caret. execCommand is deprecated but
 * is still the only way to leave the browser's own undo history intact.
 */
function insertHtmlAtCaret(el, html) {
  el.focus();
  try {
    if (document.execCommand('insertHTML', false, html)) return;
  } catch { /* fall through to the manual path */ }

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fragment = document.createDocumentFragment();
  for (const node of Array.from(parsed.body.childNodes)) {
    fragment.appendChild(document.importNode(node, true));
  }
  insertNodeAtCaret(el, fragment);
}

function insertTextAtCaret(el, text) {
  if (!text) return;
  el.focus();
  try {
    if (document.execCommand('insertText', false, text)) return;
  } catch { /* fall through to the manual path */ }
  // The composer is styled with pre-wrap, so newlines in a text node render.
  insertNodeAtCaret(el, document.createTextNode(text));
}

function insertNodeAtCaret(el, node) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !el.contains(range.commonAncestorContainer)) {
    el.appendChild(node);
    return;
  }
  range.deleteContents();
  range.insertNode(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function button(label, onClick) {
  const el = document.createElement('button');
  el.className = 'button small';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function flash(el, label) {
  const original = el.textContent;
  el.textContent = label;
  setTimeout(() => { el.textContent = original; }, 1500);
}

function fileStamp(ts) {
  return new Date(ts ?? Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export class UI {
  #peers = new Map();
  #transfers = new Map();
  // Pastes are embedded asynchronously, so sending is held back until every
  // one of them has settled.
  #pastesInFlight = 0;
  #composerNote = '';
  #composerResult = null;

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

    this.composerEl = document.getElementById('text-body');
    this.composerNoteEl = document.getElementById('text-note');
    this.textSendBtn = document.getElementById('text-send');
    this.clearFormatBtn = document.getElementById('text-clear-format');

    this.selfNameEl.addEventListener('click', () => this.#renameSelf());
    this.#wireComposer();

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
      const message = await this.promptText(peer.id);
      if (message) this.handlers.onSendMessage(peer.id, message);
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

  transferStart({ id, direction, name, size, peerId, path, role }) {
    // A short pasted message is a message, not a transfer. The inbox item it
    // produces is the feedback that matters, so a progress row would be noise.
    if (role === 'doc' && size < QUIET_DOC_BYTES) return;

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

  transferDone({ id, direction, name, role }) {
    const refs = this.#transfers.get(id);
    if (!refs) return;
    refs.el.classList.add('done');
    refs.barEl.style.width = '100%';
    if (direction === 'send') refs.detailEl.textContent = 'Sent';
    else refs.detailEl.textContent = role === 'doc' ? 'Shown below' : 'Saved';
    // A message announces itself when it is sent or when it appears in the
    // inbox, so a second toast about the transfer behind it is just noise.
    if (role === 'doc') return;
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

  #inboxItem(peerId, ts) {
    const item = document.createElement('li');
    item.className = 'inbox-item';

    const head = document.createElement('div');
    head.className = 'inbox-head';
    const who = document.createElement('span');
    who.className = 'muted small';
    const when = ts ? new Date(ts) : new Date();
    who.textContent = `From ${this.peerName(peerId)} at ${when.toLocaleTimeString()}`;

    const actions = document.createElement('div');
    actions.className = 'inbox-actions';
    head.append(who, actions);
    item.append(head);

    return { item, actions };
  }

  #showInboxItem(item) {
    this.inboxListEl.prepend(item);
    this.inboxSection.classList.remove('hidden');
  }

  addText(peerId, body, ts) {
    const { item, actions } = this.#inboxItem(peerId, ts);

    const pre = document.createElement('pre');
    pre.className = 'inbox-body';
    pre.textContent = body;

    const copy = button('Copy', async () => {
      try {
        await copyToClipboard(body, pre);
        flash(copy, 'Copied');
      } catch {
        this.toast('Clipboard access was blocked; select the text and copy it manually.', 'error');
      }
    });
    actions.append(copy);

    item.append(pre);
    this.#showInboxItem(item);
    this.toast(`Text received from ${this.peerName(peerId)}`, 'success');
  }

  /**
   * Renders a formatted message. The markup was sanitized by the sender, which
   * proves nothing, so it is sanitized again here and then handed to an iframe
   * that has neither allow-scripts nor allow-same-origin: an opaque origin with
   * scripting off, under a default-src 'none' policy. Popups are the one thing
   * allowed, so that a link the reader clicks can still open in a real tab.
   */
  addRich(peerId, { html, text, ts }) {
    const safe = sanitizeHtml(html);
    if (!safe) {
      // Nothing survived sanitizing, so the plain alternative is all there is.
      this.addText(peerId, text ?? '', ts);
      return;
    }

    const { item, actions } = this.#inboxItem(peerId, ts);

    const frame = document.createElement('iframe');
    frame.className = 'rich-frame';
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = `Formatted message from ${this.peerName(peerId)}`;
    frame.srcdoc = buildDocument(safe);

    const source = document.createElement('pre');
    source.className = 'inbox-body hidden';
    // Filled on demand: with images inlined the markup runs to megabytes, and
    // laying all of that out as text costs more than it is worth up front.
    const fillSource = () => {
      if (source.textContent) return;
      source.textContent = safe.length > SOURCE_VIEW_LIMIT
        ? `${safe.slice(0, SOURCE_VIEW_LIMIT)}\n\u2026 truncated, use Save as .html for all of it`
        : safe;
    };

    const copy = button('Copy', async () => {
      try {
        await copyRichToClipboard(safe, text ?? '');
        flash(copy, 'Copied');
      } catch {
        fillSource();
        source.classList.remove('hidden');
        this.toast('Clipboard access was blocked; the source is shown below to copy by hand.', 'error');
      }
    });

    const save = button('Save as .html', () => {
      triggerDownload(
        new Blob([buildDocument(safe)], { type: 'text/html' }),
        `pasted-${fileStamp(ts)}.html`,
      );
    });

    // Nothing scripts inside the frame, so its content cannot report how tall it
    // is. It gets a fixed box that scrolls, and a taller one on request.
    const expand = button('Expand', () => {
      const tall = frame.classList.toggle('tall');
      expand.textContent = tall ? 'Shrink' : 'Expand';
    });

    const viewSource = button('Source', () => {
      fillSource();
      const hidden = source.classList.toggle('hidden');
      viewSource.textContent = hidden ? 'Source' : 'Hide source';
    });

    actions.append(copy, save, expand, viewSource);
    item.append(frame, source);
    this.#showInboxItem(item);
    this.toast(`Formatted text received from ${this.peerName(peerId)}`, 'success');
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

  /**
   * Asks about a large formatted message. Small ones are accepted without a
   * prompt, but once embedded images make it file-sized it deserves the same
   * question a file gets. Never picks a save location: it is rendered, not
   * written to disk.
   */
  confirmDoc(size, peerId) {
    document.getElementById('accept-title').textContent = 'Incoming formatted text';
    document.getElementById('accept-summary').textContent =
      `${this.peerName(peerId)} wants to send ${formatBytes(size)} of formatted text and embedded images.`;
    document.getElementById('accept-files').replaceChildren();

    return new Promise((resolve) => {
      const onClose = () => {
        this.acceptDialog.removeEventListener('close', onClose);
        resolve(this.acceptDialog.returnValue === 'accept');
      };
      this.acceptDialog.returnValue = '';
      this.acceptDialog.addEventListener('close', onClose);
      this.acceptDialog.showModal();
    });
  }

  // ----------------------------------------------------------- composer

  #wireComposer() {
    this.composerEl.addEventListener('paste', (e) => this.#onComposerPaste(e));
    this.composerEl.addEventListener('input', () => this.#renderComposerState());
    this.composerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.textSendBtn.click();
      }
    });

    this.clearFormatBtn.addEventListener('click', () => {
      const plain = this.composerEl.innerText;
      this.composerEl.textContent = plain;
      this.#composerNote = '';
      this.#renderComposerState();
      this.composerEl.focus();
    });

    // The content has to be read while the dialog is still on screen: innerText
    // depends on layout, and once the dialog closes it collapses to the
    // textContent of the whole thing with every line break lost.
    this.textSendBtn.addEventListener('click', () => {
      this.#composerResult = this.#readComposer();
    });
  }

  /**
   * Everything that lands in the composer comes through here, so nothing
   * unvetted is ever inserted into this page. The clipboard's HTML flavour is
   * sanitized and has its images embedded; a screenshot arrives as a file with
   * no HTML at all; anything else is inserted as plain text.
   */
  async #onComposerPaste(event) {
    event.preventDefault();
    const { html, text, files } = capturePaste(event.clipboardData);

    if (!html && files.length > 0) {
      await this.#whilePreparing(async () => {
        for (const file of files) {
          try {
            insertHtmlAtCaret(this.composerEl, await imageFileToTag(file));
          } catch (err) {
            this.toast(`That image could not be pasted: ${err.message}`, 'error');
          }
        }
        return true;
      });
      return;
    }

    if (html) {
      const inserted = await this.#whilePreparing(async () => {
        const prepared = await prepareRichPaste(html);
        if (!prepared.html) return false;
        insertHtmlAtCaret(this.composerEl, prepared.html);
        this.#composerNote = prepared.dropped > 0
          ? `${prepared.dropped} image${prepared.dropped === 1 ? '' : 's'} could not be embedded and ${prepared.dropped === 1 ? 'was' : 'were'} left out.`
          : '';
        return true;
      });
      if (inserted) return;
    }

    insertTextAtCaret(this.composerEl, text);
    this.#renderComposerState();
  }

  async #whilePreparing(work) {
    this.#pastesInFlight += 1;
    this.#renderComposerState();
    try {
      return await work();
    } catch (err) {
      this.toast(`That paste could not be prepared: ${err.message}`, 'error');
      return false;
    } finally {
      this.#pastesInFlight -= 1;
      this.#renderComposerState();
    }
  }

  #renderComposerState() {
    const busy = this.#pastesInFlight > 0;
    this.composerNoteEl.textContent = busy ? 'Embedding images\u2026' : this.#composerNote;
    this.textSendBtn.disabled = busy;
    this.clearFormatBtn.classList.toggle('hidden', !hasFormatting(this.composerEl));
  }

  /** Snapshot of the composer: `html` is null when the content is plain text. */
  #readComposer() {
    const el = this.composerEl;
    // Word and browsers paste plenty of non-breaking spaces, which look like
    // ordinary spaces but survive as U+00A0 in the plain-text alternative.
    const text = el.innerText.replace(/\u00a0/g, ' ');
    if (!hasFormatting(el)) {
      return text.trim() ? { text, html: null } : null;
    }
    // Sanitized once more on the way out. What is in the editor was vetted on
    // paste, but this is the copy that leaves the machine.
    const html = sanitizeHtml(el.innerHTML);
    if (!html) return text.trim() ? { text, html: null } : null;
    return { text, html };
  }

  /** Resolves `{ text, html }`, or null when nothing was sent. */
  promptText(peerId) {
    document.getElementById('text-target').textContent = this.peerName(peerId);
    this.composerEl.replaceChildren();
    this.#composerNote = '';
    this.#composerResult = null;
    this.#renderComposerState();

    return new Promise((resolve) => {
      const onClose = () => {
        this.textDialog.removeEventListener('close', onClose);
        resolve(this.textDialog.returnValue === 'send' ? this.#composerResult : null);
      };
      this.textDialog.returnValue = '';
      this.textDialog.addEventListener('close', onClose);
      this.textDialog.showModal();
      this.composerEl.focus();
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
