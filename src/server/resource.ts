import { HEADERS, X402_VERSION, parseUnits } from "../constants.js";
import type { Facilitator } from "../facilitator/index.js";
import { canonicalJson, normalizeResourceUrl } from "../intent.js";
import {
  PaymentRequirementsSchema,
  ResourceInfoSchema,
  decodePaymentPayload,
  encodePaymentRequired,
  encodeSettlementResponse,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
} from "../wire.js";

export type RequestHeaders =
  | Readonly<Record<string, string | undefined>>
  | Readonly<{ get(name: string): string | null }>;

export type ResourceRequest = Readonly<{
  method: string;
  url: string;
  headers: RequestHeaders;
}>;

export type Challenge = Readonly<{
  kind: "challenge";
  status: 402;
  headers: Readonly<Record<string, string>>;
}>;

export type Paid = Readonly<{
  kind: "paid";
  status: 200;
  settlement: SettlementResponse;
  headers: Readonly<Record<string, string>>;
}>;

export type Rejected = Readonly<{
  kind: "rejected";
  status: 400 | 402;
  reason: string;
}>;

export type ResourceResult = Challenge | Paid | Rejected;

export type ResourceServerOptions = Readonly<{
  price: string;
  payTo: string;
  asset: string;
  network: string;
  maxTimeoutSeconds?: number;
  facilitator: Facilitator;
  resource: ResourceInfo;
}>;

const headerValue = (headers: RequestHeaders, name: string): string | undefined => {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
};

export const createResourceServer = (options: ResourceServerOptions): {
  handle(req: ResourceRequest): Promise<ResourceResult>;
} => {
  const resource = ResourceInfoSchema.parse(options.resource);
  const requirements: PaymentRequirements = PaymentRequirementsSchema.parse({
    scheme: "exact",
    network: options.network,
    amount: parseUnits(options.price).toString(),
    asset: options.asset,
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
    extra: { areFeesSponsored: true },
  });
  const challenge: Challenge = Object.freeze({
    kind: "challenge",
    status: 402,
    headers: Object.freeze({
      [HEADERS.paymentRequired]: encodePaymentRequired({
        x402Version: X402_VERSION,
        error: "Payment required",
        resource,
        accepts: [requirements],
      }),
    }),
  });

  return {
    async handle(req: ResourceRequest): Promise<ResourceResult> {
      try {
        if (normalizeResourceUrl(req.url) !== normalizeResourceUrl(resource.url)) {
          return { kind: "rejected", status: 400, reason: "Resource URL mismatch" };
        }
      } catch {
        return { kind: "rejected", status: 400, reason: "Invalid resource URL" };
      }

      const signature = headerValue(req.headers, HEADERS.paymentSignature);
      if (signature === undefined) {
        return challenge;
      }

      let payload;
      try {
        payload = decodePaymentPayload(signature);
      } catch {
        return { kind: "rejected", status: 400, reason: "Invalid payment payload" };
      }

      let bindingMatches = false;
      try {
        bindingMatches =
          canonicalJson(payload.accepted) === canonicalJson(requirements) &&
          payload.resource != null &&
          normalizeResourceUrl(payload.resource.url) ===
            normalizeResourceUrl(resource.url);
      } catch {
        bindingMatches = false;
      }
      if (!bindingMatches) {
        return { kind: "rejected", status: 400, reason: "Payment binding mismatch" };
      }

      const verification = await options.facilitator.verify(payload, requirements);
      if (!verification.isValid) {
        return {
          kind: "rejected",
          status: 402,
          reason: verification.invalidReason ?? "Payment verification failed",
        };
      }

      const settlement = await options.facilitator.settle(payload, requirements);
      if (!settlement.success) {
        return { kind: "rejected", status: 402, reason: "Payment settlement failed" };
      }

      return {
        kind: "paid",
        status: 200,
        settlement,
        headers: {
          [HEADERS.paymentResponse]: encodeSettlementResponse(settlement),
        },
      };
    },
  };
};
