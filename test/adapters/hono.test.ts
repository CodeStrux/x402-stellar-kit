import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { HEADERS } from "../../src/constants.js";
import { decodePaymentRequired, decodeSettlementResponse } from "../../src/wire.js";
import { x402Hono } from "../../src/server/adapters/hono.js";
import {
  adapterConfig,
  PAYER,
  paymentHeader,
  signatureFor,
} from "./helpers.js";

describe("x402Hono", () => {
  it("challenges an unpaid request and runs the protected handler after payment", async () => {
    const resourceUrl = "http://localhost/paid";
    const { config } = adapterConfig(resourceUrl);
    const app = new Hono();
    let protectedCalls = 0;
    app.get("/paid", x402Hono(config), () => {
      protectedCalls += 1;
      return new Response(JSON.stringify({ message: "paid hono" }), {
        status: 203,
        headers: {
          "content-type": "application/json",
          "x-application": "raw-response",
        },
      });
    });

    const challenge = await app.request(resourceUrl);

    expect(challenge.status).toBe(402);
    expect(protectedCalls).toBe(0);
    expect(decodePaymentRequired(paymentHeader(challenge.headers))).toMatchObject({
      x402Version: 2,
      resource: { url: resourceUrl },
      accepts: [{ amount: "100000" }],
    });

    const signature = await signatureFor(paymentHeader(challenge.headers));
    const paid = await app.request(resourceUrl, {
      headers: { [HEADERS.paymentSignature]: signature },
    });

    expect(paid.status).toBe(203);
    expect(await paid.json()).toEqual({ message: "paid hono" });
    expect(paid.headers.get("x-application")).toBe("raw-response");
    expect(protectedCalls).toBe(1);
    const settlement = paid.headers.get(HEADERS.paymentResponse);
    expect(settlement).not.toBeNull();
    expect(decodeSettlementResponse(settlement ?? "").success).toBe(true);
  });

  it("refuses a non-GET request before payment handling", async () => {
    const resourceUrl = "http://localhost/paid";
    const { config, facilitator } = adapterConfig(resourceUrl);
    const app = new Hono();
    let protectedCalls = 0;
    app.use("/paid", x402Hono(config));
    app.post("/paid", (context) => {
      protectedCalls += 1;
      return context.text("changed state");
    });

    const response = await app.request(resourceUrl, {
      method: "POST",
      body: "change state",
    });

    expect(response.status).toBe(405);
    expect(await response.text()).toMatch(/does not bind.*method.*body/i);
    expect(response.headers.get(HEADERS.paymentRequired)).toBeNull();
    expect(protectedCalls).toBe(0);
    expect(facilitator.balance(PAYER)).toBe(200_000n);
  });

  it("refuses a GET whose body is not bound by PaymentIntent", async () => {
    const resourceUrl = "http://localhost/paid";
    const { config, facilitator } = adapterConfig(resourceUrl);
    const app = new Hono();
    let protectedCalls = 0;
    app.use("/paid", x402Hono(config));
    app.get("/paid", (context) => {
      protectedCalls += 1;
      return context.text("changed state");
    });

    const response = await app.request(resourceUrl, {
      headers: { "content-length": "12" },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not bind.*method.*body/i);
    expect(response.headers.get(HEADERS.paymentRequired)).toBeNull();
    expect(protectedCalls).toBe(0);
    expect(facilitator.balance(PAYER)).toBe(200_000n);
  });
});
