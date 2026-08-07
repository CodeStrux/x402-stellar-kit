import {
  Account,
  BASE_FEE,
  Keypair,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-base";
import { z } from "zod";

import { NETWORKS } from "../constants.js";
import { BindingDrift, WireError } from "../errors.js";
import { canonicalJson, type PaymentIntent } from "../intent.js";
import { verifyStellarBinding } from "../stellar/binding.js";
import type {
  GetTransactionResponse,
  SendTransactionResponse,
  SimulationResponse,
} from "../stellar/rpc.js";
import {
  inspectSorobanSimulation,
  validateSorobanResourceLimits,
  type InspectedSorobanSimulation,
  type SorobanResourceLimits,
} from "../stellar/resources.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from "../wire.js";
import type { Facilitator } from "./index.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60_000;
const MAX_CALL_TIMEOUT_MS = 60_000;
const MAX_SETTLEMENT_TIMEOUT_MS = 120_000;
const MAX_LEDGER_SEQUENCE = 0xffff_ffff;
const MAX_UPSTREAM_LEDGER_DRIFT = 20;

type LocalRpc = Readonly<{
  simulateTransaction(
    transaction: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<SimulationResponse>;
  sendTransaction(
    transaction: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<SendTransactionResponse>;
  getTransaction(
    hash: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<GetTransactionResponse>;
}>;

export type LocalFacilitatorOptions = Readonly<{
  rpc: LocalRpc;
  sourceKeypair: Keypair;
  /** Required operator budget for any RPC-provided Soroban resources. */
  resourceLimits: SorobanResourceLimits;
  fetchLike?: typeof globalThis.fetch;
  horizonUrl?: string;
  allowHttpOnLoopback?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  settlementTimeoutMs?: number;
}>;

const HorizonAccountSchema = z
  .object({
    account_id: z.string(),
    sequence: z.string().regex(/^\d+$/),
  })
  .passthrough();
const HorizonRootSchema = z
  .object({
    history_latest_ledger: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
    core_latest_ledger: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
  })
  .passthrough();

class InvalidPayment extends Error {}

const network = (caip2: string) => {
  if (caip2 === NETWORKS.testnet.caip2) return NETWORKS.testnet;
  if (caip2 === NETWORKS.pubnet.caip2) return NETWORKS.pubnet;
  throw new InvalidPayment("Unsupported payment network");
};

const boundedInteger = (
  value: number,
  label: string,
  maximum: number,
): number => {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new WireError(`${label} must be an integer from 1 to ${maximum} ms`);
  }
  return value;
};

const sleep = async (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Settlement aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Settlement aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

type Prepared = Readonly<{
  payer: string;
  network: ReturnType<typeof network>;
  transaction: Transaction;
  simulation: Exclude<SimulationResponse, { error: string }>;
  inspected: InspectedSorobanSimulation;
}>;

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

export class LocalFacilitator implements Facilitator {
  readonly #rpc: LocalRpc;
  readonly #sourceKeypair: Keypair;
  readonly #resourceLimits: SorobanResourceLimits;
  readonly #fetchLike: typeof globalThis.fetch;
  readonly #horizonUrl: string | undefined;
  readonly #allowHttpOnLoopback: boolean;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #settlementTimeoutMs: number;
  /**
   * One settlement at a time, per instance.
   *
   * The fee source's sequence number is read from Horizon and then incremented
   * locally by `TransactionBuilder`, so two overlapping settlements build the
   * same sequence and the network refuses one of them with `tx_bad_seq`. That
   * refusal lands on a payer who has already transmitted their signature and
   * already recorded a non-expiring indeterminate debit: a race in here becomes
   * somebody else's manual reconciliation, for a payment they authorized
   * correctly.
   *
   * The lock is held across the poll, not released at submission, and that is
   * deliberate. Horizon advances an account's sequence only when a transaction
   * is *included in a ledger*, never when it is merely accepted for submission
   * — so releasing on `PENDING` would hand the next settlement the same stale
   * sequence and rebuild the identical collision. Reserving `N+2` locally does
   * not help either: Stellar core admits at most one pending transaction per
   * source account, so the network answers `TRY_AGAIN_LATER` and only an
   * obliging test double would pretend otherwise.
   *
   * The honest consequence, stated rather than hidden: settlements through one
   * fee source are inherently serial, so throughput here is bounded by ledger
   * close time — roughly one settlement every five seconds per instance. A
   * deployment that needs more needs more fee sources, not a cleverer lock.
   */
  #settlements: Promise<unknown> = Promise.resolve();

  constructor(options: LocalFacilitatorOptions) {
    if (!options.sourceKeypair.canSign()) {
      throw new WireError("Local facilitator fee source must contain a signing key");
    }
    this.#rpc = options.rpc;
    this.#sourceKeypair = options.sourceKeypair;
    this.#resourceLimits = validateSorobanResourceLimits(options.resourceLimits);
    this.#fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
    this.#horizonUrl = options.horizonUrl;
    this.#allowHttpOnLoopback = options.allowHttpOnLoopback === true;
    this.#signal = options.signal ?? new AbortController().signal;
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Local facilitator timeout",
      MAX_CALL_TIMEOUT_MS,
    );
    this.#pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "Local facilitator poll interval",
      5_000,
    );
    this.#settlementTimeoutMs = boundedInteger(
      options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS,
      "Local facilitator settlement timeout",
      MAX_SETTLEMENT_TIMEOUT_MS,
    );
  }

  toJSON(): string {
    return "[redacted]";
  }

  #payerAndIntent(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): { payer: string; intent: PaymentIntent; transaction: Transaction } {
    if (canonicalJson(payload.accepted) !== canonicalJson(requirements)) {
      throw new InvalidPayment("Accepted payment requirements differ");
    }
    if (requirements.extra?.areFeesSponsored !== true) {
      throw new InvalidPayment("Local facilitator requires sponsored fees");
    }
    const selectedNetwork = network(requirements.network);
    let transaction: Transaction;
    let payer: unknown;
    try {
      const decoded = TransactionBuilder.fromXDR(
        payload.payload.transaction,
        selectedNetwork.networkPassphrase,
      );
      if (!(decoded instanceof Transaction)) {
        throw new Error("unsupported envelope type");
      }
      transaction = decoded;
      const operation = decoded.operations[0];
      if (operation?.type !== "invokeHostFunction") {
        throw new Error("missing contract invocation");
      }
      payer = scValToNative(operation.func.invokeContract().args()[0]);
    } catch (error) {
      throw new InvalidPayment(
        error instanceof Error ? error.message : "Invalid transaction XDR",
      );
    }
    if (typeof payer !== "string") {
      throw new InvalidPayment("Transfer payer could not be derived from XDR");
    }
    const intent: PaymentIntent = {
      network: requirements.network,
      scheme: requirements.scheme,
      asset: requirements.asset,
      payTo: requirements.payTo,
      amountUnits: BigInt(requirements.amount),
      resourceUrl: payload.resource?.url ?? "",
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    };
    try {
      verifyStellarBinding(payload.payload.transaction, intent, payer);
    } catch (error) {
      if (error instanceof BindingDrift) {
        throw new InvalidPayment(error.message);
      }
      throw error;
    }
    return { payer, intent, transaction };
  }

  #horizonBase(selectedNetwork: ReturnType<typeof network>): URL {
    let base: URL;
    try {
      base = new URL(this.#horizonUrl ?? selectedNetwork.horizonUrl);
    } catch (error) {
      throw new WireError("Horizon URL is invalid", { cause: error });
    }
    const secureTransport =
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        this.#allowHttpOnLoopback &&
        isLoopback(base.hostname));
    if (
      !secureTransport ||
      base.username.length > 0 ||
      base.password.length > 0 ||
      base.search.length > 0 ||
      base.hash.length > 0
    ) {
      throw new WireError(
        "Horizon URL must use HTTPS without credentials, query, or fragment; loopback HTTP requires explicit opt-in",
      );
    }
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
    return base;
  }

  async #fetchHorizon(url: URL, label: string): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(this.#signal.reason);
    if (this.#signal.aborted) abort();
    else this.#signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`${label} timed out`)),
      this.#timeoutMs,
    );
    try {
      const response = await this.#fetchLike(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new WireError(`${label} returned HTTP ${response.status}`);
      }
      try {
        return (await response.json()) as unknown;
      } catch (error) {
        throw new WireError(`${label} returned invalid JSON`, { cause: error });
      }
    } catch (error) {
      if (error instanceof WireError) throw error;
      throw new WireError(`${label} failed`, { cause: error });
    } finally {
      clearTimeout(timer);
      this.#signal.removeEventListener("abort", abort);
    }
  }

  async #loadTrustedLedger(
    selectedNetwork: ReturnType<typeof network>,
  ): Promise<number> {
    // Auth expiration is checked against Horizon before the signed payer entry
    // is sent to the simulation RPC. This keeps a compromised RPC from minting
    // a long-lived capability by lying about the current ledger sequence.
    const parsed = HorizonRootSchema.safeParse(
      await this.#fetchHorizon(
        this.#horizonBase(selectedNetwork),
        "Horizon ledger request",
      ),
    );
    if (!parsed.success) {
      throw new WireError("Horizon returned malformed ledger data", {
        cause: parsed.error,
      });
    }
    if (
      Math.abs(
        parsed.data.core_latest_ledger - parsed.data.history_latest_ledger,
      ) > MAX_UPSTREAM_LEDGER_DRIFT
    ) {
      throw new WireError("Horizon core and history ledgers differed too far");
    }
    return Math.max(
      parsed.data.core_latest_ledger,
      parsed.data.history_latest_ledger,
    );
  }

  async #loadSourceAccount(
    selectedNetwork: ReturnType<typeof network>,
  ): Promise<Account> {
    // stellar-sdk is intentionally not used: this small Horizon request keeps
    // custodial signing code on the audited stellar-base-only dependency path.
    const base = this.#horizonBase(selectedNetwork);
    const url = new URL(
      `accounts/${encodeURIComponent(this.#sourceKeypair.publicKey())}`,
      base,
    );
    try {
      const parsed = HorizonAccountSchema.safeParse(
        await this.#fetchHorizon(url, "Horizon account request"),
      );
      if (!parsed.success) {
        throw new WireError("Horizon returned malformed account data", {
          cause: parsed.error,
        });
      }
      if (parsed.data.account_id !== this.#sourceKeypair.publicKey()) {
        throw new WireError("Horizon returned a different source account");
      }
      return new Account(parsed.data.account_id, parsed.data.sequence);
    } catch (error) {
      if (error instanceof WireError) throw error;
      throw new WireError("Could not load the facilitator fee source", {
        cause: error,
      });
    }
  }

  async #prepare(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Prepared> {
    const binding = this.#payerAndIntent(payload, requirements);
    const selectedNetwork = network(requirements.network);
    const [source, trustedLedger] = await Promise.all([
      this.#loadSourceAccount(selectedNetwork),
      this.#loadTrustedLedger(selectedNetwork),
    ]);
    try {
      verifyStellarBinding(
        payload.payload.transaction,
        binding.intent,
        binding.payer,
        { currentLedger: trustedLedger },
      );
    } catch (error) {
      if (error instanceof BindingDrift) {
        throw new InvalidPayment(error.message);
      }
      throw error;
    }
    const envelope = binding.transaction.toEnvelope();
    const originalOperation = envelope.v1().tx().operations()[0];
    const timebounds = binding.transaction.timeBounds;
    if (timebounds === undefined) {
      throw new InvalidPayment("Sponsored transaction is missing time bounds");
    }
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: selectedNetwork.networkPassphrase,
      timebounds,
    })
      .addOperation(originalOperation)
      .build();
    const simulation = await this.#rpc.simulateTransaction(
      transaction.toXDR(),
      this.#signal,
      this.#timeoutMs,
    );
    if ("error" in simulation) {
      if (typeof simulation.error !== "string") {
        throw new WireError("Stellar RPC returned a malformed simulation error");
      }
      throw new InvalidPayment(simulation.error);
    }
    if (
      Math.abs(simulation.latestLedger - trustedLedger) >
      MAX_UPSTREAM_LEDGER_DRIFT
    ) {
      throw new WireError(
        "Soroban RPC and trusted Horizon ledger sequences differed too far",
      );
    }
    const inspected = inspectSorobanSimulation(
      simulation,
      this.#resourceLimits,
      BigInt(BASE_FEE),
    );
    return {
      payer: binding.payer,
      network: selectedNetwork,
      transaction,
      simulation,
      inspected,
    };
  }

  /**
   * Deliberately not serialized. `verify` prepares and simulates but never
   * submits, so it consumes no sequence number and cannot collide with anything
   * — and putting it behind the settlement queue would make every verification
   * wait on an unrelated payment's ledger close.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      const prepared = await this.#prepare(payload, requirements);
      return { isValid: true, payer: prepared.payer };
    } catch (error) {
      if (error instanceof InvalidPayment) {
        return { isValid: false, invalidReason: error.message };
      }
      throw error;
    }
  }

  /**
   * Queue `operation` behind every settlement already in flight on this
   * instance.
   *
   * The queue tail is stored **settled**, never rejected, and that single
   * detail is the whole of the poison-proofing: a settlement that throws hands
   * the queue on to the one waiting behind it instead of stranding every later
   * caller on a promise that will never call their handler. The caller still
   * receives its own rejection, because that is the promise returned here — the
   * failure is passed on, not swallowed.
   */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#settlements.then(operation);
    this.#settlements = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    return this.#serialize(() => this.#settle(payload, requirements));
  }

  async #settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    const prepared = await this.#prepare(payload, requirements);
    const assembled = TransactionBuilder.cloneFrom(prepared.transaction, {
      // TransactionBuilder adds sorobanData.resourceFee to this per-operation
      // classic fee. Passing the already-total fee would double-count it.
      fee: BASE_FEE,
      sorobanData: prepared.inspected.sorobanData,
    }).build();

    const originalEnvelope = prepared.transaction.toEnvelope().v1().tx();
    const assembledEnvelope = assembled.toEnvelope().v1().tx();
    let finalSorobanData: xdr.SorobanTransactionData;
    try {
      finalSorobanData = assembledEnvelope.ext().sorobanData();
    } catch (error) {
      throw new WireError("Assembled transaction omitted Soroban resource data", {
        cause: error,
      });
    }
    if (
      assembled.source !== this.#sourceKeypair.publicKey() ||
      assembled.sequence !== prepared.transaction.sequence
    ) {
      throw new WireError("Assembled transaction source or sequence changed");
    }
    if (assembled.fee !== prepared.inspected.totalFeeStroops.toString()) {
      throw new WireError("Assembled transaction fee changed before signing");
    }
    if (assembled.signatures.length !== 0) {
      throw new WireError("Assembled transaction unexpectedly contained signatures");
    }
    if (
      assembledEnvelope.operations().length !== 1 ||
      !assembledEnvelope.operations()[0]
        .toXDR()
        .equals(originalEnvelope.operations()[0].toXDR())
    ) {
      throw new WireError("Assembled transaction operation changed before signing");
    }
    if (
      !finalSorobanData.toXDR().equals(prepared.inspected.sorobanData.toXDR())
    ) {
      throw new WireError("Assembled transaction resources changed before signing");
    }
    if (
      JSON.stringify(assembled.timeBounds) !==
      JSON.stringify(prepared.transaction.timeBounds)
    ) {
      throw new WireError("Assembled transaction time bounds changed before signing");
    }

    // The envelope signature authorizes this account to pay fees and consume
    // its sequence number. The payer's separate Soroban auth entry authorizes
    // the transfer. These keys have different powers: signing as fee source
    // cannot move the payer's funds.
    const expectedHash = assembled.hash().toString("hex");
    assembled.sign(this.#sourceKeypair);
    const signatureCount: number = assembled.signatures.length;
    if (
      signatureCount !== 1 ||
      !assembled.signatures[0].hint().equals(this.#sourceKeypair.signatureHint())
    ) {
      throw new WireError("Fee source signature was not attached as expected");
    }
    const submitted = await this.#rpc.sendTransaction(
      assembled.toXDR(),
      this.#signal,
      this.#timeoutMs,
    );
    if (submitted.hash.toLowerCase() !== expectedHash) {
      throw new WireError("Stellar RPC returned a different submitted transaction hash");
    }
    if (submitted.status === "ERROR") {
      return {
        success: false,
        transaction: expectedHash,
        network: requirements.network,
        payer: prepared.payer,
      };
    }
    if (submitted.status === "TRY_AGAIN_LATER") {
      throw new WireError("Stellar RPC asked the facilitator to retry later");
    }

    const deadline = Date.now() + this.#settlementTimeoutMs;
    while (Date.now() < deadline) {
      const result = await this.#rpc.getTransaction(
        submitted.hash,
        this.#signal,
        this.#timeoutMs,
      );
      if (result.status === "SUCCESS" || result.status === "FAILED") {
        if (
          result.hash !== undefined &&
          result.hash.toLowerCase() !== expectedHash
        ) {
          throw new WireError(
            "Stellar RPC returned completion data for a different transaction hash",
          );
        }
        return {
          success: result.status === "SUCCESS",
          transaction: expectedHash,
          network: requirements.network,
          payer: prepared.payer,
        };
      }
      await sleep(
        Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())),
        this.#signal,
      );
    }
    throw new WireError(
      `Settlement ${submitted.hash} did not complete within ${this.#settlementTimeoutMs} ms`,
    );
  }
}
