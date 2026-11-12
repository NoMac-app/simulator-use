/**
 * A fragmented MP4 made a plain one, without decoding anything: what a recording on a NoMac phone streams (the
 * engine's `stream` op, `transport: fmp4`) is whole up to its last frame whenever it ends, but its fragments are
 * read only by some players (ffmpeg's and Chrome's, never AVFoundation's: QuickTime and Safari refuse it). The plain
 * MP4 has the same samples, one video track, a movie box before the data (it plays while it downloads) and an index
 * of every frame, so every player opens and seeks it.
 *
 * One video track, as the engine writes it (a moof and an mdat per frame); a fragment cut off by the recorder's end
 * is left out. Anything else is refused with FragmentError rather than copied wrongly.
 */

import { open } from "node:fs/promises";

export class FragmentError extends Error {}

type Box = { type: string; payload: Buffer };
type Sample = { offset: number; size: number; duration: number; sync: boolean; cto: number };
type Defaults = { duration: number; size: number; flags: number };

// A box header's or a fragment's size past these is not a recording's.
const MAX_HEADER_BOX = 1 << 20;
const COPY_BYTES = 1 << 20;

function children(buf: Buffer): Box[] {
  const out: Box[] = [];
  for (let off = 0; off + 8 <= buf.length;) {
    let size = buf.readUInt32BE(off), header = 8;
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > buf.length) throw new FragmentError(`the ${type} box is cut off`);
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = buf.length - off;
    if (size < header || off + size > buf.length) throw new FragmentError(`the ${type} box overruns its parent`);
    out.push({ type, payload: buf.subarray(off + header, off + size) });
    off += size;
  }
  return out;
}

const find = (boxes: Box[], type: string) => boxes.find((b) => b.type === type);
function need(boxes: Box[], type: string): Box {
  const found = find(boxes, type);
  if (!found) throw new FragmentError(`no ${type} box`);
  return found;
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/** A full box: version, flags, then its fields. */
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, head, ...parts);
};
const u32s = (values: number[]) => {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeUInt32BE(v >>> 0, i * 4));
  return buf;
};
const i32s = (values: number[]) => {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeInt32BE(v, i * 4));
  return buf;
};

/** A duration field of a version 0 or 1 header (mdhd, tkhd), rewritten in place in a copy of its payload. */
function withDuration(payload: Buffer, v0: number, v1: number, duration: number): Buffer {
  const copy = Buffer.from(payload);
  if (copy[0] === 1) copy.writeBigUInt64BE(BigInt(duration), v1);
  else {
    if (duration > 0xffffffff) throw new FragmentError("the recording is too long for its header");
    copy.writeUInt32BE(duration, v0);
  }
  return copy;
}

/** Runs of equal values, as stts and ctts count them: [count, value, count, value, ...]. */
function runs(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (out.length && out[out.length - 1] === v) out[out.length - 2]!++;
    else out.push(1, v);
  }
  return out;
}

/** The samples of one moof (at moofStart), with the data offsets they name in the file. */
function fragmentSamples(moof: Buffer, moofStart: number, trackId: number, trex: Defaults): Sample[] {
  const boxes = children(moof);
  const trafs = boxes.filter((b) => b.type === "traf");
  if (trafs.length !== 1) throw new FragmentError(`a fragment with ${trafs.length} tracks`);
  const traf = children(trafs[0]!.payload);
  const tfhd = need(traf, "tfhd").payload;
  const tfhdFlags = tfhd.readUInt32BE(0) & 0xffffff;
  if (tfhd.readUInt32BE(4) !== trackId) throw new FragmentError("a fragment of another track");
  let at = 8, base = moofStart;
  if (tfhdFlags & 0x01) { base = Number(tfhd.readBigUInt64BE(at)); at += 8; }
  if (tfhdFlags & 0x02) at += 4;
  const defaults = { ...trex };
  if (tfhdFlags & 0x08) { defaults.duration = tfhd.readUInt32BE(at); at += 4; }
  if (tfhdFlags & 0x10) { defaults.size = tfhd.readUInt32BE(at); at += 4; }
  if (tfhdFlags & 0x20) { defaults.flags = tfhd.readUInt32BE(at); at += 4; }
  const samples: Sample[] = [];
  let next = base;
  for (const trun of traf.filter((b) => b.type === "trun")) {
    const p = trun.payload, version = p[0]!, flags = p.readUInt32BE(0) & 0xffffff, count = p.readUInt32BE(4);
    let off = 8;
    if (flags & 0x01) { next = base + p.readInt32BE(off); off += 4; }
    let first: number | undefined;
    if (flags & 0x04) { first = p.readUInt32BE(off); off += 4; }
    const each = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
    if (off + count * each > p.length) throw new FragmentError("a fragment's sample list is cut off");
    const field = (present: number, signed = false) => {
      if (!(flags & present)) return undefined;
      off += 4;
      return signed ? p.readInt32BE(off - 4) : p.readUInt32BE(off - 4);
    };
    for (let i = 0; i < count; i++) {
      const duration = field(0x100) ?? defaults.duration;
      const size = field(0x200) ?? defaults.size;
      const sampleFlags = field(0x400) ?? (i === 0 && first !== undefined ? first : defaults.flags);
      // Composition offsets: unsigned in a version 0 run, signed in version 1.
      const cto = field(0x800, version === 1) ?? 0;
      // sample_is_non_sync_sample, the 16th bit of the flags.
      samples.push({ offset: next, size, duration, sync: ((sampleFlags >>> 16) & 1) === 0, cto });
      next += size;
    }
  }
  return samples;
}

/**
 * Writes source (a fragmented MP4 of one video track) to target as a plain MP4; answers its length in seconds and
 * frames. Samples whose data runs past the end of source (the recorder ended mid-write) are left out.
 */
export async function flattenFmp4(source: string, target: string): Promise<{ seconds: number; frames: number }> {
  const input = await open(source, "r");
  try {
    const { size } = await input.stat();
    const read = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await input.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    };
    let moov: Buffer | undefined;
    let trackId = 0, timescale = 0;
    let trex: Defaults = { duration: 0, size: 0, flags: 0 };
    let trak: Box[] | undefined, tkhd: Buffer | undefined, mdhd: Buffer | undefined;
    const samples: Sample[] = [];
    for (let off = 0; off + 8 <= size;) {
      const head = await read(off, 16);
      let boxSize = head.readUInt32BE(0), header = 8;
      const type = head.toString("latin1", 4, 8);
      if (boxSize === 1) {
        if (head.length < 16) break;
        boxSize = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (boxSize === 0) boxSize = size - off;
      if (boxSize < header) throw new FragmentError(`the ${type} box at ${off} is broken`);
      // A box cut off by the recorder's end: everything before it stands.
      if (off + boxSize > size) break;
      if (type === "moov" || type === "moof") {
        if (boxSize > MAX_HEADER_BOX) throw new FragmentError(`a ${type} box of ${boxSize} bytes`);
        const payload = await read(off + header, boxSize - header);
        if (type === "moov") {
          if (moov) throw new FragmentError("two movie boxes");
          moov = payload;
          const top = children(payload);
          const traks = top.filter((b) => b.type === "trak");
          if (traks.length !== 1) throw new FragmentError(`${traks.length} tracks, not one`);
          trak = children(traks[0]!.payload);
          tkhd = need(trak, "tkhd").payload;
          trackId = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12);
          const mdia = children(need(trak, "mdia").payload);
          mdhd = need(mdia, "mdhd").payload;
          timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
          if (need(mdia, "hdlr").payload.toString("latin1", 8, 12) !== "vide") throw new FragmentError("not a video track");
          const ex = find(children(need(top, "mvex").payload), "trex");
          if (ex) trex = { duration: ex.payload.readUInt32BE(12), size: ex.payload.readUInt32BE(16), flags: ex.payload.readUInt32BE(20) };
        } else {
          if (!moov) throw new FragmentError("a fragment before the movie box");
          samples.push(...fragmentSamples(payload, off, trackId, trex));
        }
      }
      off += boxSize;
    }
    if (!moov || !trak || !tkhd || !mdhd || !timescale) throw new FragmentError("no movie box");
    const whole = samples.filter((s) => s.size > 0 && s.offset >= 0 && s.offset + s.size <= size);
    if (!whole.length) throw new FragmentError("no frames");

    const durations = whole.map((s) => s.duration);
    const duration = durations.reduce((a, b) => a + b, 0);
    const ctos = whole.map((s) => s.cto);
    const syncs = whole.flatMap((s, i) => (s.sync ? [i + 1] : []));
    const mdia = children(need(trak, "mdia").payload);
    const minf = children(need(mdia, "minf").payload);
    const stsd = need(children(need(minf, "stbl").payload), "stsd");
    const dataBytes = whole.reduce((a, s) => a + s.size, 0);
    const large = dataBytes + whole.length * 8 + 64 * 1024 > 0xffffffff;
    const table = (chunkOffsets: number[]) => box("stbl",
      box("stsd", stsd.payload),
      full("stts", 0, 0, u32s([runs(durations).length / 2, ...runs(durations)])),
      ...(ctos.some((c) => c !== 0) ? [full("ctts", ctos.some((c) => c < 0) ? 1 : 0, 0, u32s([runs(ctos).length / 2]), i32s(runs(ctos)))] : []),
      // Every frame a sync frame: no stss, as the format says.
      ...(syncs.length < whole.length ? [full("stss", 0, 0, u32s([syncs.length, ...syncs]))] : []),
      // One frame a chunk.
      full("stsc", 0, 0, u32s([1, 1, 1, 1])),
      full("stsz", 0, 0, u32s([0, whole.length, ...whole.map((s) => s.size)])),
      large
        ? full("co64", 0, 0, u32s([chunkOffsets.length]), Buffer.concat(chunkOffsets.map((o) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(o)); return b; })))
        : full("stco", 0, 0, u32s([chunkOffsets.length, ...chunkOffsets])),
    );
    const mvhd = Buffer.alloc(96);
    mvhd.writeUInt32BE(timescale, 8);
    if (duration > 0xffffffff) throw new FragmentError("the recording is too long for its header");
    mvhd.writeUInt32BE(duration, 12);
    mvhd.writeUInt32BE(0x00010000, 16);
    mvhd.writeUInt16BE(0x0100, 20);
    [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].forEach((v, i) => mvhd.writeUInt32BE(v, 32 + i * 4));
    mvhd.writeUInt32BE(trackId + 1, 92);
    const moovOf = (chunkOffsets: number[]) => box("moov",
      full("mvhd", 0, 0, mvhd),
      box("trak",
        box("tkhd", withDuration(tkhd, 20, 28, duration)),
        box("mdia",
          box("mdhd", withDuration(mdhd, 16, 24, duration)),
          box("hdlr", need(mdia, "hdlr").payload),
          box("minf", ...minf.filter((b) => b.type !== "stbl").map((b) => box(b.type, b.payload)), table(chunkOffsets)))));
    const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32s([0x200]), Buffer.from("isomiso2avc1mp41", "latin1"));
    // The movie box's size does not depend on the offsets' values, only on their count: measured once, then written.
    const headerBytes = ftyp.length + moovOf(whole.map(() => 0)).length;
    const mdatHeader = large ? 16 : 8;
    const offsets: number[] = [];
    let at = headerBytes + mdatHeader;
    for (const s of whole) { offsets.push(at); at += s.size; }
    const mdatHead = Buffer.alloc(mdatHeader);
    if (large) { mdatHead.writeUInt32BE(1); mdatHead.write("mdat", 4, "latin1"); mdatHead.writeBigUInt64BE(BigInt(16 + dataBytes), 8); }
    else { mdatHead.writeUInt32BE(8 + dataBytes); mdatHead.write("mdat", 4, "latin1"); }

    const output = await open(target, "w");
    try {
      await output.write(Buffer.concat([ftyp, moovOf(offsets), mdatHead]));
      // Frames next to each other in the source are copied together, a megabyte at most at a time.
      for (let i = 0; i < whole.length;) {
        let j = i + 1, end = whole[i]!.offset + whole[i]!.size;
        while (j < whole.length && whole[j]!.offset === end && end - whole[i]!.offset < COPY_BYTES) end += whole[j++]!.size;
        await output.write(await read(whole[i]!.offset, end - whole[i]!.offset));
        i = j;
      }
    } finally {
      await output.close();
    }
    return { seconds: duration / timescale, frames: whole.length };
  } finally {
    await input.close();
  }
}
