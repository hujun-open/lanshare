// Allowlist sanitizer for pasted markup. No dependencies, no build step.
//
// This runs twice on every rich message, and neither pass trusts the other: on
// paste, because the composer is part of this page and must never hold anything
// executable, and again on arrival, because a peer's word for it is worth
// nothing. Rendering happens in a scriptless sandboxed iframe on top of that,
// so a miss here is still not a way to run code.
//
// Anything not named here is unwrapped rather than deleted, which keeps the
// text of Word's <o:p> and similar vendor tags while discarding the tag itself.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'hr', 'center', 'font',
  'article', 'section', 'header', 'footer', 'main', 'aside', 'nav',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark',
  'small', 'sub', 'sup', 'abbr', 'cite', 'q', 'time', 'var',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption',
]);

// Removed with everything inside them. <style> is on this list because a pasted
// style sheet would apply to the whole LanShare page while the content sits in
// the composer, which is enough to hide or repaint the app's own UI. Chrome and
// Word both put the formatting that matters into style attributes anyway.
const DROP_SUBTREE = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'meta', 'base', 'title', 'noscript', 'template',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'label',
  'fieldset', 'legend', 'svg', 'math', 'video', 'audio', 'source', 'track',
  'canvas', 'map', 'area', 'dialog', 'slot', 'portal',
]);

const GLOBAL_ATTRS = new Set(['style', 'title', 'dir', 'lang', 'align', 'valign']);

// Per-tag extras. `class` and `id` are deliberately absent everywhere: while the
// content is in the composer it shares a stylesheet with the app, and a pasted
// class="hidden" would silently blank it.
const TAG_ATTRS = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  table: ['border', 'cellpadding', 'cellspacing', 'width'],
  time: ['datetime'],
  q: ['cite'],
  blockquote: ['cite'],
  font: ['color', 'face', 'size'],
};

const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// Declarations carrying any of these are dropped outright. A url() is only kept
// when it is already a data: URI, so nothing in rendered content can reach the
// network and report that it was read.
const CSS_BLOCKED = /expression\s*\(|behavior\s*:|-moz-binding|javascript:|@import/i;
const CSS_URL = /url\(/i;
const CSS_DATA_URL = /url\(\s*['"]?data:/i;

// position: fixed or sticky would escape the box the content is rendered in.
const CSS_ESCAPES_BOX = /^(position|z-index)$/i;

/**
 * Returns safe HTML for the body of `dirty`, or '' when nothing usable is left.
 *
 * @param {string} dirty markup from a clipboard or a peer
 * @param {object} [options]
 * @param {boolean} [options.allowRemoteImages] keep http(s) image sources, which
 *   is only wanted between capturing a paste and inlining its images
 * @returns {string}
 */
export function sanitizeHtml(dirty, { allowRemoteImages = false } = {}) {
  if (typeof dirty !== 'string' || !dirty.trim()) return '';

  let doc;
  try {
    // text/html always yields a whole document, so a bare fragment and a full
    // page copied from a browser both end up reachable through body.
    doc = new DOMParser().parseFromString(dirty, 'text/html');
  } catch {
    return '';
  }
  if (!doc?.body) return '';

  cleanChildren(doc.body, { allowRemoteImages });
  return doc.body.innerHTML.trim();
}

// What typing plain text into a contenteditable region produces on its own.
const PLAIN_TAGS = new Set(['DIV', 'P', 'BR']);

/** True when `root` holds anything beyond plain text and line breaks. */
export function hasFormatting(root) {
  for (const el of root.querySelectorAll('*')) {
    if (!PLAIN_TAGS.has(el.tagName)) return true;
    if (el.attributes.length > 0) return true;
  }
  return false;
}

function cleanChildren(parent, options) {
  // Static copy: the walk moves and removes nodes as it goes.
  for (const node of Array.from(parent.childNodes)) {
    cleanNode(node, options);
  }
}

function cleanNode(node, options) {
  if (node.nodeType === Node.TEXT_NODE) return;

  if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
    node.remove();
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.remove();
    return;
  }

  const tag = node.localName;

  if (DROP_SUBTREE.has(tag)) {
    node.remove();
    return;
  }

  cleanChildren(node, options);

  if (!ALLOWED_TAGS.has(tag)) {
    unwrap(node);
    return;
  }

  cleanAttributes(node, tag, options);

  if (tag === 'img' && !node.getAttribute('src')) {
    node.remove();
  }
}

/** Replaces an element with its children, keeping the text it wrapped. */
function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

function cleanAttributes(el, tag, options) {
  const extra = TAG_ATTRS[tag] ?? [];

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!GLOBAL_ATTRS.has(name) && !extra.includes(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style') {
      const style = cleanStyle(attr.value);
      if (style) el.setAttribute('style', style);
      else el.removeAttribute('style');
    }
  }

  if (tag === 'a') {
    const href = safeUrl(el.getAttribute('href'));
    if (href) {
      el.setAttribute('href', href);
      // The render frame has no allow-same-origin, so a link that navigates the
      // frame itself would strand the content; open a real tab instead.
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else {
      el.removeAttribute('href');
    }
  }

  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const remoteOk = options.allowRemoteImages && isHttpUrl(src);
    if (!isDataImage(src) && !remoteOk) el.removeAttribute('src');
    for (const dimension of ['width', 'height']) {
      const value = el.getAttribute(dimension);
      if (value !== null && !/^\d+$/.test(value.trim())) el.removeAttribute(dimension);
    }
  }
}

/** Drops declarations that could execute, load, or escape the render box. */
export function cleanStyle(value) {
  if (typeof value !== 'string' || !value) return '';
  const kept = [];
  for (const declaration of value.split(';')) {
    const text = declaration.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon <= 0) continue;
    const property = text.slice(0, colon).trim();
    if (CSS_BLOCKED.test(text)) continue;
    if (CSS_ESCAPES_BOX.test(property)) continue;
    if (CSS_URL.test(text) && !CSS_DATA_URL.test(text)) continue;
    kept.push(`${property}: ${text.slice(colon + 1).trim()}`);
  }
  return kept.join('; ');
}

function safeUrl(value) {
  if (!value) return null;
  let url;
  try {
    // Relative links have no meaning once the markup has left its page, so
    // parsing without a base drops them along with the unsafe schemes.
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  return SAFE_LINK_SCHEMES.has(url.protocol) ? url.href : null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isDataImage(value) {
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(String(value).trim());
}
