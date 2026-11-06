import { test } from "node:test";
import assert from "node:assert/strict";

// The plugin registers a custom element at import time; provide just enough DOM for that.
(globalThis as Record<string, unknown>).HTMLElement = class {};
(globalThis as Record<string, unknown>).customElements = { get: () => true, define: () => {} };
const { renderMarkdown } = await import("./index.ts");

test("renders basic formatting", () => {
  assert.equal(renderMarkdown('Reply **"yes"** to *delete* `id`'), "<p>Reply <strong>&quot;yes&quot;</strong> to <em>delete</em> <code>id</code></p>");
  assert.equal(renderMarkdown("Images:\n- one\n- two"), "<p>Images:</p><ul><li>one</li><li>two</li></ul>");
});

test("never lets HTML through", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)> **<script>x</script>** [a](javascript:alert(1))');
  assert.ok(!out.includes("<img") && !out.includes("<script"), out);
  assert.ok(out.includes("&lt;img") && out.includes("&lt;script&gt;"), out);
});
