import { HEADERS, X402_VERSION, parseUnits } from "../constants.js";
import { X402KitError } from "../errors.js";
import {
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
} from "../stellar/timing.js";
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

/**
 * The payment is valid but **no money has moved yet**.
 *
 * `handle` deliberately stops here. Settling before the application handler
 * runs charges the payer for responses they never receive: a handler that
 * throws, or answers 500, has already cost them the payment, and on their side
 * a settled-but-failed request becomes a non-expiring indeterminate debit that
 * a human has to reconcile by hand.
 *
 * So the caller runs its handler first and calls `settle()` only once that
 * handler has produced a success. This is the ordering the x402 reference
 * middleware uses — verify, serve, then settle — and the adapters in this
 * package all follow it.
 *
 * `settle()` is single-use: calling it twice returns the first outcome rather
 * than paying twice.
 */
export type Verified = Readonly<{
  kind: "verified";
  settle(): Promise<Paid | Rejected>;
}>;

export type ResourceResult = Challenge | Verified | Rejected;

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

/** True when two URLs are identical but for `http:` versus `https:`. */
const differsOnlyInScheme = (received: string, configured: string): boolean => {
  try {
    const a = new URL(received);
    const b = new URL(configured);
    if (a.protocol === b.protocol) return false;
    a.protocol = b.protocol;
    return a.toString() === b.toString();
  } catch {
    return false;
  }
};

/**
 * Name what did not match, and — for the one mismatch that is almost always a
 * deployment detail rather than a bad request — what to do about it.
 *
 * A bare "Resource URL mismatch" behind a TLS terminator is a mystery 400 on
 * every paid request: the origin sees plain http, the operator configured
 * https, and nothing in the response says so. Both URLs are already known to
 * both sides — one is the operator's own configuration, the other the caller's
 * own request — so naming them discloses nothing.
 *
 * Deliberately direction-neutral: this fires just as readily when the resource
 * is configured as `http://` and the request arrived as `https://`, where
 * advice to put a terminator in front would be exactly backwards.
 */
const mismatchReason = (received: string, configured: string): string =>
  differsOnlyInScheme(received, configured)
    ? `Resource URL mismatch: received ${received}, configured ${configured}. ` +
      "These differ only in scheme. If a TLS terminator sits between the caller " +
      "and this service, the adapter has to be told to trust X-Forwarded-Proto; " +
      "otherwise correct the configured resource URL to the scheme callers use."
    : `Resource URL mismatch: received ${received}, configured ${configured}`;

export const createResourceServer = (options: ResourceServerOptions): {
  handle(req: ResourceRequest): Promise<ResourceResult>;
} => {
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
  /*
   * Refused at construction, not per request. A server advertising a two-second
   * timeout would emit challenges every conforming payer must deny, and would
   * do it silently on every call — a misconfiguration that looks to the
   * operator like "nobody is paying". Startup is where it belongs.
   */
  if (
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < MIN_TIMEOUT_SECONDS ||
    maxTimeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new X402KitError(
      `maxTimeoutSeconds must be a whole number of seconds between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`,
    );
  }
  const resource = ResourceInfoSchema.parse(options.resource);
  const requirements: PaymentRequirements = PaymentRequirementsSchema.parse({
    scheme: "exact",
    network: options.network,
    amount: parseUnits(options.price).toString(),
    asset: options.asset,
    payTo: options.payTo,
    maxTimeoutSeconds,
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
        const received = normalizeResourceUrl(req.url);
        const configured = normalizeResourceUrl(resource.url);
        if (received !== configured) {
          return {
            kind: "rejected",
            status: 400,
            reason: mismatchReason(received, configured),
          };
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

      // Verified, and nothing has moved. Settlement is the caller's to trigger
      // once its handler has actually produced the thing being paid for.
      let outcome: Promise<Paid | Rejected> | undefined;
      return {
        kind: "verified",
        settle(): Promise<Paid | Rejected> {
          // Memoised, not guarded by a boolean: two concurrent calls await the
          // same settlement rather than racing into two payments.
          outcome ??= (async (): Promise<Paid | Rejected> => {
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
          })();
          return outcome;
        },
      };
    },
  };
};
