import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { UserKey } from "./crypto.ts";
import { sniff } from "./sniff.ts";
import { HttpSource, SourceRegistry } from "./sources.ts";

const caller = { kind: "apiKey" as const, sub: "user-a", userId: "u1", credential: "ilv_test" };

test("user key: round trip, bound to its AAD, tamper-evident, other users can't read", () => {
  const a = new UserKey(randomBytes(32));
  const b = new UserKey(randomBytes(32));
  const plain = randomBytes(5000);
  const blob = a.encrypt(plain, "blob:user-a:item1:v1");
  assert.deepEqual(a.decrypt(blob, "blob:user-a:item1:v1"), plain);
  assert.ok(!blob.includes(plain.subarray(0, 64)), "ciphertext must not contain the plaintext");
  assert.throws(() => a.decrypt(blob, "blob:user-a:item2:v1"), "moving a blob to another item must fail");
  assert.throws(() => b.decrypt(blob, "blob:user-a:item1:v1"), "another user's key must fail");
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => a.decrypt(tampered, "blob:user-a:item1:v1"), "tampering must be detected");
  const sealed = a.sealJson({ title: "Holiday" }, "item:user-a:1");
  assert.deepEqual(a.openJson(sealed, "item:user-a:1"), { title: "Holiday" });
  assert.ok(!Buffer.from(sealed, "base64").toString("latin1").includes("Holiday"));
});

test("sniff: detects real types from bytes, rejects everything else", () => {
  assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(sniff(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0", "latin1")), "image/heic");
  assert.equal(sniff(Buffer.from("\0\0\0\x18ftypavif\0\0\0\0", "latin1")), "image/avif");
  assert.equal(sniff(Buffer.from("%PDF-1.7\n")), "application/pdf");
  assert.equal(sniff(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null);
  assert.equal(sniff(Buffer.from("<html><script>alert(1)</script>")), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

async function fakeSource(handler: (method: string, url: string, auth: string | undefined, body: string) => { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> }) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = handler(req.method!, req.url!, req.headers.authorization, body);
      res.writeHead(r.status ?? 200, { "content-type": r.json !== undefined ? "application/json" : "application/octet-stream", ...r.headers });
      res.end(r.json !== undefined ? JSON.stringify(r.json) : r.bytes);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/vs`, close: () => srv.close() };
}

test("HTTP source contract: forwards the user's credential, validates answers, caps file size", async () => {
  const seen: string[] = [];
  const s = await fakeSource((method, url, auth, body) => {
    seen.push(`${method} ${url} ${auth}`);
    if (url === "/vs") return { json: { name: "Fake", filters: { text: true } } };
    if (url === "/vs/query") {
      const q = JSON.parse(body);
      if (q.text === "bad") return { json: { items: [{ name: "no ref" }] } };
      return { json: { items: [{ ref: "a/1", name: "one.png", date: "2026-11-01T00:00:00.000Z" }], cursor: "next" } };
    }
    if (url === "/vs/items/a%2F1/content") return { bytes: Buffer.alloc(100, 1), headers: { "content-disposition": 'inline; filename="one.png"' } };
    if (url === "/vs/items/big/content") return { bytes: Buffer.alloc(2000, 1) };
    return { status: 404, json: { error: "not_found" } };
  });
  try {
    const src = new HttpSource("fake", s.url, 1000);
    const info = await src.info(caller);
    assert.equal(info.name, "Fake");
    assert.deepEqual(info.filters, { text: true, dateRange: false, favorite: false, collection: false, addedAfter: false });
    const page = await src.query(caller, { text: "sea", limit: 10 });
    assert.equal(page.items[0]!.ref, "a/1");
    assert.equal(page.cursor, "next");
    await assert.rejects(src.query(caller, { text: "bad", limit: 10 }), /invalid answer/);
    const f = await src.fetch(caller, "a/1");
    assert.equal(f.bytes.length, 100);
    assert.equal(f.name, "one.png");
    await assert.rejects(src.fetch(caller, "big"), /larger than/);
    await assert.rejects(src.fetch(caller, "missing"), /Not found/);
    assert.ok(seen.every((l) => l.endsWith("Bearer ilv_test")), "every call carries the user's own credential");
    assert.ok(seen.every((l) => l.startsWith("GET") || l.startsWith("POST /vs/query")), "the vault never writes to a source");
  } finally {
    s.close();
  }
});

test("source registry: an unreachable source is listed as unavailable, unknown ids are 404", async () => {
  const reg = new SourceRegistry([new HttpSource("gone", "http://127.0.0.1:9/vs", 1000)]);
  const list = await reg.list(caller);
  assert.equal(list[0]!.available, false);
  assert.throws(() => reg.get("nope"), /Unknown data source/);
});
