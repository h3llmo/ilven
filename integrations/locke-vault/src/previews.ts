import sharp from "sharp";

/**
 * Small copies of an image for viewing: `thumb` for grids, `display` for a full-screen view on a phone or a laptop.
 * The original is only ever sent for a download, a push to documents or an app that processes it (Locke's GPU jobs).
 * Previews are WebP, oriented, without metadata (no location, no device), and never larger than the original.
 */
export const PREVIEW_SIZES = ["thumb", "display"] as const;
export type PreviewSize = (typeof PREVIEW_SIZES)[number];
export const PREVIEW_TYPE = "image/webp";

const SPEC: Record<PreviewSize, { side: number; quality: number }> = {
  thumb: { side: 480, quality: 70 },
  display: { side: 2048, quality: 82 },
};
const PREVIEWABLE = /^image\/(png|jpeg|gif|webp|avif)$/;

sharp.concurrency(1);
sharp.cache(false);

// At most two images decoded at once: a grid of 60 new tiles must not decode 60 photos in parallel.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

/**
 * A preview of `bytes`, or null when the type can't be previewed (PDF, HEIC…), the image can't be read, or the
 * original is already as small (tiny images): the original then serves as its own preview.
 */
export async function makePreview(bytes: Buffer, type: string, size: PreviewSize): Promise<Buffer | null> {
  if (!PREVIEWABLE.test(type)) return null;
  const { side, quality } = SPEC[size];
  return slot(async () => {
    try {
      return await sharp(bytes, { failOn: "error", limitInputPixels: 120_000_000 })
        .rotate()
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 2 })
        .toBuffer()
        .then((out) => (out.length < bytes.length ? out : null));
    } catch {
      return null;
    }
  });
}

/**
 * Previews of files that aren't stored in the vault (source items), kept in memory for a while: browsing an album
 * twice doesn't fetch every photo twice. Bounded in bytes; plaintext lives only in this process's memory.
 */
export class PreviewCache {
  private map = new Map<string, { at: number; bytes: Buffer }>();
  private total = 0;
  constructor(private maxBytes = 64 * 1024 * 1024, private ttlMs = 15 * 60_000) {}
  get(k: string): Buffer | null {
    const e = this.map.get(k);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) { this.drop(k); return null; }
    this.map.delete(k); // most recently used last
    this.map.set(k, e);
    return e.bytes;
  }
  set(k: string, bytes: Buffer) {
    if (bytes.length > this.maxBytes / 8) return;
    this.drop(k);
    this.map.set(k, { at: Date.now(), bytes });
    this.total += bytes.length;
    for (const [old] of this.map) {
      if (this.total <= this.maxBytes) break;
      this.drop(old);
    }
  }
  /** Forget everything of one user (e.g. on disconnect). Keys start with the user's sub. */
  dropUser(sub: string) { for (const k of [...this.map.keys()]) if (k.startsWith(`${sub}|`)) this.drop(k); }
  clear() { this.map.clear(); this.total = 0; }
  private drop(k: string) {
    const e = this.map.get(k);
    if (e) { this.total -= e.bytes.length; this.map.delete(k); }
  }
}
