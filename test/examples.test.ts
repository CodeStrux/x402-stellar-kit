import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const runExample = (relativePath: string) =>
  spawnSync(process.execPath, [fileURLToPath(new URL(relativePath, import.meta.url))], {
    encoding: "utf8",
    env: {},
    timeout: 10_000,
  });

describe("offline agent-surface examples", () => {
  it("runs charge-my-api to a payment challenge without configuration", () => {
    const result = runExample("../dist/examples/charge-my-api/index.js");

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("charge-my-api status: 402");
    expect(result.stdout).toContain("PAYMENT-REQUIRED: present");
  });

  it("runs pay-an-endpoint and prints only public payment identifiers", () => {
    const result = runExample("../dist/examples/pay-an-endpoint/index.js");

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/intent hash: [0-9a-f]{64}/);
    expect(result.stdout).toMatch(/tx hash: [0-9a-f]{64}/);
  });
});
