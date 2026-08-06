import { createHash } from "node:crypto";

import type { PaymentRequirements } from "./wire.js";

export type PaymentIntent = Readonly<{
  network: string;
  scheme: "exact";
  asset: string;
  payTo: string;
  amountUnits: bigint;
  resourceUrl: string;
  maxTimeoutSeconds: number;
}>;

export const normalizeResourceUrl = (url: string): string => {
  const normalized = new URL(url);
  normalized.protocol = normalized.protocol.toLowerCase();
  normalized.hostname = normalized.hostname.toLowerCase();
  normalized.hash = "";
  return normalized.toString();
};

const encodePrimitive = (value: string | number | boolean | null): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Value cannot be represented as canonical JSON");
  }
  return encoded;
};

const canonicalize = (value: unknown): string => {
  if (typeof value === "bigint") {
    return encodePrimitive(value.toString());
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return encodePrimitive(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return encodePrimitive(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      items.push(
        item === undefined ||
          typeof item === "function" ||
          typeof item === "symbol"
          ? "null"
          : canonicalize(item),
      );
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (
        item !== undefined &&
        typeof item !== "function" &&
        typeof item !== "symbol"
      ) {
        entries.push(`${encodePrimitive(key)}:${canonicalize(item)}`);
      }
    }
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
};

export const canonicalJson = (value: unknown): string => canonicalize(value);

const boundIntent = (intent: PaymentIntent): PaymentIntent => ({
  network: intent.network,
  scheme: intent.scheme,
  asset: intent.asset,
  payTo: intent.payTo,
  amountUnits: intent.amountUnits,
  resourceUrl: intent.resourceUrl,
  maxTimeoutSeconds: intent.maxTimeoutSeconds,
});

/**
 * `intentHash` is the approval challenge. Whatever authorizes a payment signs
 * this hash, so changing any of these seven bound fields invalidates approval:
 * network, scheme, asset, payTo, amountUnits, resourceUrl, maxTimeoutSeconds.
 * Anything outside this deliberate list is not bound and is security-relevant.
 */
export const intentHash = (intent: PaymentIntent): string =>
  createHash("sha256").update(canonicalJson(boundIntent(intent))).digest("hex");

export const paymentIntentFromRequirement = (
  requirement: PaymentRequirements,
  resourceUrl: string,
): PaymentIntent =>
  Object.freeze({
    network: requirement.network,
    scheme: requirement.scheme,
    asset: requirement.asset,
    payTo: requirement.payTo,
    amountUnits: BigInt(requirement.amount),
    resourceUrl: normalizeResourceUrl(resourceUrl),
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
  });
