import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../config.ts";

/**
 * WORM evidence storage (PDF §7.1).
 * - s3:    Amazon S3 (or MinIO) with Object Lock in COMPLIANCE mode and a retention date;
 *          not even the root account can delete or overwrite before it expires.
 * - local: development fallback; files are created exclusively and made read-only.
 */

export interface StoredObject { uri: string; sha256: string; bytes: number; retainUntil: string }

const retainUntil = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + config.WORM_RETENTION_YEARS);
  return d;
};

let s3: S3Client | null = null;
const s3c = () => (s3 ??= new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT || undefined,
  forcePathStyle: config.S3_FORCE_PATH_STYLE
}));

export async function putImmutable(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const until = retainUntil();
  if (config.STORAGE_DRIVER === "s3") {
    await s3c().send(new PutObjectCommand({
      Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType,
      ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: until,
      ChecksumAlgorithm: "SHA256", Metadata: { sha256 }
    }));
    return { uri: `s3://${config.S3_BUCKET}/${key}`, sha256, bytes: body.length, retainUntil: until.toISOString() };
  }
  const file = path.join(config.LOCAL_STORAGE_DIR, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { flag: "wx" });          // never overwrite
  fs.chmodSync(file, 0o444);
  fs.writeFileSync(`${file}.retention.json`, JSON.stringify({ sha256, retainUntil: until.toISOString(), mode: "LOCAL_READ_ONLY" }), { flag: "wx" });
  return { uri: `file://${key}`, sha256, bytes: body.length, retainUntil: until.toISOString() };
}

export async function getObject(uri: string): Promise<Buffer> {
  if (uri.startsWith("s3://")) {
    const [, , bucket, ...rest] = uri.split("/");
    const r = await s3c().send(new GetObjectCommand({ Bucket: bucket, Key: rest.join("/") }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  if (uri.startsWith("file://")) {
    const rel = uri.slice("file://".length);
    const file = path.resolve(config.LOCAL_STORAGE_DIR, rel);
    if (!file.startsWith(path.resolve(config.LOCAL_STORAGE_DIR))) throw new Error("Invalid storage path");
    return fs.readFileSync(file);
  }
  throw new Error(`Unsupported storage URI ${uri}`);
}

export async function objectRetention(uri: string): Promise<{ mode: string; retainUntil: string | null }> {
  if (uri.startsWith("s3://")) {
    const [, , bucket, ...rest] = uri.split("/");
    const h = await s3c().send(new HeadObjectCommand({ Bucket: bucket, Key: rest.join("/") }));
    return { mode: h.ObjectLockMode ?? "NONE", retainUntil: h.ObjectLockRetainUntilDate?.toISOString() ?? null };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(config.LOCAL_STORAGE_DIR, uri.slice(7)) + ".retention.json", "utf8"));
    return { mode: meta.mode, retainUntil: meta.retainUntil };
  } catch { return { mode: "UNKNOWN", retainUntil: null }; }
}

// ---------- .tar.zst evidence bundles ----------

function tarHeader(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512, 0);
  const write = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  write(name, 0, 100);
  write(oct(0o644, 8), 100, 8);
  write(oct(0, 8), 108, 8);
  write(oct(0, 8), 116, 8);
  write(oct(size, 12), 124, 12);
  write(oct(Math.floor(mtime / 1000), 12), 136, 12);
  write("        ", 148, 8);
  write("0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  write(oct(sum, 7) + " ", 148, 8);
  return h;
}

export function tarZst(files: Array<{ name: string; data: Buffer | string }>): Buffer {
  const parts: Buffer[] = [];
  const now = Date.now();
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    parts.push(tarHeader(f.name, data.length, now), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.zstdCompressSync(Buffer.concat(parts));
}

export function untarZst(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const tar = zlib.zstdDecompressSync(buf);
  const out: Array<{ name: string; data: Buffer }> = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    out.push({ name, data: tar.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
