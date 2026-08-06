import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { StellarSigner } from "../../src/stellar/sign.js";
import type { PaymentPayload } from "../../src/wire.js";
import {
  decodedTransfer,
  fixedIntent,
  latestLedgerRpc,
  payerKeypair,
} from "./helpers.js";

const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, shape(item)]),
    );
  }
  return typeof value;
};

describe("live x402 payload shape", () => {
  it("matches the captured payload structure while carrying a real transfer XDR", async () => {
    const fixture = JSON.parse(
      await readFile("fixtures/x402/payment-payload.decoded.json", "utf8"),
    ) as PaymentPayload;
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent({
      asset: fixture.accepted.asset,
      payTo: fixture.accepted.payTo,
      amountUnits: BigInt(fixture.accepted.amount),
      resourceUrl: fixture.resource?.url ?? "",
      maxTimeoutSeconds: fixture.accepted.maxTimeoutSeconds,
    });
    const signed = await signer.sign(intent);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: fixture.resource,
      accepted: fixture.accepted,
      payload: signed,
    };

    expect(shape(payload)).toEqual(shape(fixture));
    expect(payload.payload.transaction).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodedTransfer(payload.payload.transaction)).toMatchObject({
      contract: fixture.accepted.asset,
      method: "transfer",
      args: [payerKeypair.publicKey(), fixture.accepted.payTo, 100_000n],
    });
  });
});
