import { z } from "zod";

import { X402_VERSION } from "./constants.js";
import { WireError } from "./errors.js";

export const PaymentRequirementsSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string(),
    amount: z.string().regex(/^\d+$/),
    asset: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const ResourceInfoSchema = z
  .object({
    url: z.string(),
    description: z.string().nullish(),
    mimeType: z.string().nullish(),
    serviceName: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    iconUrl: z.string().nullish(),
  })
  .passthrough();

/**
 * An offer on a rail this kit cannot pay, carried instead of rejected.
 *
 * A 402 may legitimately advertise several schemes at once. Failing the whole
 * array because one entry is not `exact` throws away a payable offer sitting
 * right beside it, and reports "malformed wire data" where the honest answer is
 * `POL-SCHEME` — a denial the kit documents and, before this, could never
 * actually produce.
 *
 * `.strip()`, not `.passthrough()`: nothing here ever reads a field of an offer
 * it cannot pay, and `encodePaymentRequired` would faithfully re-serialise
 * whatever was retained. Carrying `{ scheme }` alone keeps unvalidated foreign
 * content from making a round trip through our own wire.
 *
 * The refinement matters. Without it a *malformed* `exact` offer would fall
 * through to this branch, survive as `{ scheme: "exact" }`, pass the scheme
 * filter downstream, and arrive at intent construction with its amount and
 * payee missing. An offer claiming our scheme must satisfy our schema; only
 * genuinely foreign schemes are waved past.
 */
const UnsupportedOfferSchema = z
  .object({ scheme: z.string() })
  .strip()
  .refine((offer) => offer.scheme !== "exact", {
    message: "an offer using the exact scheme must satisfy the full requirements schema",
  });

const OfferSchema = z.union([PaymentRequirementsSchema, UnsupportedOfferSchema]);

/**
 * What this kit is willing to **emit**: only offers it could itself honour.
 *
 * A resource server built on this package must never advertise a scheme it
 * cannot settle, so the encode path stays strict even though the decode path
 * below is deliberately generous.
 */
export const PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    error: z.string().nullish(),
    resource: ResourceInfoSchema,
    accepts: z.array(PaymentRequirementsSchema).min(1),
    extensions: z.record(z.unknown()).nullish(),
  })
  .passthrough();

/**
 * What this kit is willing to **accept**. Identical but for `accepts`, which
 * tolerates offers on other rails. Be strict in what you emit, generous in what
 * you receive — and let policy, not the parser, decide what gets paid.
 *
 * Generous about *schemes*, not about structure: a null or non-object entry is
 * a broken peer rather than a foreign rail, and is still refused outright.
 */
export const PaymentChallengeSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    error: z.string().nullish(),
    resource: ResourceInfoSchema,
    accepts: z.array(OfferSchema).min(1),
    extensions: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const TransactionPayloadSchema = z
  .object({
    transaction: z.string(),
  })
  .passthrough();

export const PaymentPayloadSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    resource: ResourceInfoSchema.nullish(),
    accepted: PaymentRequirementsSchema,
    payload: TransactionPayloadSchema,
  })
  .passthrough();

export const SettlementResponseSchema = z
  .object({
    success: z.boolean(),
    transaction: z.string(),
    network: z.string(),
    payer: z.string(),
  })
  .passthrough();

export const VerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    payer: z.string().nullish(),
    invalidReason: z.string().nullish(),
  })
  .passthrough();

export const FacilitatorRequestSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    paymentPayload: PaymentPayloadSchema,
    paymentRequirements: PaymentRequirementsSchema,
  })
  .passthrough();

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;
export type PaymentOffer = z.infer<typeof OfferSchema>;
/**
 * A decoded challenge. `accepts` is the *received* shape, so it may hold offers
 * on rails this kit cannot pay; narrow with `isExactOffer` before using one.
 */
export type PaymentRequired = z.infer<typeof PaymentChallengeSchema>;

/**
 * The only sanctioned way to go from a received offer to something payable.
 * A plain `offer.scheme === "exact"` comparison does not narrow the union,
 * because the unsupported branch is typed with a plain `string`.
 */
export const isExactOffer = (offer: PaymentOffer): offer is PaymentRequirements =>
  offer.scheme === "exact";
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;
export type SettlementResponse = z.infer<typeof SettlementResponseSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type FacilitatorRequest = z.infer<typeof FacilitatorRequestSchema>;

const encode = <T>(schema: z.ZodType<T>, value: unknown): string => {
  try {
    const parsed = schema.parse(value);
    return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64");
  } catch (error) {
    throw new WireError("Cannot encode invalid x402 wire data", { cause: error });
  }
};

const decodeBase64 = (encoded: string): string => {
  const value = encoded.trim();
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new TypeError("Invalid base64");
  }

  return Buffer.from(value, "base64").toString("utf8");
};

const decode = <T>(schema: z.ZodType<T>, encoded: string): T => {
  try {
    return schema.parse(JSON.parse(decodeBase64(encoded)) as unknown);
  } catch (error) {
    if (error instanceof WireError) {
      throw error;
    }
    throw new WireError("Cannot decode invalid x402 wire data", { cause: error });
  }
};

export const encodePaymentRequired = (value: unknown): string =>
  encode(PaymentRequiredSchema, value);
export const decodePaymentRequired = (encoded: string): PaymentRequired =>
  decode(PaymentChallengeSchema, encoded);

export const encodePaymentPayload = (value: unknown): string =>
  encode(PaymentPayloadSchema, value);
export const decodePaymentPayload = (encoded: string): PaymentPayload =>
  decode(PaymentPayloadSchema, encoded);

export const encodeSettlementResponse = (value: unknown): string =>
  encode(SettlementResponseSchema, value);
export const decodeSettlementResponse = (encoded: string): SettlementResponse =>
  decode(SettlementResponseSchema, encoded);
