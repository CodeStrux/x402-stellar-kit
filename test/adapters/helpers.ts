import { request } from "node:http";

import { HEADERS } from "../../src/constants.js";
import { MockFacilitator } from "../../src/facilitator/mock.js";
import { paymentIntentFromRequirement } from "../../src/intent.js";
import type { ResourceServerOptions } from "../../src/server/resource.js";
import { MockSigner } from "../../src/signer.js";
import {
  decodePaymentRequired,
  encodePaymentPayload,
} from "../../src/wire.js";

export const PAYER = "payer-adapter";
export const PAYEE = "payee-adapter";
export const ASSET = "asset-adapter";
export const NETWORK = "stellar:testnet";

export const adapterConfig = (
  resourceUrl: string,
): { config: ResourceServerOptions; facilitator: MockFacilitator } => {
  const facilitator = new MockFacilitator(PAYER);
  facilitator.credit(PAYER, 200_000n);
  return {
    facilitator,
    config: {
      price: "0.01",
      payTo: PAYEE,
      asset: ASSET,
      network: NETWORK,
      facilitator,
      resource: {
        url: resourceUrl,
        description: "Adapter test resource",
        mimeType: "application/json",
      },
    },
  };
};

export const signatureFor = async (encodedChallenge: string): Promise<string> => {
  const challenge = decodePaymentRequired(encodedChallenge);
  const requirement = challenge.accepts[0];
  if (requirement === undefined) {
    throw new Error("Expected one payment requirement");
  }
  const transaction = await new MockSigner(PAYER).sign(
    paymentIntentFromRequirement(requirement, challenge.resource.url),
  );
  return encodePaymentPayload({
    x402Version: 2,
    resource: challenge.resource,
    accepted: requirement,
    payload: transaction,
  });
};

export type HttpResult = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}>;

export const httpGet = (
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "GET", headers }, (incoming) => {
      incoming.setEncoding("utf8");
      let body = "";
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

export const httpPost = (
  url: string,
  body: string,
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          "content-type": "text/plain",
        },
      },
      (incoming) => {
        incoming.setEncoding("utf8");
        let responseBody = "";
        incoming.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: responseBody,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });

export const httpGetWithBody = (
  url: string,
  body: string,
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "GET",
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          "content-type": "text/plain",
        },
      },
      (incoming) => {
        incoming.setEncoding("utf8");
        let responseBody = "";
        incoming.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: responseBody,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });

export const paymentHeader = (headers: Headers): string => {
  const value = headers.get(HEADERS.paymentRequired);
  if (value === null) throw new Error("Missing PAYMENT-REQUIRED");
  return value;
};
