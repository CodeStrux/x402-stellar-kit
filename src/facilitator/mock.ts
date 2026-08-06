import { createHash } from "node:crypto";

import type { Facilitator } from "./index.js";
import {
  canonicalJson,
  normalizeResourceUrl,
  type PaymentIntent,
} from "../intent.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from "../wire.js";

type Validation =
  | {
      valid: true;
      payer: string;
      units: bigint;
      transactionIdentity: string;
    }
  | { valid: false; payer: string; reason: string };

const decodeMockIntent = (
  transaction: string,
): { value: unknown; text: string } => {
  if (
    transaction.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      transaction,
    )
  ) {
    throw new Error("Invalid mock transaction encoding");
  }
  const bytes = Buffer.from(transaction, "base64");
  if (bytes.toString("base64") !== transaction) {
    throw new Error("Non-canonical mock transaction encoding");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Invalid mock transaction text");
  }
  return { value: JSON.parse(text) as unknown, text };
};

export class MockFacilitator implements Facilitator {
  readonly #balances = new Map<string, bigint>();
  readonly #creditedAddresses = new Set<string>();
  readonly #settledTransactions = new Set<string>();
  readonly #payerAddress: string | undefined;

  constructor(payerAddress?: string) {
    this.#payerAddress = payerAddress;
  }

  credit(address: string, units: bigint): void {
    if (units < 0n) {
      throw new RangeError("Credit units cannot be negative");
    }
    this.#balances.set(address, this.balance(address) + units);
    this.#creditedAddresses.add(address);
  }

  balance(address: string): bigint {
    return this.#balances.get(address) ?? 0n;
  }

  #resolvePayer(): string | undefined {
    if (this.#payerAddress !== undefined) {
      return this.#payerAddress;
    }
    if (this.#creditedAddresses.size === 1) {
      return this.#creditedAddresses.values().next().value as string;
    }
    return undefined;
  }

  #validate(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Validation {
    const payer = this.#resolvePayer() ?? "";
    if (payer.length === 0) {
      return { valid: false, payer, reason: "Mock payer is ambiguous" };
    }
    if (canonicalJson(payload.accepted) !== canonicalJson(requirements)) {
      return { valid: false, payer, reason: "Accepted requirements differ" };
    }
    if (payload.resource == null) {
      return { valid: false, payer, reason: "Payment resource is missing" };
    }

    let expectedIntent: PaymentIntent;
    try {
      expectedIntent = {
        network: requirements.network,
        scheme: requirements.scheme,
        asset: requirements.asset,
        payTo: requirements.payTo,
        amountUnits: BigInt(requirements.amount),
        resourceUrl: normalizeResourceUrl(payload.resource.url),
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      };
      const decoded = decodeMockIntent(payload.payload.transaction);
      const expectedTransaction = canonicalJson(expectedIntent);
      if (decoded.text !== expectedTransaction) {
        return { valid: false, payer, reason: "Mock transaction binding differs" };
      }
      const transactionIdentity = createHash("sha256")
        .update(expectedTransaction)
        .digest("hex");
      if (this.#settledTransactions.has(transactionIdentity)) {
        return { valid: false, payer, reason: "Transaction replay rejected" };
      }

      const units = expectedIntent.amountUnits;
      if (this.balance(payer) < units) {
        return { valid: false, payer, reason: "Insufficient funds" };
      }

      return {
        valid: true,
        payer,
        units,
        transactionIdentity,
      };
    } catch {
      return { valid: false, payer, reason: "Invalid mock transaction" };
    }
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const validation = this.#validate(payload, requirements);
    return validation.valid
      ? { isValid: true, payer: validation.payer }
      : {
          isValid: false,
          invalidReason: validation.reason,
        };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    const validation = this.#validate(payload, requirements);
    const transaction = createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex");

    if (!validation.valid) {
      return {
        success: false,
        transaction,
        network: requirements.network,
        payer: validation.payer,
        errorReason: validation.reason,
      };
    }

    this.#settledTransactions.add(validation.transactionIdentity);
    if (validation.payer !== requirements.payTo) {
      this.#balances.set(
        validation.payer,
        this.balance(validation.payer) - validation.units,
      );
      this.#balances.set(
        requirements.payTo,
        this.balance(requirements.payTo) + validation.units,
      );
    }

    return {
      success: true,
      transaction,
      network: requirements.network,
      payer: validation.payer,
    };
  }
}
