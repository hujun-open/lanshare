// Turning a clipboard paste into a self-contained document.
//
// A page's markup only makes sense next to the server it came from: its images
// are absolute URLs, and the receiving device may have no route to that server
// at all, which is the normal case on an offline LAN. So every image is fetched
// here and embedded as a data: URI at paste time. What leaves this machine
// needs nothing from the network to render, which is also what lets the render
// frame run under default-src 'none'.

import { sanitizeHtml } from './sanitize.js';

// Per image, so one enormous hero image cannot eat the whole budget.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Whole document. Base64 costs a third on top of the raw bytes, and this is the
// number the receiver enforces before it agrees to take anything.
export const MAX_DOC_BYTES = 24 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 6;

// Content-Security-Policy for the render frame. Every image is already inlined,
// so nothing legitimate needs the network and everything else is denied.
export const SANDBOX_CSP = [
  "default-src 'none'",
  'img-src data:',
  'media-src data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "form-action 'none'",
].join('; ');

// Typography for the render frame. The frame is a separate document, so it
// inherits nothing from the app's stylesheet. It stays light in dark mode
// because pasted content usually assumes a white page and specifies only its
// text colour, which would otherwise be dark on dark.
const FRAME_CSS = `
html { color-scheme: light; }
body {
  margin: 12px; background: #fff; color: #111;
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow-wrap: break-word;
}
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; max-width: 100%; }
pre { white-space: pre-wrap; }
a { color: #1a56c4; }
`;

/** Reads every flavour of one paste that we know how to use. */
export function capturePaste(clipboardData) {
  if (!clipboardData) return { html: '', text: '', files: [] };
  const files = Array.from(clipboardData.files ?? [])
    .filter((file) => file.type.startsWith('image/'));
  return {
    html: clipboardData.getData('text/html') ?? '',
    text: clipboardData.getData('text/plain') ?? '',
    files,
  };
}

/**
 * Rewrites every image in `html` to a data: URI, dropping the ones that cannot
 * be embedded. Images already inlined by the source page are kept as they are.
 *
 * @returns {Promise<{html: string, inlined: number, dropped: number}>}
 */
export async function inlineImages(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images = Array.from(doc.querySelectorAll('img'));
  if (images.length === 0) return { html: doc.body.innerHTML, inlined: 0, dropped: 0 };

  // Markup counts against the budget too, so a huge table plus images cannot
  // slip past the cap between them.
  let used = doc.body.innerHTML.length;
  let inlined = 0;
  let dropped = 0;

  await mapLimit(images, FETCH_CONCURRENCY, async (img) => {
    const src = img.getAttribute('src') ?? '';

    if (src.startsWith('data:')) {
      if (used + src.length > MAX_DOC_BYTES) {
        img.remove();
        dropped += 1;
        return;
      }
      used += src.length;
      return;
    }

    let dataUri;
    try {
      dataUri = await fetchAsDataUri(src);
    } catch {
      img.remove();
      dropped += 1;
      return;
    }
    if (used + dataUri.length > MAX_DOC_BYTES) {
      img.remove();
      dropped += 1;
      return;
    }
    used += dataUri.length;
    img.setAttribute('src', dataUri);
    inlined += 1;
  });

  return { html: doc.body.innerHTML, inlined, dropped };
}

/** Reads a pasted image file, e.g. a screenshot, into an <img> tag. */
export async function imageFileToTag(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('image is too large to embed');
  const dataUri = await blobToDataUri(file);
  const img = document.createElement('img');
  img.src = dataUri;
  img.alt = file.name || 'pasted image';
  return img.outerHTML;
}

/** Wraps a sanitized fragment in a standalone document for a frame or a file. */
export function buildDocument(bodyHtml) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
<style>${FRAME_CSS}</style>
</head>
<body>${bodyHtml}</body></html>`;
}

/**
 * The whole paste pipeline: sanitize, embed images, sanitize again now that no
 * remote source is allowed to remain.
 *
 * @returns {Promise<{html: string, inlined: number, dropped: number}>}
 */
export async function prepareRichPaste(dirtyHtml) {
  const first = sanitizeHtml(dirtyHtml, { allowRemoteImages: true });
  if (!first) return { html: '', inlined: 0, dropped: 0 };
  const { html, inlined, dropped } = await inlineImages(first);
  return { html: sanitizeHtml(html), inlined, dropped };
}

async function fetchAsDataUri(url) {
  if (!/^https?:/i.test(url)) throw new Error('not an embeddable source');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Credentials are omitted so this never turns into an authenticated read of
    // something on the sender's network, and a cross-origin image without CORS
    // headers is simply unreadable, which is a drop rather than a failure.
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('image is too large to embed');
    return await blobToDataUri(blob);
  } finally {
    clearTimeout(timer);
  }
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('could not read the image'));
    reader.readAsDataURL(blob);
  });
}

/** Runs `worker` over `items` with a bounded number in flight. */
async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}
