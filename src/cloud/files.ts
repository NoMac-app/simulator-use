/**
 * The files a phone's answers link to, saved on this machine: a link ends with its phone, and a local tool's answer
 * names a path.
 */

import { createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A file link in a phone's answer: <base>/api/v1/simulator/files/<payload>.<signature>, never the sentence's period. */
const FILE_LINK = /https?:\/\/[^\s"'<>]+?\/api\/v1\/simulator\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const KEEP_FILES = 10;
const KEEP_BYTES = 200 * 1024 * 1024;

/** The file's name as the link carries it (its payload's n), made safe for a folder. */
function linkName(link: string): string | undefined {
  try {
    const payload = /\/files\/([A-Za-z0-9_-]+)\./.exec(link)?.[1];
    const name = payload ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { n?: unknown }).n : undefined;
    const safe = typeof name === "string" ? basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") : "";
    return safe || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files a run's answers link to (a failed build's full log), kept in out before the phone stops: a link that
 * was never opened ends with its phone. At most 10 files and 200 MB; each link in lines becomes its file's path.
 */
export async function keepFiles(lines: string[], out: string): Promise<void> {
  const links = [...new Set(lines.join("\n").match(FILE_LINK) ?? [])].slice(0, KEEP_FILES);
  let total = 0;
  for (const [i, link] of links.entries()) {
    const name = linkName(link) ?? `simulator-use-file-${i + 1}`;
    const file = join(out, existsSync(join(out, name)) ? `${i + 1}-${name}` : name);
    try {
      const response = await fetch(link, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body || total + Number(response.headers.get("content-length") ?? 0) > KEEP_BYTES) continue;
      let size = 0;
      const capped = Readable.fromWeb(response.body as never).map((chunk: Buffer) => {
        size += chunk.length;
        if (total + size > KEEP_BYTES) throw new Error("over the run's file budget");
        return chunk;
      });
      await pipeline(capped, createWriteStream(file));
      total += size;
      for (let j = 0; j < lines.length; j++) lines[j] = lines[j]!.split(link).join(file);
    } catch {
      // The link stays in the text; a file cut short is not kept.
      await unlink(file).catch(() => undefined);
    }
  }
}
