import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateProbeOrigin } from "../src/policy/engine.js";
import type { PolicyConfig } from "../src/policy/types.js";

const config = (
  originAllowlist: PolicyConfig["originAllowlist"],
): PolicyConfig => ({
  allowedNetworks: ["stellar:testnet"],
  originAllowlist,
  payToAllowlist: ["payee-a"],
  assetAllowlist: ["asset-a"],
  maxPaymentUnits: 1_000n,
  windowCapUnits: 2_000n,
  windowSeconds: 3_600,
  maxTimeoutSeconds: 60,
  autoApproveMaxUnits: 100n,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probe origin policy", () => {
  it("allows an HTTP(S) URL at an allowlisted origin", () => {
    expect(
      evaluateProbeOrigin(
        "https://api.example.test:443/data?item=1",
        config(["https://api.example.test"]),
      ),
    ).toMatchObject({ outcome: "allow" });
  });

  it.each([
    [
      "a non-allowlisted origin",
      "https://internal.example.test/data",
      ["https://api.example.test"],
      /not allowed/i,
    ],
    [
      "a non-HTTP URL",
      "file:///etc/passwd",
      ["https://api.example.test"],
      /HTTP/i,
    ],
    [
      "a non-parsing URL",
      "not a URL",
      ["https://api.example.test"],
      /invalid|parse/i,
    ],
    [
      "an empty allowlist",
      "https://api.example.test/data",
      [],
      /not allowed/i,
    ],
  ] as const)("denies %s", (_name, url, allowlist, reason) => {
    expect(evaluateProbeOrigin(url, config(allowlist))).toMatchObject({
      outcome: "deny",
      code: "POL-ORIGIN",
      reason: expect.stringMatching(reason),
    });
  });

  it("warns and skips only the origin allowlist when it is DISABLED", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      evaluateProbeOrigin(
        "https://unlisted.example.test/data",
        config("DISABLED"),
      ),
    ).toMatchObject({ outcome: "allow" });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "x402 policy warning: originAllowlist is DISABLED",
    );
  });
});
