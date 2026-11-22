/**
 * Apple's binary property list (bplist00), as much of it as the Simulator's Web Inspector speaks: dictionaries with
 * string keys, arrays, strings, integers, reals, booleans, data and dates. Written here (about 150 lines) so the
 * package keeps no dependency.
 */
export type Plist = string | number | boolean | Buffer | Date | null | Plist[] | { [key: string]: Plist };

/** Encodes a value as a binary property list. */
export function encodePlist(root: Plist): Buffer {
  // Every value becomes one object; containers refer to their members by number.
  const objects: Buffer[] = [];
  const refs: number[][] = [];
  const seenStrings = new Map<string, number>();
  const add = (value: Plist): number => {
    if (typeof value === "string") {
      const seen = seenStrings.get(value);
      if (seen !== undefined) return seen;
    }
    const index = objects.length;
    objects.push(Buffer.alloc(0));
    refs.push([]);
    if (typeof value === "string") seenStrings.set(value, index);
    if (value === null) objects[index] = Buffer.from([0x00]);
    else if (typeof value === "boolean") objects[index] = Buffer.from([value ? 0x09 : 0x08]);
    else if (typeof value === "number") objects[index] = Number.isInteger(value) ? int(value) : real(value);
    else if (typeof value === "string") objects[index] = string(value);
    else if (Buffer.isBuffer(value)) objects[index] = Buffer.concat([header(0x4, value.length), value]);
    else if (value instanceof Date) {
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE(value.getTime() / 1000 - 978307200, 1);
      objects[index] = b;
    } else if (Array.isArray(value)) {
      objects[index] = header(0xa, value.length);
      refs[index] = value.map(add);
    } else {
      const keys = Object.keys(value);
      objects[index] = header(0xd, keys.length);
      const keyRefs = keys.map(add);
      refs[index] = [...keyRefs, ...keys.map((k) => add(value[k]!))];
    }
    return index;
  };
  add(root);
  const refSize = objects.length < 256 ? 1 : objects.length < 65536 ? 2 : 4;
  const bodies = objects.map((head, i) => {
    const r = Buffer.alloc(refs[i]!.length * refSize);
    refs[i]!.forEach((ref, at) => r.writeUIntBE(ref, at * refSize, refSize));
    return Buffer.concat([head, r]);
  });
  const offsets: number[] = [];
  let at = 8;
  for (const body of bodies) {
    offsets.push(at);
    at += body.length;
  }
  const offsetSize = at < 256 ? 1 : at < 65536 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((offset, i) => table.writeUIntBE(offset, i * offsetSize, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([Buffer.from("bplist00"), ...bodies, table, trailer]);
}

/** A marker byte and a count: the count in the low four bits, or 0xF and an integer object after it. */
function header(type: number, count: number): Buffer {
  return count < 15 ? Buffer.from([(type << 4) | count]) : Buffer.concat([Buffer.from([(type << 4) | 0xf]), int(count)]);
}

function int(value: number): Buffer {
  if (value >= 0 && value < 256) return Buffer.from([0x10, value]);
  if (value >= 0 && value < 65536) {
    const b = Buffer.alloc(3);
    b[0] = 0x11;
    b.writeUInt16BE(value, 1);
    return b;
  }
  if (value >= 0 && value < 2 ** 32) {
    const b = Buffer.alloc(5);
    b[0] = 0x12;
    b.writeUInt32BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0x13;
  b.writeBigInt64BE(BigInt(value), 1);
  return b;
}

function real(value: number): Buffer {
  const b = Buffer.alloc(9);
  b[0] = 0x23;
  b.writeDoubleBE(value, 1);
  return b;
}

function string(value: string): Buffer {
  // ASCII as it is; anything else as UTF-16, big end first, counted in 16-bit units.
  if (/^[\x00-\x7f]*$/.test(value)) return Buffer.concat([header(0x5, value.length), Buffer.from(value, "latin1")]);
  const utf16 = Buffer.from(value, "utf16le").swap16();
  return Buffer.concat([header(0x6, utf16.length / 2), utf16]);
}

/** Decodes a binary property list; throws on anything that is not one. */
export function decodePlist(data: Buffer): Plist {
  if (data.length < 40 || data.toString("latin1", 0, 6) !== "bplist") throw new Error("not a binary property list");
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer[6]!, refSize = trailer[7]!;
  const count = Number(trailer.readBigUInt64BE(8)), top = Number(trailer.readBigUInt64BE(16)), tableAt = Number(trailer.readBigUInt64BE(24));
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8 || tableAt + count * offsetSize > data.length - 32) throw new Error("a binary property list with a bad trailer");
  const offsetOf = (index: number) => {
    if (index < 0 || index >= count) throw new Error("a binary property list that refers past its objects");
    return Number(readUInt(data, tableAt + index * offsetSize, offsetSize));
  };
  // A list that holds itself would never end: 64 levels are more than any message has.
  const read = (index: number, depth: number): Plist => {
    if (depth > 64) throw new Error("a binary property list nested too deep");
    let at = offsetOf(index);
    const marker = data[at++]!;
    const type = marker >> 4;
    let size = marker & 0xf;
    const sized = () => {
      if (size !== 0xf) return;
      const bytes = 1 << (data[at++]! & 0xf);
      size = Number(readUInt(data, at, bytes));
      at += bytes;
    };
    switch (type) {
      case 0x0:
        return marker === 0x09 ? true : marker === 0x08 ? false : null;
      case 0x1: {
        const bytes = 1 << size;
        // Eight bytes are signed; fewer are not.
        return bytes === 8 ? Number(data.readBigInt64BE(at)) : Number(readUInt(data, at, bytes));
      }
      case 0x2:
        return size === 2 ? data.readFloatBE(at) : data.readDoubleBE(at);
      case 0x3:
        return new Date((data.readDoubleBE(at) + 978307200) * 1000);
      case 0x4:
        sized();
        return Buffer.from(data.subarray(at, at + size));
      case 0x5:
        sized();
        return data.toString("latin1", at, at + size);
      case 0x6:
        sized();
        return Buffer.from(data.subarray(at, at + size * 2)).swap16().toString("utf16le");
      case 0x8:
        return Number(readUInt(data, at, size + 1));
      case 0xa:
      case 0xc: {
        sized();
        const out: Plist[] = [];
        for (let i = 0; i < size; i++) out.push(read(Number(readUInt(data, at + i * refSize, refSize)), depth + 1));
        return out;
      }
      case 0xd: {
        sized();
        const out: { [key: string]: Plist } = {};
        for (let i = 0; i < size; i++) {
          const key = read(Number(readUInt(data, at + i * refSize, refSize)), depth + 1);
          out[String(key)] = read(Number(readUInt(data, at + (size + i) * refSize, refSize)), depth + 1);
        }
        return out;
      }
      default:
        throw new Error(`a binary property list with an object of type ${type}`);
    }
  };
  return read(top, 0);
}

function readUInt(data: Buffer, at: number, bytes: number): bigint {
  if (at < 0 || at + bytes > data.length) throw new Error("a binary property list cut short");
  let value = 0n;
  for (let i = 0; i < bytes; i++) value = (value << 8n) | BigInt(data[at + i]!);
  return value;
}
