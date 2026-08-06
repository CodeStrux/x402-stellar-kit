import { once } from "node:events";
import { createServer } from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { HEADERS } from "../../src/constants.js";
import { decodePaymentRequired, decodeSettlementResponse } from "../../src/wire.js";
import { x402Express } from "../../src/server/adapters/express.js";
import {
  adapterConfig,
  httpGet,
  httpGetWithBody,
  httpPost,
  PAYER,
  signatureFor,
} from "./helpers.js";

describe("x402Express", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      ),
    );
  });

  it("challenges an unpaid request and calls next after payment", async () => {
    const app = express();
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an internet socket");
    }
    const resourceUrl = `http://127.0.0.1:${address.port}/paid`;
    const { config } = adapterConfig(resourceUrl);
    let protectedCalls = 0;
    app.get("/paid", x402Express(config), (_request, response) => {
      protectedCalls += 1;
      response.status(204).end();
    });

    const challenge = await httpGet(resourceUrl);

    expect(challenge.status).toBe(402);
    expect(challenge.headers["content-type"]).toMatch(/^text\/plain/);
    expect(protectedCalls).toBe(0);
    const encoded = challenge.headers[HEADERS.paymentRequired.toLowerCase()];
    expect(typeof encoded).toBe("string");
    expect(decodePaymentRequired(String(encoded))).toMatchObject({
      resource: { url: resourceUrl },
      accepts: [{ amount: "100000" }],
    });

    const paid = await httpGet(resourceUrl, {
      [HEADERS.paymentSignature]: await signatureFor(String(encoded)),
    });

    expect(paid.status).toBe(204);
    expect(protectedCalls).toBe(1);
    const settlement = paid.headers[HEADERS.paymentResponse.toLowerCase()];
    expect(typeof settlement).toBe("string");
    expect(decodeSettlementResponse(String(settlement)).success).toBe(true);
  });

  it("refuses a non-GET request before payment handling", async () => {
    const app = express();
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an internet socket");
    }
    const resourceUrl = `http://127.0.0.1:${address.port}/paid`;
    const { config, facilitator } = adapterConfig(resourceUrl);
    let protectedCalls = 0;
    app.use("/paid", x402Express(config));
    app.post("/paid", (_request, response) => {
      protectedCalls += 1;
      response.status(200).send("changed state");
    });

    const response = await httpPost(resourceUrl, "change state");

    expect(response.status).toBe(405);
    expect(response.headers["content-type"]).toMatch(/^text\/plain/);
    expect(response.body).toMatch(/does not bind.*method.*body/i);
    expect(response.headers[HEADERS.paymentRequired.toLowerCase()]).toBeUndefined();
    expect(protectedCalls).toBe(0);
    expect(facilitator.balance(PAYER)).toBe(200_000n);
  });

  it("refuses a GET whose body is not bound by PaymentIntent", async () => {
    const app = express();
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an internet socket");
    }
    const resourceUrl = `http://127.0.0.1:${address.port}/paid`;
    const { config, facilitator } = adapterConfig(resourceUrl);
    let protectedCalls = 0;
    app.use("/paid", x402Express(config));
    app.get("/paid", (_request, response) => {
      protectedCalls += 1;
      response.status(200).send("changed state");
    });

    const response = await httpGetWithBody(resourceUrl, "change state");

    expect(response.status).toBe(400);
    expect(response.body).toMatch(/does not bind.*method.*body/i);
    expect(response.headers[HEADERS.paymentRequired.toLowerCase()]).toBeUndefined();
    expect(protectedCalls).toBe(0);
    expect(facilitator.balance(PAYER)).toBe(200_000n);
  });
});
