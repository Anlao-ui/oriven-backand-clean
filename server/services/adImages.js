// ════════════════════════════════════════════════════════════════
// Ad image preparation for publishing.
//
// Platforms have exact image rules (Google: landscape marketing images must
// be 1.91:1 ±1%, logos and square images 1:1 ±1%); generated images come in
// a few fixed sizes (1024×1024, 1536×1024, 1024×1536). This module turns
// what OrivenAI has into what each platform accepts — by cropping/padding,
// never by stretching — and reports the result so validation can be exact.
// ════════════════════════════════════════════════════════════════
const sharp = require('sharp');

const MAX_BYTES = 20 * 1024 * 1024;

// Bytes from an https URL, a data: URI or raw base64 (some providers return
// b64_json instead of a URL).
async function fetchImage(src) {
  if (!src) throw new Error('No image to upload');
  const s = String(src);
  if (s.startsWith('data:')) {
    const m = /^data:[^;,]+;base64,(.*)$/s.exec(s);
    if (!m) throw new Error('Unsupported image data');
    return Buffer.from(m[1], 'base64');
  }
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s);
    if (!r.ok) throw Object.assign(new Error('Could not download the campaign image (HTTP ' + r.status + '). Generate or upload it again.'), { status: 422 });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('The campaign image is larger than 20 MB.');
    return buf;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100) return Buffer.from(s, 'base64');
  throw new Error('Unsupported image reference');
}

async function info(buf) {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, format: m.format, ratio: m.width / m.height };
}

// Centre crop to an exact aspect ratio (e.g. 1.91 for Google landscape),
// then scale down to a sensible size. Output JPEG (photos) — small and
// accepted everywhere.
async function cropToRatio(buf, ratio, maxWidth) {
  const m = await sharp(buf).metadata();
  let w = m.width, h = Math.round(m.width / ratio);
  if (h > m.height) { h = m.height; w = Math.round(m.height * ratio); }
  const left = Math.floor((m.width - w) / 2), top = Math.floor((m.height - h) / 2);
  let img = sharp(buf).extract({ left, top, width: w, height: h });
  if (maxWidth && w > maxWidth) img = img.resize({ width: maxWidth, height: Math.round(maxWidth / ratio) });
  const out = await img.jpeg({ quality: 90 }).toBuffer();
  return { buffer: out, info: await info(out) };
}

// Square logo: pad (never crop) a logo of any shape onto a square canvas,
// white background, PNG. maxSide keeps it within platform byte limits.
async function squareLogo(buf, maxSide) {
  const m = await sharp(buf).metadata();
  const side = Math.min(Math.max(m.width, m.height), maxSide || 1200);
  const out = await sharp(buf)
    .resize({ width: side, height: side, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
  return { buffer: out, info: await info(out) };
}

// Square marketing image: centre crop to 1:1 if needed.
async function square(buf, maxSide) {
  const m = await sharp(buf).metadata();
  if (Math.abs(m.width / m.height - 1) <= 0.01 && (!maxSide || m.width <= maxSide)) return { buffer: buf, info: await info(buf) };
  return cropToRatio(buf, 1, maxSide || 1200);
}

const withinRatio = (i, ratio, tol) => Math.abs(i.ratio - ratio) / ratio <= (tol == null ? 0.01 : tol);

module.exports = { fetchImage, info, cropToRatio, squareLogo, square, withinRatio };
