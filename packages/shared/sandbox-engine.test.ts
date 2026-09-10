/**
 * The two decisions in the engine that fail SILENTLY, which is why they are the
 * ones with tests: egress (a wrong preset expansion, or a missing warning when
 * nothing is restricted, produces a box that works perfectly and has no
 * isolation) and retention (a box destroyed after a failed download takes the
 * only copy of the build output with it, and raises nothing at the time).
 */

import { expect, test } from "bun:test";
import {
  DEFAULT_EXCLUDES,
  EGRESS_PRESETS,
  cleanupFailureNote,
  egressArgs,
  retentionReasons,
} from "./sandbox-engine.ts";

test("a preset expands to its domains as repeated --egress flags", () => {
  const { args, warning } = egressArgs({ egressPresets: ["npm"] });
  expect(args).toEqual(["--egress", "registry.npmjs.org"]);
  expect(warning).toBeUndefined();
});

test("presets compose with explicit domains", () => {
  const { args } = egressArgs({ egressPresets: ["npm"], egress: ["example.com"] });
  expect(args).toEqual(["--egress", "example.com", "--egress", "registry.npmjs.org"]);
});

test("several presets compose", () => {
  const { args } = egressArgs({ egressPresets: ["python-uv", "rust-cargo"] });
  const domains = args.filter((a) => a !== "--egress");
  expect(domains).toEqual([...EGRESS_PRESETS["python-uv"], ...EGRESS_PRESETS["rust-cargo"]]);
});

test("an unknown preset throws instead of silently allowing everything", () => {
  expect(() => egressArgs({ egressPresets: ["pypi"] })).toThrow(/Unknown egress preset 'pypi'/);
});

test("no restriction at all warns", () => {
  const { args, warning } = egressArgs({});
  expect(args).toEqual([]);
  expect(warning).toMatch(/UNRESTRICTED/);
});

test("egressAll is deliberate, so it does not warn", () => {
  const { args, warning } = egressArgs({ egressAll: true, egressPresets: ["npm"] });
  expect(args).toEqual([]);
  expect(warning).toBeUndefined();
});

test("the excludes that keep a repo off the wire are present", () => {
  for (const p of [".git", "node_modules", "target", ".venv"]) {
    expect(DEFAULT_EXCLUDES).toContain(p);
  }
});

// --- Retention: the decision that loses data when it is wrong -------------
// A box torn down after a failed download takes the only complete copy of the
// build output with it, and nothing raises an error at the time.

test("a clean run retains nothing, so the box is destroyed", () => {
  expect(retentionReasons({ sandboxId: "sb-1", infraFailure: false, exitCode: 0 })).toEqual([]);
});

test("a failed artifact pull retains the box even though the command succeeded", () => {
  const reasons = retentionReasons({
    sandboxId: "sb-1",
    infraFailure: false,
    exitCode: 0,
    artifactPullFailed: true,
    out: "dist",
    dir: "/tmp/project",
  });
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toMatch(/KEPT/);
  expect(reasons[0]).toContain("sb-1");
  expect(reasons[0]).toContain("dist");
});

test("keepOnFail does not cover a failed pull, so both are reported", () => {
  const reasons = retentionReasons({
    sandboxId: "sb-1",
    infraFailure: false,
    exitCode: 1,
    keepOnFail: true,
    artifactPullFailed: true,
    out: "dist",
  });
  expect(reasons).toHaveLength(2);
});

test("a failed pull on a failed command still retains the box", () => {
  // keepOnFail is off: without the pull check this is the case that destroys
  // a box the caller still needs.
  const reasons = retentionReasons({
    sandboxId: "sb-1",
    infraFailure: false,
    exitCode: 1,
    keepOnFail: false,
    artifactPullFailed: true,
    out: "dist",
  });
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toMatch(/pull of 'dist' FAILED/);
});

test("an infra failure retains the box and says how to reattach", () => {
  const reasons = retentionReasons({ sandboxId: "sb-1", infraFailure: true });
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain("createos sandbox exec --stream sb-1");
});

test("a nonzero exit without keepOnFail retains nothing", () => {
  expect(retentionReasons({ sandboxId: "sb-1", infraFailure: false, exitCode: 1 })).toEqual([]);
});

test("a successful pull retains nothing", () => {
  expect(
    retentionReasons({
      sandboxId: "sb-1",
      infraFailure: false,
      exitCode: 0,
      artifactPullFailed: false,
      out: "dist",
    }),
  ).toEqual([]);
});

test("a failed teardown names the box that is still costing money", () => {
  const note = cleanupFailureNote("sb-1", "connection timed out");
  expect(note).toMatch(/STILL ALLOCATED/);
  expect(note).toContain("createos sandbox rm -y sb-1");
  expect(note).toContain("connection timed out");
});
