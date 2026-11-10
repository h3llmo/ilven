import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { makePreview, PreviewCache } from "./previews.ts";

const photo = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#c33" } }).jpeg().withExif({ IFD0: { Make: "Phone" } }).toBuffer();

test("previews are small WebP copies, never larger than the original, without metadata", async () => {
  const big = await photo(4000, 3000);
  const thumb = (await makePreview(big, "image/jpeg", "thumb"))!;
  const display = (await makePreview(big, "image/jpeg", "display"))!;
  const t = await sharp(thumb).metadata();
  const d = await sharp(display).metadata();
  assert.equal(t.format, "webp");
  assert.deepEqual([t.width, t.height], [480, 360]);
  assert.deepEqual([d.width, d.height], [2048, 1536]);
  assert.equal(d.exif, undefined, "no EXIF in previews");
  const small = await photo(300, 200);
  const s = await sharp((await makePreview(small, "image/jpeg", "display"))!).metadata();
  assert.deepEqual([s.width, s.height], [300, 200], "never enlarged");
});

test("a tiny image is its own preview: a preview is never larger than the original", async () => {
  const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  assert.equal(await makePreview(tiny, "image/png", "thumb"), null);
});

test("files that can't be previewed get none", async () => {
  assert.equal(await makePreview(Buffer.from("%PDF-1.7"), "application/pdf", "thumb"), null);
  assert.equal(await makePreview(Buffer.from("not an image"), "image/jpeg", "thumb"), null);
});

test("the source preview cache is bounded and per user", () => {
  const c = new PreviewCache(1000);
  c.set("alice|icloud|1|thumb", Buffer.alloc(100));
  c.set("bob|icloud|1|thumb", Buffer.alloc(100));
  assert.ok(c.get("alice|icloud|1|thumb"));
  c.dropUser("alice");
  assert.equal(c.get("alice|icloud|1|thumb"), null);
  assert.ok(c.get("bob|icloud|1|thumb"));
  for (let i = 0; i < 20; i++) c.set(`bob|s|${i}|thumb`, Buffer.alloc(100));
  assert.equal(c.get("bob|s|0|thumb"), null, "oldest evicted past the byte limit");
  assert.ok(c.get("bob|s|19|thumb"));
});
