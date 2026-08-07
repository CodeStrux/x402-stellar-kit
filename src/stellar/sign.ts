import { randomBytes } from "node:crypto";

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-base";

import { NETWORKS } from "../constants.js";
import { WireError } from "../errors.js";
import type { PaymentIntent } from "../intent.js";
import type { Signer } from "../signer.js";
import { verifyStellarBinding } from "./binding.js";
import { StellarRpc, type LatestLedger } from "./rpc.js";
import {
  MAX_AUTH_WINDOW_LEDGERS,
  STELLAR_LEDGER_SECONDS,
  authorizationWindowLedgers,
} from "./timing.js";

const SPONSORED_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
/** Bounds the signed-ledger map if a caller signs without ever verifying. */
const MAX_REMEMBERED_SIGNATURES = 64;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_I128 = (1n << 127n) - 1n;

type LatestLedgerRpc = Readonly<{
  getLatestLedger(signal: AbortSignal, timeoutMs: number): Promise<LatestLedger>;
}>;

export type StellarSignerOptions = Readonly<{
  rpc?: LatestLedgerRpc;
  rpcUrl?: string;
  fetchLike?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

const network = (caip2: string) => {
  if (caip2 === NETWORKS.testnet.caip2) return NETWORKS.testnet;
  if (caip2 === NETWORKS.pubnet.caip2) return NETWORKS.pubnet;
  throw new WireError(`Unsupported Stellar network: ${caip2}`);
};

const randomNonce = (): xdr.Int64 => {
  const value = BigInt.asIntN(
    64,
    BigInt(`0x${randomBytes(8).toString("hex")}`),
  );
  return xdr.Int64.fromString(value.toString());
};

export class StellarSigner implements Signer {
  readonly #keypair: Keypair;
  readonly #rpc: LatestLedgerRpc | undefined;
  readonly #rpcUrl: string | undefined;
  readonly #fetchLike: typeof globalThis.fetch | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #timeoutMs: number;
  /**
   * The ledger this signer observed when it built each transaction.
   *
   * `verifyBinding` needs a current ledger to bound `signatureExpirationLedger`
   * — without one it can only reject an expiration of zero, which lets an
   * authorization outlive by days the window a human approved in seconds.
   * `sign` already fetched that ledger, so recording it here costs nothing and
   * is exact, where a second fetch would be both slower and slightly wrong.
   *
   * An entry is consumed by the verify that follows it. The cap is a
   * belt-and-braces bound on a map that is normally empty.
   */
  readonly #signedAtLedger = new Map<string, number>();

  private constructor(keypair: Keypair, options: StellarSignerOptions) {
    this.#keypair = keypair;
    this.#rpc = options.rpc;
    this.#rpcUrl = options.rpcUrl;
    this.#fetchLike = options.fetchLike;
    this.#signal = options.signal;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new WireError(
        `Stellar signer timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`,
      );
    }
  }

  static fromSecret(seed: string, options: StellarSignerOptions = {}): StellarSigner {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(seed);
    } catch (error) {
      throw new WireError("Invalid Stellar secret seed", { cause: error });
    }
    return new StellarSigner(keypair, options);
  }

  address(): string {
    return this.#keypair.publicKey();
  }

  toJSON(): string {
    return "[redacted]";
  }

  async sign(intent: PaymentIntent): Promise<{ transaction: string }> {
    if (
      typeof intent.amountUnits !== "bigint" ||
      intent.amountUnits < 1n ||
      intent.amountUnits > MAX_I128
    ) {
      throw new WireError("Payment amount must be a positive i128 bigint");
    }
    const selectedNetwork = network(intent.network);
    const rpcUrl = this.#rpcUrl ?? selectedNetwork.rpcUrl;
    const rpc =
      this.#rpc ??
      new StellarRpc(rpcUrl, {
        ...(this.#fetchLike === undefined ? {} : { fetchLike: this.#fetchLike }),
      });
    const signal = this.#signal ?? new AbortController().signal;
    const latest = await rpc.getLatestLedger(signal, this.#timeoutMs);
    const validUntilLedgerSeq = latest.sequence + authorizationWindowLedgers(
      intent.maxTimeoutSeconds,
    );
    if (validUntilLedgerSeq > 0xffff_ffff) {
      throw new WireError("Authorization expiration exceeds the u32 ledger range");
    }

    const unsignedOperation = new Contract(intent.asset).call(
      "transfer",
      Address.fromString(this.address()).toScVal(),
      Address.fromString(intent.payTo).toScVal(),
      nativeToScVal(intent.amountUnits, { type: "i128" }),
    );
    const hostFunction = unsignedOperation.body().invokeHostFunctionOp().hostFunction();
    const invocation = hostFunction.invokeContract();
    const unsignedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(this.address()).toScAddress(),
          nonce: randomNonce(),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          xdr.InvokeContractArgs.fromXDR(invocation.toXDR()),
        ),
        subInvocations: [],
      }),
    });
    const operationWithUnsignedEntry = Operation.invokeHostFunction({
      func: hostFunction,
      auth: [unsignedEntry],
    });
    const entry = (Operation.fromXDRObject(
      operationWithUnsignedEntry,
    ) as Operation.InvokeHostFunction).auth?.[0];
    if (entry === undefined) {
      throw new WireError("Could not construct the Soroban authorization entry");
    }
    const signedEntry = await authorizeEntry(
      entry,
      this.#keypair,
      validUntilLedgerSeq,
      selectedNetwork.networkPassphrase,
    );
    const operation = Operation.invokeHostFunction({
      func: hostFunction,
      auth: [signedEntry],
    });
    const transaction = new TransactionBuilder(
      new Account(SPONSORED_SOURCE, "0"),
      {
        fee: BASE_FEE,
        networkPassphrase: selectedNetwork.networkPassphrase,
      },
    )
      .addOperation(operation)
      .setTimeout(
        Math.min(
          intent.maxTimeoutSeconds,
          MAX_AUTH_WINDOW_LEDGERS * STELLAR_LEDGER_SECONDS,
        ),
      )
      .build();

    const xdrTransaction = transaction.toXDR();
    this.#rememberLedger(xdrTransaction, latest.sequence);
    return { transaction: xdrTransaction };
  }

  #rememberLedger(transaction: string, sequence: number): void {
    if (this.#signedAtLedger.size >= MAX_REMEMBERED_SIGNATURES) {
      // Bound the map even if a caller signs without ever verifying. Dropping
      // the oldest is safe: a missing entry falls back to asking the network.
      const oldest = this.#signedAtLedger.keys().next();
      if (!oldest.done) this.#signedAtLedger.delete(oldest.value);
    }
    this.#signedAtLedger.set(transaction, sequence);
  }

  /**
   * The check the README calls load-bearing, now actually bounding the thing
   * that carries spending authority.
   *
   * A Soroban authorization entry is signed independently of the envelope that
   * carries it, and a facilitator may rebuild that envelope — so the envelope's
   * `timeBounds` constrain nothing. `signatureExpirationLedger` is the only
   * field that limits how long the authorization can be redeemed, and bounding
   * it requires a current ledger. Without one this check could reject only an
   * expiration of exactly zero, which let a payment a human approved for sixty
   * seconds settle days later under the same intent hash.
   */
  async verifyBinding(transaction: string, intent: PaymentIntent): Promise<void> {
    const recorded = this.#signedAtLedger.get(transaction);
    this.#signedAtLedger.delete(transaction);
    // Recorded is exact and free. Anything this signer did not produce still
    // gets bounded, at the cost of one call — never skipped.
    const currentLedger = recorded ?? (await this.#latestLedgerSequence(intent));
    verifyStellarBinding(transaction, intent, this.address(), { currentLedger });
  }

  async #latestLedgerSequence(intent: PaymentIntent): Promise<number> {
    const selectedNetwork = network(intent.network);
    const rpc =
      this.#rpc ??
      new StellarRpc(this.#rpcUrl ?? selectedNetwork.rpcUrl, {
        ...(this.#fetchLike === undefined ? {} : { fetchLike: this.#fetchLike }),
      });
    const signal = this.#signal ?? new AbortController().signal;
    const latest = await rpc.getLatestLedger(signal, this.#timeoutMs);
    return latest.sequence;
  }
}
