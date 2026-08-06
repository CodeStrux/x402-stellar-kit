import { BindingDrift } from "./errors.js";
import { canonicalJson, type PaymentIntent } from "./intent.js";

export interface Signer {
  address(): string;
  sign(intent: PaymentIntent): Promise<{ transaction: string }>;
  verifyBinding(transaction: string, intent: PaymentIntent): void;
}

const boundIntent = (intent: PaymentIntent): PaymentIntent => ({
  network: intent.network,
  scheme: intent.scheme,
  asset: intent.asset,
  payTo: intent.payTo,
  amountUnits: intent.amountUnits,
  resourceUrl: intent.resourceUrl,
  maxTimeoutSeconds: intent.maxTimeoutSeconds,
});

export class MockSigner implements Signer {
  readonly #address: string;

  constructor(address: string) {
    this.#address = address;
  }

  address(): string {
    return this.#address;
  }

  async sign(intent: PaymentIntent): Promise<{ transaction: string }> {
    return {
      transaction: Buffer.from(canonicalJson(boundIntent(intent)), "utf8").toString(
        "base64",
      ),
    };
  }

  verifyBinding(transaction: string, intent: PaymentIntent): void {
    try {
      if (
        transaction.length === 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          transaction,
        )
      ) {
        throw new Error("Invalid fake XDR encoding");
      }
      const decoded = JSON.parse(
        Buffer.from(transaction, "base64").toString("utf8"),
      ) as unknown;
      if (canonicalJson(decoded) !== canonicalJson(boundIntent(intent))) {
        throw new Error("Intent fields differ");
      }
    } catch (error) {
      throw new BindingDrift(undefined, { cause: error });
    }
  }
}
