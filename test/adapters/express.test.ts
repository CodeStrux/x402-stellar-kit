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

  /**
   * The defect these cover: the adapter reconstructed the request URL from
   * `request.protocol`, which behind any TLS terminator is plain `http` unless
   * the application has set `trust proxy`. The configured resource URL is
   * `https`, so the resource server's URL equality check refused **every** paid
   * request with a bare 400 that named neither URL.
   */
  describe("behind a TLS terminator", () => {
    const listen = async () => {
      const app = express();
      const server = createServer(app);
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected an internet socket");
      }
      // The socket is plain http — as an origin behind a terminator always is.
      // The operator configures the public https URL callers actually use.
      return {
        app,
        requestUrl: `http://127.0.0.1:${address.port}/paid`,
        resourceUrl: `https://127.0.0.1:${address.port}/paid`,
      };
    };

    const mount = (
      app: ReturnType<typeof express>,
      resourceUrl: string,
      trustForwardedProto: boolean,
    ) => {
      const { config } = adapterConfig(resourceUrl);
      const frameworkProtocol: string[] = [];
      app.get(
        "/paid",
        (request, _response, next) => {
          // Proof the header is doing the work: Express itself still reports
          // plain http, because `trust proxy` is off. Without this the test
          // could pass on a framework that already resolved the scheme.
          frameworkProtocol.push(request.protocol);
          next();
        },
        x402Express({ ...config, trustForwardedProto }),
        (_request, response) => response.status(204).end(),
      );
      return frameworkProtocol;
    };

    it("serves the request when told to trust the forwarded scheme", async () => {
      const { app, requestUrl, resourceUrl } = await listen();
      const frameworkProtocol = mount(app, resourceUrl, true);

      const response = await httpGet(requestUrl, { "x-forwarded-proto": "https" });

      expect(response.status).toBe(402);
      expect(response.headers[HEADERS.paymentRequired.toLowerCase()]).toBeTypeOf(
        "string",
      );
      expect(frameworkProtocol).toEqual(["http"]);
    });

    it("takes the client-facing hop from a chained forwarded header", async () => {
      const { app, requestUrl, resourceUrl } = await listen();
      mount(app, resourceUrl, true);

      const response = await httpGet(requestUrl, {
        "x-forwarded-proto": "https, http",
      });

      expect(response.status).toBe(402);
    });

    it("refuses by default, and says why", async () => {
      const { app, requestUrl, resourceUrl } = await listen();
      mount(app, resourceUrl, false);

      const response = await httpGet(requestUrl, { "x-forwarded-proto": "https" });

      // Default-deny is the point: the kit never silently trusts a header the
      // caller sets. But the refusal has to be actionable.
      expect(response.status).toBe(400);
      expect(response.body).toContain(requestUrl);
      expect(response.body).toContain(resourceUrl);
      expect(response.body).toMatch(/x-forwarded-proto/i);
    });

    it("ignores a forwarded scheme that is not http or https", async () => {
      const { app, requestUrl, resourceUrl } = await listen();
      mount(app, resourceUrl, true);

      const response = await httpGet(requestUrl, { "x-forwarded-proto": "gopher" });

      expect(response.status).toBe(400);
    });
  });
});
