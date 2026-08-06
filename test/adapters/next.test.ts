import { NextRequest } from "next/server.js";
import { describe, expect, it } from "vitest";

import { HEADERS } from "../../src/constants.js";
import { decodePaymentRequired, decodeSettlementResponse } from "../../src/wire.js";
import { x402Next } from "../../src/server/adapters/next.js";
import {
  adapterConfig,
  PAYER,
  paymentHeader,
  signatureFor,
} from "./helpers.js";

describe("x402Next", () => {
  it("challenges an unpaid request and preserves the paid route response", async () => {
    const resourceUrl = "https://example.test/paid";
    const { config } = adapterConfig(resourceUrl);
    let protectedCalls = 0;
    const get = x402Next(config)(async (_request: NextRequest, context: { id: string }) => {
      protectedCalls += 1;
      return Response.json(
        { id: context.id },
        { status: 201, headers: { "x-application": "next" } },
      );
    });

    const challenge = await get(new NextRequest(resourceUrl), { id: "first" });

    expect(challenge.status).toBe(402);
    expect(protectedCalls).toBe(0);
    expect(decodePaymentRequired(paymentHeader(challenge.headers))).toMatchObject({
      resource: { url: resourceUrl },
      accepts: [{ amount: "100000" }],
    });

    const signature = await signatureFor(paymentHeader(challenge.headers));
    const paid = await get(
      new NextRequest(resourceUrl, {
        headers: { [HEADERS.paymentSignature]: signature },
      }),
      { id: "paid" },
    );

    expect(paid.status).toBe(201);
    expect(paid.headers.get("x-application")).toBe("next");
    expect(await paid.json()).toEqual({ id: "paid" });
    expect(protectedCalls).toBe(1);
    const settlement = paid.headers.get(HEADERS.paymentResponse);
    expect(settlement).not.toBeNull();
    expect(decodeSettlementResponse(settlement ?? "").success).toBe(true);
  });

  it("refuses a non-GET request before payment handling", async () => {
    const resourceUrl = "https://example.test/paid";
    const { config, facilitator } = adapterConfig(resourceUrl);
    let protectedCalls = 0;
    const route = x402Next(config)(async () => {
      protectedCalls += 1;
      return new Response("changed state");
    });

    const response = await route(
      new NextRequest(resourceUrl, { method: "POST", body: "change state" }),
      undefined,
    );

    expect(response.status).toBe(405);
    expect(await response.text()).toMatch(/does not bind.*method.*body/i);
    expect(response.headers.get(HEADERS.paymentRequired)).toBeNull();
    expect(protectedCalls).toBe(0);
    expect(facilitator.balance(PAYER)).toBe(200_000n);
  });

  it("refuses a GET whose body is not bound by PaymentIntent", async () => {
    const resourceUrl = "https://example.test/paid";
    const { config, facilitator } = adapterConfig(resourceUrl);
    let protectedCalls = 0;
    const route = x402Next(config)(async () => {
      protectedCalls += 1;
      return new Response("changed state");
    });

    const response = await route(
      new NextRequest(resourceUrl, { headers: { "content-length": "12" } }),
      undefined,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not bind.*method.*body/i);
    expect(response.headers.get(HEADERS.paymentRequired)).toBeNull();
    expect(protectedCalls).toBe(0);
    expect(facilitator.balance(PAYER)).toBe(200_000n);
  });
});
