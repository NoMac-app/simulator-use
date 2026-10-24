/**
 * The framing of a NoMac phone's tunnel (NoMac Simulator plan 10.7 E6), spoken by the relay on the phone's host and the
 * client on the developer's machine over one byte stream: each frame is its type (1 byte), its connection (4 bytes)
 * and its payload's length (4 bytes, big-endian), then the payload, at most 64 KiB.
 *   hello (relay to client, connection 0): JSON {port}, the loopback port the phone's apps reach;
 *   open (relay to client): an app on the phone connected; the client dials the backend for it;
 *   data (both ways): bytes of a connection;
 *   close (both ways): the connection ended, on either side.
 */

export const HELLO = 1;
export const OPEN = 2;
export const DATA = 3;
export const CLOSE = 4;
export const HEADER = 9;
export const MAX_PAYLOAD = 64 * 1024;
/** Connections at once through one tunnel. */
export const MAX_CONNECTIONS = 64;

export type Frame = { type: number; conn: number; payload: Buffer };

export function frame(type: number, conn: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(conn, 1);
  head.writeUInt32BE(payload.length, 5);
  return Buffer.concat([head, payload]);
}

/** A connection's bytes as data frames of at most 64 KiB. */
export function dataFrames(conn: number, bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += MAX_PAYLOAD) out.push(frame(DATA, conn, bytes.subarray(at, at + MAX_PAYLOAD)));
  return out;
}

/** Reads frames from a stream's chunks, whatever their boundaries. A frame over the limit ends the tunnel. */
export class FrameReader {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const frames: Frame[] = [];
    while (this.buffered.length >= HEADER) {
      const length = this.buffered.readUInt32BE(5);
      if (length > MAX_PAYLOAD) throw new Error("tunnel frame over 64 KiB");
      if (this.buffered.length < HEADER + length) break;
      frames.push({ type: this.buffered.readUInt8(0), conn: this.buffered.readUInt32BE(1), payload: this.buffered.subarray(HEADER, HEADER + length) });
      this.buffered = this.buffered.subarray(HEADER + length);
    }
    return frames;
  }
}
