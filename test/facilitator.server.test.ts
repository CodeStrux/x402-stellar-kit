import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HEADERS } from "../src/constants.js";
import type { Facilitator } from "../src/facilitator/index.js";
import { MockFacilitator } from "../src/facilitator/mock.js";
import { type PaymentIntent, canonicalJson } from "../src/intent.js";
import { createResourceServer } from "../src/server/resource.js";
import { MockSigner } from "../src/signer.js";
import {
  decodePaymentRequired,
  decodeSettlementResponse,
  encodePaymentPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type VerifyResponse,
} from "../src/wire.js";

const payer = "payer-a";
const payTo = "payee-a";
const asset = "asset-a";
const network = "stellar:testnet";
const resourceUrl = "https://example.test/data";

const createPayload = async (): Promise<{
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}> => {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    amount: "100000",
    asset,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
  const intent: PaymentIntent = {
    network,
    scheme: "exact",
    asset,
    payTo,
    amountUnits: 100_000n,
    resourceUrl,
    maxTimeoutSeconds: 60,
  };
  const signer = new MockSigner(payer);
  const signed = await signer.sign(intent);
  return {
    requirements,
    payload: {
      x402Version: 2,
      resource: { url: resourceUrl },
      accepted: requirements,
      payload: signed,
    },
  };
};

describe("MockFacilitator", () => {
  it("tracks balances and returns a deterministic settlement hash", async () => {
    const facilitator = new MockFacilitator(payer);
    facilitator.credit(payer, 200_000n);
    const { payload, requirements } = await createPayload();

    expect(await facilitator.verify(payload, requirements)).toEqual({
      isValid: true,
      payer,
    });
    const settlement = await facilitator.settle(payload, requirements);

    expect(settlement).toMatchObject({
      success: true,
      network,
      payer,
      transaction: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(facilitator.balance(payer)).toBe(100_000n);
    expect(facilitator.balance(payTo)).toBe(100_000n);
    expect(settlement.transaction).toBe(
      createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    );
  });

  it("rejects insufficient funds without changing balances", async () => {
    const facilitator = new MockFacilitator(payer);
    facilitator.credit(payer, 99_999n);
    const { payload, requirements } = await createPayload();

    expect(await facilitator.verify(payload, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "Insufficient funds",
    });
    expect((await facilitator.settle(payload, requirements)).success).toBe(false);
    expect(facilitator.balance(payer)).toBe(99_999n);
    expect(facilitator.balance(payTo)).toBe(0n);
  });

  it("never settles the same transaction twice", async () => {
    const facilitator = new MockFacilitator(payer);
    facilitator.credit(payer, 300_000n);
    const { payload, requirements } = await createPayload();

    expect((await facilitator.settle(payload, requirements)).success).toBe(true);
    expect((await facilitator.settle(payload, requirements)).success).toBe(false);
    expect(facilitator.balance(payer)).toBe(200_000n);
  });

  it("rejects alternate encodings of an already settled mock transaction", async () => {
    const facilitator = new MockFacilitator(payer);
    facilitator.credit(payer, 300_000n);
    const { payload, requirements } = await createPayload();
    const decoded = JSON.parse(
      Buffer.from(payload.payload.transaction, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(decoded).reverse());
    const alternateTransaction = Buffer.from(
      JSON.stringify(reordered, null, 2),
      "utf8",
    ).toString("base64");

    expect((await facilitator.settle(payload, requirements)).success).toBe(true);
    expect(
      (
        await facilitator.settle(
          {
            ...payload,
            payload: { transaction: alternateTransaction },
          },
          requirements,
        )
      ).success,
    ).toBe(false);
    expect(facilitator.balance(payer)).toBe(200_000n);
  });

  it("rejects a non-canonical base64 alias for the same fake XDR bytes", async () => {
    const facilitator = new MockFacilitator(payer);
    facilitator.credit(payer, 300_000n);
    const { payload, requirements } = await createPayload();
    const transaction = payload.payload.transaction;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const padding = transaction.endsWith("==") ? 2 : 1;
    const characterIndex = transaction.length - padding - 1;
    const originalValue = alphabet.indexOf(transaction[characterIndex]);
    const unusedBits = padding === 2 ? 4 : 2;
    const aliasValue = originalValue | 1;
    expect(originalValue & ((1 << unusedBits) - 1)).toBe(0);
    expect(aliasValue).not.toBe(originalValue);
    const alias = `${transaction.slice(0, characterIndex)}${alphabet[aliasValue]}${transaction.slice(characterIndex + 1)}`;
    expect(Buffer.from(alias, "base64")).toEqual(
      Buffer.from(transaction, "base64"),
    );

    expect((await facilitator.settle(payload, requirements)).success).toBe(true);
    expect(
      (
        await facilitator.settle(
          { ...payload, payload: { transaction: alias } },
          requirements,
        )
      ).success,
    ).toBe(false);
    expect(facilitator.balance(payer)).toBe(200_000n);
  });

  it("rejects accepted requirements that differ from the chosen requirement", async () => {
    const facilitator = new MockFacilitator(payer);
    facilitator.credit(payer, 200_000n);
    const { payload, requirements } = await createPayload();

    expect(
      await facilitator.verify(
        { ...payload, accepted: { ...payload.accepted, payTo: "other" } },
        requirements,
      ),
    ).toMatchObject({ isValid: false });
  });
});

describe("resource server", () => {
  it("returns an encoded payment challenge without a signature", async () => {
    const facilitator = new MockFacilitator(payer);
    const server = createResourceServer({
      price: "0.01",
      payTo,
      asset,
      network,
      facilitator,
      resource: { url: resourceUrl, description: "Paid data" },
    });

    const result = await server.handle({ method: "GET", url: resourceUrl, headers: {} });

    expect(result.kind).toBe("challenge");
    expect(result.status).toBe(402);
    if (result.kind !== "challenge") throw new Error("expected challenge");
    expect(decodePaymentRequired(result.headers[HEADERS.paymentRequired])).toMatchObject({
      x402Version: 2,
      resource: { url: resourceUrl },
      accepts: [{ amount: "100000", payTo, asset, network }],
    });
    expect(
      decodePaymentRequired(result.headers[HEADERS.paymentRequired]).accepts[0]
        .extra,
    ).toEqual({ areFeesSponsored: true });
  });

  it("verifies before settling and returns an encoded settlement", async () => {
    const calls: string[] = [];
    const { payload } = await createPayload();
    const settlement: SettlementResponse = {
      success: true,
      transaction: "a".repeat(64),
      network,
      payer,
    };
    const facilitator: Facilitator = {
      verify: async (): Promise<VerifyResponse> => {
        calls.push("verify");
        return { isValid: true, payer };
      },
      settle: async (): Promise<SettlementResponse> => {
        calls.push("settle");
        return settlement;
      },
    };
    const server = createResourceServer({
      price: "0.01",
      payTo,
      asset,
      network,
      facilitator,
      resource: { url: resourceUrl },
    });

    const result = await server.handle({
      method: "GET",
      url: resourceUrl,
      headers: { "payment-signature": encodePaymentPayload(payload) },
    });

    expect(calls).toEqual(["verify", "settle"]);
    expect(result.kind).toBe("paid");
    if (result.kind !== "paid") throw new Error("expected paid");
    expect(decodeSettlementResponse(result.headers[HEADERS.paymentResponse])).toEqual(
      settlement,
    );
  });

  it("never settles a payload that verification rejected", async () => {
    const calls: string[] = [];
    const { payload } = await createPayload();
    const facilitator: Facilitator = {
      verify: async () => {
        calls.push("verify");
        return { isValid: false, invalidReason: "bad binding" };
      },
      settle: async () => {
        calls.push("settle");
        throw new Error("must not settle");
      },
    };
    const server = createResourceServer({
      price: "0.01",
      payTo,
      asset,
      network,
      facilitator,
      resource: { url: resourceUrl },
    });

    const result = await server.handle({
      method: "GET",
      url: resourceUrl,
      headers: { [HEADERS.paymentSignature]: encodePaymentPayload(payload) },
    });

    expect(calls).toEqual(["verify"]);
    expect(result).toMatchObject({ kind: "rejected", status: 402 });
  });

  it("rejects a payload for a different resource before facilitator calls", async () => {
    const calls: string[] = [];
    const { payload } = await createPayload();
    const facilitator: Facilitator = {
      verify: async () => {
        calls.push("verify");
        return { isValid: true, payer };
      },
      settle: async () => {
        calls.push("settle");
        return {
          success: true,
          transaction: "a".repeat(64),
          network,
          payer,
        };
      },
    };
    const server = createResourceServer({
      price: "0.01",
      payTo,
      asset,
      network,
      facilitator,
      resource: { url: resourceUrl },
    });

    const result = await server.handle({
      method: "GET",
      url: resourceUrl,
      headers: {
        [HEADERS.paymentSignature]: encodePaymentPayload({
          ...payload,
          resource: { url: "https://other.example.test/data" },
        }),
      },
    });

    expect(calls).toEqual([]);
    expect(result.kind).toBe("rejected");
  });

  it("returns a rejection for a malformed payload resource URL", async () => {
    const { payload } = await createPayload();
    const facilitator: Facilitator = {
      verify: async () => {
        throw new Error("must not verify");
      },
      settle: async () => {
        throw new Error("must not settle");
      },
    };
    const server = createResourceServer({
      price: "0.01",
      payTo,
      asset,
      network,
      facilitator,
      resource: { url: resourceUrl },
    });

    await expect(
      server.handle({
        method: "GET",
        url: resourceUrl,
        headers: {
          [HEADERS.paymentSignature]: encodePaymentPayload({
            ...payload,
            resource: { url: "not a URL" },
          }),
        },
      }),
    ).resolves.toMatchObject({ kind: "rejected", status: 400 });
  });
});
