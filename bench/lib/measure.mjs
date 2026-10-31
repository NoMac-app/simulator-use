// What a tool's answer costs the agent, and the statistics the page reports.

/** Width and height of a PNG, JPEG or WebP image from its bytes, or null. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

// Anthropic's docs: an image costs about width * height / 750 tokens. Current models (Claude Opus 4.7 and later,
// Sonnet 5 and later) take up to 2576 px on the long edge and about 4784 tokens per image; a bigger image is
// scaled down first, keeping its aspect ratio.
export const IMAGE_MAX_EDGE = 2576;
export const IMAGE_MAX_TOKENS = 4784;
export function imageTokens(w, h) {
  if (!w || !h) return 0;
  let s = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h));
  let tw = w * s, th = h * s;
  const t = (tw * th) / 750;
  if (t > IMAGE_MAX_TOKENS) { const k = Math.sqrt(IMAGE_MAX_TOKENS / t); tw *= k; th *= k; }
  return Math.ceil((Math.floor(tw) * Math.floor(th)) / 750);
}

/** The proxy for text tokens when no token-counting API key is set: characters / 4. */
export const textTokensProxy = (chars) => Math.ceil(chars / 4);

/** Summarizes an MCP content array: the text the agent reads and the images it sees. */
export function describeContent(content = []) {
  const texts = [];
  const images = [];
  const other = [];
  for (const c of content) {
    if (c?.type === "text") texts.push(String(c.text ?? ""));
    else if (c?.type === "image" && typeof c.data === "string") {
      const buf = Buffer.from(c.data, "base64");
      const size = imageSize(buf);
      images.push({ mime: c.mimeType, bytes: buf.length, w: size?.w ?? null, h: size?.h ?? null });
    } else if (c?.type === "resource" && c.resource?.text) texts.push(String(c.resource.text));
    else other.push({ type: c?.type, keys: Object.keys(c ?? {}) });
  }
  const text = texts.join("\n");
  return { text, chars: text.length, images, other };
}

/** Proxy tokens of one recorded call: text chars / 4, images by Anthropic's formula, plus files the agent must open. */
export function callTokens(rec) {
  const text = textTokensProxy(rec.chars ?? 0);
  const images = (rec.images ?? []).reduce((s, i) => s + imageTokens(i.w, i.h), 0);
  const files = textTokensProxy(rec.fileChars ?? 0);
  return { text, images, files, total: text + images + files };
}

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** p90 by nearest rank: the smallest value with at least 90% of the values at or below it. */
export function p90(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil(0.9 * v.length) - 1)];
}
