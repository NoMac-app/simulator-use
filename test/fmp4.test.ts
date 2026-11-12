import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { flattenFmp4, FragmentError, NoFramesError } from "../src/engine/fmp4.ts";
import { fmp4, type Frame, initSegment, numbers, path, readBoxes } from "./fixtures/fmp4.ts";

// A NoMac phone's recording is the engine's stream, a fragment a frame (ffmpeg and Chrome play it, QuickTime and
// Safari refuse it): its stop makes it a plain MP4 with every frame indexed.
const frames: Frame[] = [
  { size: 4000, duration: 5, sync: true },
  { size: 900, duration: 66, sync: true },
  ...Array.from({ length: 58 }, (_, i) => ({ size: 300 + i, duration: 3000, sync: i === 29 })),
];

async function flatten(source: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "su-fmp4-"));
  try {
    writeFileSync(join(dir, "in.fmp4"), source);
    const answer = await flattenFmp4(join(dir, "in.fmp4"), join(dir, "out.mp4"));
    return { answer, out: readFileSync(join(dir, "out.mp4")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a fragmented recording becomes a plain MP4: the movie box first, every frame indexed, its bytes in order", async () => {
  const { answer, out } = await flatten(fmp4(frames));
  const total = frames.reduce((a, f) => a + f.duration, 0);
  assert.deepEqual(answer, { seconds: total / 90_000, frames: 60 });
  const boxes = readBoxes(out);
  assert.deepEqual(boxes.map((b) => b.type), ["ftyp", "moov", "mdat"]);
  assert.equal(boxes[0]!.payload.toString("latin1", 0, 4), "isom");
  // No fragments are left, and the durations are the frames' own.
  assert.equal(path(boxes, "moov", "mvex"), undefined);
  assert.equal(numbers(path(boxes, "moov", "mvhd"))[3], total);
  assert.equal(path(boxes, "moov", "trak", "mdia", "mdhd")!.payload.readUInt32BE(16), total);
  assert.equal(path(boxes, "moov", "trak", "tkhd")!.payload.readUInt32BE(20), total);
  const stbl = (type: string) => path(boxes, "moov", "trak", "mdia", "minf", "stbl", type);
  assert.deepEqual(numbers(stbl("stts")), [3, 1, 5, 1, 66, 58, 3000]);
  assert.deepEqual(numbers(stbl("stsz")), [0, 60, ...frames.map((f) => f.size)]);
  assert.deepEqual(numbers(stbl("stss")), [3, 1, 2, 32]);
  assert.equal(stbl("ctts"), undefined);
  assert.deepEqual(numbers(stbl("stsc")), [1, 1, 1, 1]);
  // The sample entry is the source's, as is the track's size.
  assert.equal(stbl("stsd")!.payload.toString("latin1", 12, 16), "avc1");
  // Each chunk offset points at its frame's bytes, all of its index.
  const offsets = numbers(stbl("stco")).slice(1);
  assert.equal(offsets.length, 60);
  frames.forEach((f, i) => {
    const bytes = out.subarray(offsets[i]!, offsets[i]! + f.size);
    assert.equal(bytes.length, f.size);
    assert.ok(bytes.every((b) => b === i), `frame ${i}`);
  });
  assert.equal(offsets[0], out.length - boxes[2]!.payload.length);
});

test("a recorder ended mid-write leaves its last fragment cut off: the frames before it stand", async () => {
  const whole = fmp4(frames.slice(0, 10));
  // Cut inside the last frame's mdat, then inside its moof.
  for (const cut of [whole.length - 50, whole.length - frames[9]!.size - 30]) {
    const { answer, out } = await flatten(whole.subarray(0, cut));
    assert.equal(answer.frames, 9);
    assert.deepEqual(numbers(path(readBoxes(out), "moov", "trak", "mdia", "minf", "stbl", "stsz")), [0, 9, ...frames.slice(0, 9).map((f) => f.size)]);
  }
});

test("anything but a recording of one video track is refused, never copied wrongly", async () => {
  // A recording stopped before its first frame has no video at all (an empty file, or the movie box alone).
  await assert.rejects(flatten(initSegment()), NoFramesError);
  await assert.rejects(flatten(Buffer.alloc(0)), NoFramesError);
  // Fragment defaults of another track.
  const bare = initSegment(), trexAt = bare.indexOf(Buffer.from("trex", "latin1"));
  const otherTrex = Buffer.from(bare);
  otherTrex.writeUInt32BE(2, trexAt + 8);
  await assert.rejects(flatten(Buffer.concat([otherTrex, fmp4(frames.slice(0, 2)).subarray(bare.length)])), /fragment defaults of another track/);
  await assert.rejects(flatten(Buffer.from("not a movie at all, just some words")), FragmentError);
  // Two tracks in the movie box.
  const init = readBoxes(initSegment());
  const moov = init[1]!;
  const trak = moov.children!.find((b) => b.type === "trak")!;
  const box = (type: string, payload: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + payload.length); h.write(type, 4, "latin1"); return Buffer.concat([h, payload]); };
  const two = Buffer.concat([box("ftyp", init[0]!.payload), box("moov", Buffer.concat([moov.payload, box("trak", trak.payload)]))]);
  await assert.rejects(flatten(Buffer.concat([two, fmp4(frames.slice(0, 2)).subarray(initSegment().length)])), /2 tracks/);
});
