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
        } as unknown as PaymentIntent,
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

/**
 * The defect this covers: the timeout check was
 * `Number.isFinite(...) && > 0 && <= config.maxTimeoutSeconds`. Two properties
 * were lost porting the original policy engine, which required a whole number
 * in 10..300: the floor, and integrality.
 *
 * The floor is the one that costs money. A hostile resource server advertising
 * a two-second timeout gets a payment signed with time bounds already close to
 * expired. It can never settle — but the payer transmitted it, and
 * `markIndeterminate` turned the reservation into a non-expiring debit only a
 * human can clear. Repeat that and the rolling budget drains without a single
 * payment landing.
 *
 * Every value below is chosen to be **accepted by the old check**: each is
 * greater than zero and at or under the configured 60. Reusing the existing
 * `0`, `NaN` or `61` cases would prove nothing, because those already denied.
 */
describe("the payment timeout has a floor, and must be whole seconds", () => {
  it.each([
    ["just under the floor", 9],
    ["a two-second window no ledger can honour", 2],
    ["one second", 1],
    ["a fractional timeout", 30.5],
  ] as const)("denies %s", (_name, maxTimeoutSeconds) => {
    expect(
      evaluate({ ...intent, maxTimeoutSeconds }, config, 0n, 1_000),
    ).toMatchObject({ outcome: "deny", code: "POL-TIMEOUT" });
  });

  it("allows exactly the floor", () => {
    // Pinned so a later tightening of the floor cannot pass unnoticed.
    expect(
      evaluate({ ...intent, maxTimeoutSeconds: 10 }, config, 0n, 1_000),
    ).toMatchObject({ outcome: "allow" });
  });

  it("denies consistently when an operator configures a cap below the floor", () => {
    // A throw would be a different failure mode; `evaluate` runs on untrusted
    // input and its contract is to return decisions.
    expect(
      evaluate(
        { ...intent, maxTimeoutSeconds: 10 },
        { ...config, maxTimeoutSeconds: 5 },
        0n,
        1_000,
      ),
    ).toMatchObject({ outcome: "deny", code: "POL-TIMEOUT" });
  });
});
