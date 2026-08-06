import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaymentIntent } from "../src/intent.js";
import { evaluate } from "../src/policy/engine.js";
import type { PolicyConfig } from "../src/policy/types.js";

const intent: PaymentIntent = {
  network: "stellar:testnet",
  scheme: "exact",
  asset: "asset-a",
  payTo: "payee-a",
  amountUnits: 100n,
  resourceUrl: "https://api.example.test/data",
  maxTimeoutSeconds: 60,
};

const config: PolicyConfig = {
  allowedNetworks: ["stellar:testnet"],
  originAllowlist: ["https://api.example.test"],
  payToAllowlist: ["payee-a"],
  assetAllowlist: ["asset-a"],
  maxPaymentUnits: 1_000n,
  windowCapUnits: 2_000n,
  windowSeconds: 3_600,
  maxTimeoutSeconds: 60,
  autoApproveMaxUnits: 100n,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("policy evaluation order", () => {
  it.each([
    ["scheme", { scheme: "other" }, "POL-SCHEME"],
    ["network", { network: "stellar:pubnet" }, "POL-NETWORK"],
    ["origin", { resourceUrl: "https://other.example.test/data" }, "POL-ORIGIN"],
    ["payTo", { payTo: "payee-b" }, "POL-PAYTO"],
    ["asset", { asset: "asset-b" }, "POL-ASSET"],
    ["timeout", { maxTimeoutSeconds: 61 }, "POL-TIMEOUT"],
    ["maximum", { amountUnits: 1_001n }, "POL-MAX"],
  ] as const)("returns only the %s failure", (_name, change, code) => {
    const decision = evaluate(
      { ...intent, ...change } as PaymentIntent,
      config,
      0n,
      1_000,
    );

    expect(decision).toMatchObject({ outcome: "deny", code });
  });

  it("checks the rolling window after the per-payment maximum", () => {
    expect(evaluate(intent, config, 1_901n, 1_000)).toMatchObject({
      outcome: "deny",
      code: "POL-WINDOW",
    });
  });

  it("stops at the first failure when several checks fail", () => {
    expect(
      evaluate(
        {
          ...intent,
          scheme: "other",
          network: "stellar:pubnet",
          amountUnits: 0n,
        } as PaymentIntent,
        config,
        10_000n,
        1_000,
      ),
    ).toMatchObject({ code: "POL-SCHEME" });
  });

  it.each([
    [
      { intent: { scheme: "other", network: "stellar:pubnet" } },
      "POL-SCHEME",
    ],
    [
      {
        intent: {
          network: "stellar:pubnet",
          resourceUrl: "https://other.example.test/data",
        },
      },
      "POL-NETWORK",
    ],
    [
      {
        intent: {
          resourceUrl: "https://other.example.test/data",
          payTo: "payee-b",
        },
      },
      "POL-ORIGIN",
    ],
    [{ intent: { payTo: "payee-b", asset: "asset-b" } }, "POL-PAYTO"],
    [
      { intent: { asset: "asset-b", maxTimeoutSeconds: 61 } },
      "POL-ASSET",
    ],
    [
      { intent: { maxTimeoutSeconds: 61, amountUnits: 1_001n } },
      "POL-TIMEOUT",
    ],
    [{ intent: { amountUnits: 1_001n }, spent: 2_000n }, "POL-MAX"],
  ] as const)("keeps adjacent failure precedence for %s", (failure, code) => {
    expect(
      evaluate(
        { ...intent, ...failure.intent } as PaymentIntent,
        config,
        "spent" in failure ? failure.spent : 0n,
        1_000,
      ),
    ).toMatchObject({ outcome: "deny", code });
  });
});

describe("fail-closed allowlists", () => {
  it.each([
    ["allowedNetworks", [], "POL-NETWORK"],
    ["originAllowlist", [], "POL-ORIGIN"],
    ["payToAllowlist", [], "POL-PAYTO"],
    ["assetAllowlist", [], "POL-ASSET"],
  ] as const)("an empty %s denies", (field, value, code) => {
    expect(
      evaluate(intent, { ...config, [field]: value } as PolicyConfig, 0n, 1_000),
    ).toMatchObject({ outcome: "deny", code });
  });

  it("DISABLED skips each optional allowlist and emits a named warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const decision = evaluate(
      {
        ...intent,
        resourceUrl: "https://other.example.test/data",
        payTo: "payee-b",
        asset: "asset-b",
      },
      {
        ...config,
        originAllowlist: "DISABLED",
        payToAllowlist: "DISABLED",
        assetAllowlist: "DISABLED",
      },
      0n,
      1_000,
    );

    expect(decision.outcome).toBe("allow");
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "x402 policy warning: originAllowlist is DISABLED",
      "x402 policy warning: payToAllowlist is DISABLED",
      "x402 policy warning: assetAllowlist is DISABLED",
    ]);
  });

  it("does not treat unrelated opaque URLs as the same origin", () => {
    expect(
      evaluate(
        { ...intent, resourceUrl: "data:text/plain,resource" },
        { ...config, originAllowlist: ["file:///configured"] },
        0n,
        1_000,
      ),
    ).toMatchObject({ outcome: "deny", code: "POL-ORIGIN" });
  });
});

describe("policy boundaries", () => {
  it("includes exact timeout, payment, window, and automatic-approval limits", () => {
    expect(
      evaluate(
        { ...intent, amountUnits: 1_000n, maxTimeoutSeconds: 60 },
        { ...config, autoApproveMaxUnits: 1_000n },
        1_000n,
        1_000,
      ),
    ).toEqual({ outcome: "allow", reason: "Payment is within policy" });
  });

  it("requires approval one base unit above the automatic limit", () => {
    expect(
      evaluate(
        { ...intent, amountUnits: 101n },
        config,
        0n,
        1_000,
      ),
    ).toEqual({
      outcome: "approval_required",
      reason: "Payment requires approval",
    });
  });

  it.each([
    [{ maxTimeoutSeconds: 0 }, "POL-TIMEOUT"],
    [{ maxTimeoutSeconds: Number.NaN }, "POL-TIMEOUT"],
    [{ amountUnits: 0n }, "POL-MAX"],
    [{ amountUnits: -1n }, "POL-MAX"],
  ] as const)("rejects non-positive bounds", (change, code) => {
    expect(
      evaluate({ ...intent, ...change }, config, 0n, 1_000),
    ).toMatchObject({ outcome: "deny", code });
  });

  it("does not vary with wall-clock input", () => {
    expect(evaluate(intent, config, 0n, 1_000)).toEqual(
      evaluate(intent, config, 0n, 9_999_999),
    );
  });

  it("fails closed when the configured timeout cap is not finite", () => {
    expect(
      evaluate(
        intent,
        { ...config, maxTimeoutSeconds: Number.NaN },
        0n,
        1_000,
      ),
    ).toMatchObject({ outcome: "deny", code: "POL-TIMEOUT" });
  });
});
