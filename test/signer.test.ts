import { describe, expect, it } from "vitest";

import { BindingDrift } from "../src/errors.js";
import { canonicalJson, type PaymentIntent } from "../src/intent.js";
import { MockSigner } from "../src/signer.js";

const intent: PaymentIntent = {
  network: "stellar:testnet",
  scheme: "exact",
  asset: "asset-a",
  payTo: "payee-a",
  amountUnits: 10n,
  resourceUrl: "https://example.test/data",
  maxTimeoutSeconds: 60,
};

describe("MockSigner", () => {
  it("produces deterministic reversible fake XDR", async () => {
    const signer = new MockSigner("payer-a");
    const first = await signer.sign(intent);
    const second = await signer.sign(intent);

    expect(first).toEqual(second);
    expect(Buffer.from(first.transaction, "base64").toString("utf8")).toBe(
      canonicalJson(intent),
    );
    expect(signer.address()).toBe("payer-a");
  });

  it("accepts a transaction bound to every intent field", async () => {
    const signer = new MockSigner("payer-a");
    const { transaction } = await signer.sign(intent);

    expect(() => signer.verifyBinding(transaction, intent)).not.toThrow();
  });

  it.each([
    ["network", "stellar:pubnet"],
    ["scheme", "other"],
    ["asset", "asset-b"],
    ["payTo", "payee-b"],
    ["amountUnits", 11n],
    ["resourceUrl", "https://example.test/other"],
    ["maxTimeoutSeconds", 61],
  ] as const)("throws BindingDrift when %s changes", async (field, value) => {
    const signer = new MockSigner("payer-a");
    const { transaction } = await signer.sign(intent);

    expect(() =>
      signer.verifyBinding(transaction, {
        ...intent,
        [field]: value,
      } as PaymentIntent),
    ).toThrow(BindingDrift);
  });

  it("throws BindingDrift for malformed fake XDR", () => {
    const signer = new MockSigner("payer-a");

    expect(() => signer.verifyBinding("%%%", intent)).toThrow(BindingDrift);
  });
});
