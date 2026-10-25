import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/**
 * A saved phone state as NoMac keeps it in its storage (October 25, 2026), so any phone of the same model and iOS
 * restores it, on any host: its folder as a tar, gzipped, in AES-256-GCM frames of up to 4 MiB under the state's own
 * key (NoMac's, given for one transfer). Each frame is authenticated with its index and whether it is the last, so an
 * archive cut short, reordered or changed is refused before anything of it is kept.
 */
const MAGIC = Buffer.from("NMS1");
const FRAME = 4 * 1024 * 1024;
const NONCE = 12;
const TAG = 16;
/** The longest a frame may claim: a corrupt length never makes the reader hold gigabytes. */
const MOST = FRAME + 64 * 1024;

const aad = (index: number, last: boolean) => {
  const b = Buffer.alloc(MAGIC.length + 9);
  MAGIC.copy(b);
  b.writeBigUInt64BE(BigInt(index), MAGIC.length);
  b[MAGIC.length + 8] = last ? 1 : 0;
  return b;
};

export function stateKey(key: string): Buffer {
  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== key) throw new Error("invalid_state_key");
  return raw;
}

/** Plain bytes in, sealed frames out. The last frame is sealed as last at the end, empty if need be. */
export function sealer(key: Buffer): Transform {
  let pending: Buffer = Buffer.alloc(0), index = 0, started = false;
  const frame = (t: Transform, plain: Buffer, last: boolean) => {
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(index++, last));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(plain.length);
    t.push(Buffer.concat([length, nonce, body, cipher.getAuthTag()]));
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      if (!started) { this.push(MAGIC); started = true; }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // A full frame goes out only once more data follows it, so the one at the end is the one sealed as last.
      while (pending.length > FRAME) {
        frame(this, pending.subarray(0, FRAME), false);
        pending = pending.subarray(FRAME);
      }
      done();
    },
    flush(done: TransformCallback) {
      if (!started) this.push(MAGIC);
      frame(this, pending, true);
      done();
    },
  });
}

/** Sealed frames in, plain bytes out: refused at the first frame that does not open, or an end with no last frame. */
export function opener(key: Buffer): Transform {
  let buffered: Buffer = Buffer.alloc(0), index = 0, header = false, ended = false;
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      try {
        if (!header) {
          if (buffered.length < MAGIC.length) return done();
          if (!buffered.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a NoMac phone state");
          buffered = buffered.subarray(MAGIC.length);
          header = true;
        }
        for (;;) {
          if (buffered.length < 4) break;
          const length = buffered.readUInt32BE(0);
          if (length > MOST) throw new Error("a frame claims too much");
          const whole = 4 + NONCE + length + TAG;
          if (buffered.length < whole) break;
          if (ended) throw new Error("data after the last frame");
          const nonce = buffered.subarray(4, 4 + NONCE), body = buffered.subarray(4 + NONCE, 4 + NONCE + length), tag = buffered.subarray(4 + NONCE + length, whole);
          // A frame opens as the last or as not: which, its sealing says.
          let plain: Buffer | undefined;
          for (const last of [false, true]) {
            try {
              const decipher = createDecipheriv("aes-256-gcm", key, nonce);
              decipher.setAAD(aad(index, last));
              decipher.setAuthTag(tag);
              plain = Buffer.concat([decipher.update(body), decipher.final()]);
              ended = last;
              break;
            } catch { /* the other way, or neither */ }
          }
          if (!plain) throw new Error("the state does not open with its key (changed, or another state's)");
          index++;
          buffered = buffered.subarray(whole);
          if (plain.length) this.push(plain);
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      done(!header || !ended || buffered.length ? new Error("the state is cut short") : undefined);
    },
  });
}

/** tar as a stream, its errors and exit status kept: a tar that fails mid-way fails the pipeline. */
function tar(args: string[], cwd: string) {
  const child = spawn("/usr/bin/tar", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d).slice(-2000); });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`))));
  });
  return { child, exited };
}

/**
 * The state named name, in statesDir, sealed under key and PUT to url (a link NoMac signed). It is sealed into a file
 * in tmp first, since the storage takes a PUT of a known length. Answers the bytes sent.
 */
export async function uploadState(statesDir: string, name: string, url: string, key: string, tmp: string): Promise<number> {
  const dir = await mkdtemp(join(tmp, "state-")), sealed = join(dir, `${name}.nms`);
  try {
    const packing = tar(["-cf", "-", name], statesDir);
    packing.child.stdin.end();
    await Promise.all([pipeline(packing.child.stdout, createGzip({ level: 1 }), sealer(stateKey(key)), createWriteStream(sealed, { mode: 0o600 })), packing.exited]);
    const { size } = await stat(sealed);
    const body = Readable.toWeb(createReadStream(sealed)) as ReadableStream<Uint8Array>;
    const response = await fetch(url, { method: "PUT", body, headers: { "content-length": String(size) }, duplex: "half" } as RequestInit);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`the state's upload failed: storage answered ${response.status}`);
    return size;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The state at url (sealed under key) unpacked into statesDir as name, replacing a copy there only once all of it
 * opened: it is unpacked beside it first, then moved into place.
 */
export async function fetchState(statesDir: string, name: string, url: string, key: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`the state's download failed: storage answered ${response.status}`);
  const into = await mkdtemp(join(statesDir, `.${name}.fetching-`));
  try {
    // bsdtar keeps entries inside into: no absolute paths, no .., no writes through a symlink.
    const unpacking = tar(["-xf", "-"], into);
    await Promise.all([pipeline(Readable.fromWeb(response.body as never), opener(stateKey(key)), createGunzip(), unpacking.child.stdin), unpacking.exited]);
    await stat(join(into, name, "state.json"));
    await rm(join(statesDir, name), { recursive: true, force: true });
    await rename(join(into, name), join(statesDir, name));
  } finally {
    await rm(into, { recursive: true, force: true });
  }
}
