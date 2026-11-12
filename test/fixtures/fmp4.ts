// A fragmented MP4 as the engine's stream writes it (transport fmp4, recorded from an iPhone 17e Simulator on
// November 12, 2026): ftyp, a moov with one video track and its mvex, then a moof (tfhd default-base-is-moof, a
// version 1 tfdt, a trun with data offset, duration, size and flags) and an mdat for every frame. Each frame's bytes
// are its index, so a test can tell which frame landed where.

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const u32 = (...values: number[]) => Buffer.concat(values.map((v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; }));
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => box(type, u32(((version << 24) | flags) >>> 0), ...parts);

export type Frame = { size: number; duration: number; sync: boolean };

/** The movie box: track 1, 90 kHz, an avc1 entry of the given size, every table empty, and its trex. */
export function initSegment(width = 1170, height = 2532): Buffer {
  const avc1 = Buffer.concat([Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(16), Buffer.from([width >> 8, width & 0xff, height >> 8, height & 0xff]), u32(0x00480000, 0x00480000, 0), Buffer.from([0, 1]), Buffer.alloc(32), Buffer.from([0, 0x18, 0xff, 0xff])]);
  const stsd = full("stsd", 0, 0, u32(1), box("avc1", avc1, box("avcC", Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]))));
  const stbl = box("stbl", stsd, full("stts", 0, 0, u32(0)), full("stsc", 0, 0, u32(0)), full("stsz", 0, 0, u32(0, 0)), full("stco", 0, 0, u32(0)));
  const minf = box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  const hdlr = full("hdlr", 0, 0, u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "latin1"));
  const mdia = box("mdia", full("mdhd", 0, 0, u32(0, 0, 90_000, 0), Buffer.from([0x55, 0xc4, 0, 0])), hdlr, minf);
  const tkhd = full("tkhd", 0, 3, u32(0, 0, 1, 0, 0), Buffer.alloc(8), Buffer.alloc(8), u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000), u32(width << 16, height << 16));
  const mvhd = full("mvhd", 0, 0, u32(0, 0, 90_000, 0, 0x00010000), Buffer.from([1, 0, 0, 0]), Buffer.alloc(8), u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000), Buffer.alloc(24), u32(2));
  const mvex = box("mvex", full("trex", 0, 0, u32(1, 1, 0, 0, 0)));
  return Buffer.concat([box("ftyp", Buffer.from("isom", "latin1"), u32(0x200), Buffer.from("isomiso6mp41", "latin1")), box("moov", mvhd, box("trak", tkhd, mdia), mvex)]);
}

/** One frame's moof and mdat, its bytes all its index. */
export function fragment(index: number, frame: Frame, decodeTime: number): Buffer {
  const tfdt = Buffer.alloc(8);
  tfdt.writeBigUInt64BE(BigInt(decodeTime));
  const traf = (dataOffset: number) => box("traf", full("tfhd", 0, 0x020000, u32(1)), full("tfdt", 1, 0, tfdt),
    full("trun", 0, 0x000701, u32(1, dataOffset, frame.duration, frame.size, frame.sync ? 0x02000000 : 0x01010000)));
  const moofSize = box("moof", full("mfhd", 0, 0, u32(index + 1)), traf(0)).length;
  return Buffer.concat([box("moof", full("mfhd", 0, 0, u32(index + 1)), traf(moofSize + 8)), box("mdat", Buffer.alloc(frame.size, index & 0xff))]);
}

/** A whole recording: the movie box, then each frame's fragment. */
export function fmp4(frames: Frame[]): Buffer {
  let time = 745;
  return Buffer.concat([initSegment(), ...frames.map((frame, i) => {
    const out = fragment(i, frame, time);
    time += frame.duration;
    return out;
  })]);
}

/** A plain MP4's boxes, as a test reads them: containers opened, the rest kept as payloads. */
export type ReadBox = { type: string; payload: Buffer; children?: ReadBox[] };
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "mvex", "moof", "traf"]);
export function readBoxes(buf: Buffer): ReadBox[] {
  const out: ReadBox[] = [];
  for (let off = 0; off + 8 <= buf.length;) {
    let size = buf.readUInt32BE(off), header = 8;
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    const payload = buf.subarray(off + header, off + size);
    out.push(CONTAINERS.has(type) ? { type, payload, children: readBoxes(payload) } : { type, payload });
    off += size;
  }
  return out;
}
export const path = (boxes: ReadBox[], ...types: string[]): ReadBox | undefined =>
  types.reduce<ReadBox | undefined>((at, type, i) => (i === 0 ? boxes : at?.children)?.find((b) => b.type === type), undefined);
/** A full box's numbers after its version and flags. */
export const numbers = (b: ReadBox | undefined) => Array.from({ length: Math.floor(((b?.payload.length ?? 4) - 4) / 4) }, (_, i) => b!.payload.readUInt32BE(4 + i * 4));
