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

export const PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(X402_VERSION),
    error: z.string().nullish(),
    resource: ResourceInfoSchema,
    accepts: z.array(PaymentRequirementsSchema).min(1),
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
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;
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
  decode(PaymentRequiredSchema, encoded);

export const encodePaymentPayload = (value: unknown): string =>
  encode(PaymentPayloadSchema, value);
export const decodePaymentPayload = (encoded: string): PaymentPayload =>
  decode(PaymentPayloadSchema, encoded);

export const encodeSettlementResponse = (value: unknown): string =>
  encode(SettlementResponseSchema, value);
export const decodeSettlementResponse = (encoded: string): SettlementResponse =>
  decode(SettlementResponseSchema, encoded);
