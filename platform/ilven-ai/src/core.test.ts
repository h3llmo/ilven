import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { Confirmations, isAffirmative } from "./confirm.ts";
import { buildToolSet, OutOfScopeError, runChat, ScopeGuard, selectAllowedTools, type McpToolInfo, type Preset, type ToolCaller } from "./core.ts";

const schema = { type: "object", properties: { id: { type: "string" } } };
const TOOLS: McpToolInfo[] = [
  { name: "list_images", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "generate_image", inputSchema: schema },
  { name: "delete_image", inputSchema: schema, annotations: { destructiveHint: true } },
];
const preset = (tools: string[]): Preset => ({ id: "p", name: "Test", tools, rules: "" });

function fakeCaller() {
  const calls: string[] = [];
  const caller: ToolCaller = {
    list: async () => TOOLS,
    call: async (name) => { calls.push(name); return { content: [{ type: "text", text: JSON.stringify({ ok: name }) }] }; },
    close: async () => {},
  };
  return { caller, calls };
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A model that requests the given tool calls on its first step, then answers with text. */
function scriptedModel(toolCalls: { name: string; args: object }[]) {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      if (step === 1 && toolCalls.length)
        return {
          content: toolCalls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `c${i}`, toolName: c.name, input: JSON.stringify(c.args) })),
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage, warnings: [],
        };
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "end_turn" }, usage, warnings: [] };
    },
  });
}

const confirmations = new Confirmations(randomBytes(32));
const deps = (caller: ToolCaller, model = scriptedModel([])) => ({ model, caller, confirmations, sub: "user-1", appId: "pilot" });

test("empty preset: refused without calling the model or the app", async () => {
  const { caller, calls } = fakeCaller();
  const model = scriptedModel([{ name: "generate_image", args: {} }]);
  const r = await runChat("Pilot", preset([]), { messages: [{ role: "user", content: "make a cat" }] }, deps(caller, model));
  assert.equal(r.refused, "empty_preset");
  assert.equal(calls.length, 0);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("only preset tools are offered to the model", async () => {
  assert.deepEqual(selectAllowedTools(TOOLS, ["list_images", "not_on_server"]).map((t) => t.name), ["list_images"]);
  const { caller } = fakeCaller();
  const model = scriptedModel([]);
  await runChat("Pilot", preset(["list_images"]), { messages: [{ role: "user", content: "hi" }] }, deps(caller, model));
  const offered = (model.doGenerateCalls[0].tools ?? []).map((t: { name: string }) => t.name);
  assert.deepEqual(offered, ["list_images"]);
});

test("a call to a tool outside the preset is never executed", async () => {
  const { caller, calls } = fakeCaller();
  const model = scriptedModel([{ name: "generate_image", args: {} }, { name: "list_images", args: {} }]);
  const r = await runChat("Pilot", preset(["list_images"]), { messages: [{ role: "user", content: "make a cat" }] }, deps(caller, model));
  assert.deepEqual(calls, ["list_images"]);
  assert.deepEqual(r.actions.map((a) => a.tool), ["list_images"]);
});

test("guard rejects out-of-scope tools even if handed one", () => {
  assert.throws(() => new ScopeGuard(preset(["a"])).assert("b"), OutOfScopeError);
  const { caller } = fakeCaller();
  assert.throws(() => buildToolSet(TOOLS, preset(["list_images"]), deps(caller), { actions: [] }), OutOfScopeError);
});

test("destructive tools require an explicit, matching confirmation", async () => {
  const { caller, calls } = fakeCaller();
  const ask = await runChat("Pilot", preset(["delete_image"]), { messages: [{ role: "user", content: "delete image 1" }] }, deps(caller, scriptedModel([{ name: "delete_image", args: { id: "1" } }])));
  assert.equal(calls.length, 0);
  assert.ok(ask.pendingConfirmation);
  const token = ask.pendingConfirmation!.token;

  // A non-affirmative reply does not unlock the action.
  const msgs = (reply: string) => [{ role: "user" as const, content: "delete image 1" }, { role: "assistant" as const, content: "Confirm?" }, { role: "user" as const, content: reply }];
  await runChat("Pilot", preset(["delete_image"]), { messages: msgs("hmm, not sure"), confirmation: token }, deps(caller, scriptedModel([{ name: "delete_image", args: { id: "1" } }])));
  assert.equal(calls.length, 0);

  // Confirmation is bound to the exact arguments.
  await runChat("Pilot", preset(["delete_image"]), { messages: msgs("yes"), confirmation: token }, deps(caller, scriptedModel([{ name: "delete_image", args: { id: "2" } }])));
  assert.equal(calls.length, 0);

  await runChat("Pilot", preset(["delete_image"]), { messages: msgs("yes"), confirmation: token }, deps(caller, scriptedModel([{ name: "delete_image", args: { id: "1" } }])));
  assert.deepEqual(calls, ["delete_image"]);

  // Single use.
  await runChat("Pilot", preset(["delete_image"]), { messages: msgs("yes"), confirmation: token }, deps(caller, scriptedModel([{ name: "delete_image", args: { id: "1" } }])));
  assert.equal(calls.length, 1);
});

test("affirmative detection is conservative", () => {
  for (const s of ["yes", "Yes!", "ok", "go ahead", "confirm", "oui"]) assert.ok(isAffirmative(s), s);
  for (const s of ["no", "yes but not that one", "maybe", "what?"]) assert.ok(!isAffirmative(s), s);
});
