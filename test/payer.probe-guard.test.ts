import { describe, expect, it, vi } from "vitest";

import { Payer } from "../src/payer.js";
import type { PolicyConfig } from "../src/policy/types.js";
import { MockSigner } from "../src/signer.js";

const policy: PolicyConfig = {
  allowedNetworks: ["stellar:testnet"],
  originAllowlist: ["https://allowed.example.test"],
  payToAllowlist: ["payee-a"],
  assetAllowlist: ["asset-a"],
  maxPaymentUnits: 1_000n,
  windowCapUnits: 2_000n,
  windowSeconds: 3_600,
  maxTimeoutSeconds: 60,
  autoApproveMaxUnits: 100n,
};

const guardedPayer = () => {
  const fetchLike = vi.fn(async (): Promise<Response> => {
    throw new Error("fetchLike must not be called for a denied origin");
  }) as unknown as typeof globalThis.fetch;
  const payer = new Payer({
    signer: new MockSigner("payer-a"),
    policy,
    fetchLike,
  });

  return { fetchLike, payer };
};

describe("payer probe origin guard", () => {
  it("denies probe before invoking fetchLike", async () => {
    const { fetchLike, payer } = guardedPayer();

    await expect(
      payer.probe("http://169.254.169.254/latest/meta-data"),
    ).rejects.toMatchObject({ name: "PolicyDenied", code: "POL-ORIGIN" });
    expect(fetchLike).not.toHaveBeenCalled();
  });

  it("denies pay before invoking fetchLike", async () => {
    const { fetchLike, payer } = guardedPayer();

    await expect(
      payer.pay("http://169.254.169.254/latest/meta-data"),
    ).rejects.toMatchObject({ name: "PolicyDenied", code: "POL-ORIGIN" });
    expect(fetchLike).not.toHaveBeenCalled();
  });
});
