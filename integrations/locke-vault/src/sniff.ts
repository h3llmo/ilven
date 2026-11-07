/** Detects the real file type from its bytes. The declared content type and file name are never trusted. */
export const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/avif", "application/pdf"] as const;
export type Accepted = (typeof ACCEPTED)[number];

export function sniff(b: Buffer): Accepted | null {
  const at = (off: number, s: string) => b.length >= off + s.length && b.toString("latin1", off, off + s.length) === s;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "%PDF-")) return "application/pdf";
  if (at(4, "ftyp")) {
    const brand = b.toString("latin1", 8, 12);
    if (["avif", "avis"].includes(brand)) return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return null;
}

export const EXT: Record<Accepted, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/avif": "avif",
  "application/pdf": "pdf",
};
