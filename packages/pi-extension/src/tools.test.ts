import assert from "node:assert/strict";
import { test } from "node:test";

import { computerAction, registerTools } from "./tools.ts";

test("registers the compact desktop surface", () => {
  const tools: Array<{ name: string }> = [];
  registerTools(
    {
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      on() {},
      getFlag() {
        return undefined;
      },
    } as never,
    () => null,
  );

  assert.deepEqual(
    tools
      .filter((tool) =>
        ["sandbox_desktop", "sandbox_computer", "sandbox_screenshot"].includes(tool.name),
      )
      .map((tool) => ({ name: tool.name })),
    [{ name: "sandbox_desktop" }, { name: "sandbox_computer" }, { name: "sandbox_screenshot" }],
  );
  assert.equal(
    tools.some((tool) => tool.name.startsWith("sandbox_desktop_")),
    false,
  );
});

test("maps every sandbox_computer operation", () => {
  assert.deepEqual(computerAction({ op: "screen" }), { op: "screen" });
  assert.deepEqual(computerAction({ op: "cursor" }), { op: "cursor" });
  assert.deepEqual(computerAction({ op: "windows" }), { op: "windows" });
  assert.deepEqual(computerAction({ op: "move", x: 1, y: 2 }), { op: "move", x: 1, y: 2 });
  assert.deepEqual(computerAction({ op: "click" }), { op: "click", x: undefined, y: undefined });
  assert.deepEqual(computerAction({ op: "type", text: "hello" }), { op: "type", text: "hello" });
  assert.deepEqual(computerAction({ op: "key", keys: ["ctrl", "l"] }), {
    op: "key",
    keys: ["ctrl", "l"],
  });
  assert.deepEqual(computerAction({ op: "open", target: "https://example.test" }), {
    op: "open",
    target: "https://example.test",
  });
});

test("rejects incomplete sandbox_computer operations", () => {
  assert.throws(() => computerAction({ op: "move", x: 1 }), /move needs x and y/);
  assert.throws(() => computerAction({ op: "click", y: 1 }), /click needs both x and y/);
  assert.throws(() => computerAction({ op: "type" }), /type needs text/);
  assert.throws(() => computerAction({ op: "key", keys: [] }), /key needs a non-empty keys array/);
  assert.throws(() => computerAction({ op: "open" }), /open needs a target/);
  assert.throws(() => computerAction({ op: "invalid" }), /unknown desktop operation/);
});
