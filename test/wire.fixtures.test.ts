import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { WireError } from "../src/errors.js";
import {
  FacilitatorRequestSchema,
  PaymentPayloadSchema,
  PaymentRequiredSchema,
  SettlementResponseSchema,
  VerifyResponseSchema,
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  encodePaymentPayload,
  encodePaymentRequired,
  encodeSettlementResponse,
} from "../src/wire.js";

const fixtureUrl = (name: string): URL =>
  new URL(`../fixtures/x402/${name}`, import.meta.url);

const readJson = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(fixtureUrl(name), "utf8")) as unknown;

const encodedCases = [
  {
    name: "payment-required",
    decode: decodePaymentRequired,
    encode: encodePaymentRequired,
  },
  {
    name: "payment-payload",
    decode: decodePaymentPayload,
    encode: encodePaymentPayload,
  },
  {
    name: "settlement-response",
    decode: decodeSettlementResponse,
    encode: encodeSettlementResponse,
  },
] as const;

describe("golden wire fixtures", () => {
  for (const fixture of encodedCases) {
    it(`${fixture.name} round-trips by object semantics`, async () => {
      const encoded = await readFile(
        fixtureUrl(`${fixture.name}.encoded.txt`),
        "utf8",
      );
      const decoded = await readJson(`${fixture.name}.decoded.json`);

      expect(fixture.decode(encoded)).toEqual(decoded);
      expect(fixture.decode(fixture.encode(decoded))).toEqual(decoded);
    });
  }

  it.each([
    ["verify-request.decoded.json", FacilitatorRequestSchema],
    ["settle-request.decoded.json", FacilitatorRequestSchema],
    ["verify-response-ok.decoded.json", VerifyResponseSchema],
    ["verify-response-fail.decoded.json", VerifyResponseSchema],
    ["settle-response.decoded.json", SettlementResponseSchema],
  ] as const)("parses decoded-only fixture %s", async (name, schema) => {
    expect(schema.parse(await readJson(name))).toBeDefined();
  });

  it("preserves unknown keys at every fixed object layer", () => {
    const value = {
      x402Version: 2,
      topUnknown: "top",
      resource: {
        url: "https://example.test/data",
        resourceUnknown: true,
      },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          amount: "1",
          asset: "asset",
          payTo: "payee",
          maxTimeoutSeconds: 1,
          requirementUnknown: ["kept"],
        },
      ],
      extensions: { extensionUnknown: 1 },
    };

    expect(decodePaymentRequired(encodePaymentRequired(value))).toEqual(value);
  });

  it("keeps the transaction as an opaque string", () => {
    const value = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "1",
        asset: "asset",
        payTo: "payee",
        maxTimeoutSeconds: 1,
      },
      payload: { transaction: "not-XDR-and-not-base64" },
    };

    expect(PaymentPayloadSchema.parse(value).payload.transaction).toBe(
      "not-XDR-and-not-base64",
    );
  });

  it("accepts nullish optional wire fields", () => {
    expect(
      PaymentRequiredSchema.parse({
        x402Version: 2,
        error: null,
        resource: {
          url: "https://example.test/data",
          description: null,
          mimeType: null,
          serviceName: null,
          tags: null,
          iconUrl: null,
        },
        accepts: [
          {
            scheme: "exact",
            network: "stellar:testnet",
            amount: "1",
            asset: "asset",
            payTo: "payee",
            maxTimeoutSeconds: 1,
            extra: null,
          },
        ],
        extensions: null,
      }),
    ).toBeDefined();
  });

  it("rejects an array-valued facilitator requirement", async () => {
    const value = (await readJson("verify-request.decoded.json")) as Record<
      string,
      unknown
    >;

    expect(() =>
      FacilitatorRequestSchema.parse({
        ...value,
        paymentRequirements: [value.paymentRequirements],
      }),
    ).toThrow();
  });

  it.each(["%%%", Buffer.from("not json").toString("base64")])(
    "wraps malformed encoded input in WireError",
    (encoded) => {
      expect(() => decodePaymentRequired(encoded)).toThrow(WireError);
    },
  );
});
