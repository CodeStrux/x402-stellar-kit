import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-base";
import { z } from "zod";

import { NETWORKS } from "../constants.js";
import { WireError } from "../errors.js";
import {
  StellarRpc,
  type GetTransactionResponse,
  type SendTransactionResponse,
  type SimulationResponse,
} from "./rpc.js";
import {
  inspectSorobanSimulation,
  type SorobanResourceLimits,
} from "./resources.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_SETTLEMENT_TIMEOUT_MS = 120_000;

export const TESTNET_SAC_RESOURCE_LIMITS: SorobanResourceLimits = Object.freeze({
  maxFeeStroops: 10_000_000n,
  maxInstructions: 20_000_000,
  maxDiskReadBytes: 1_000_000,
  maxWriteBytes: 1_000_000,
  maxFootprintEntries: 100,
  maxTransactionDataBytes: 262_144,
});

const TransactionHashSchema = z
  .object({ hash: z.string().regex(/^[0-9a-fA-F]{64}$/) })
  .passthrough();
const HorizonAccountSchema = z
  .object({
    account_id: z.string(),
    sequence: z.string().regex(/^\d+$/),
  })
  .passthrough();

type FetchOptions = Readonly<{
  fetchLike?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  horizonUrl?: string;
}>;

export type FriendbotOptions = FetchOptions &
  Readonly<{
    friendbotUrl?: string;
  }>;

export type IssueDemoAssetOptions = FetchOptions &
  Readonly<{
    code: "PLAY";
    recipient: Keypair;
    issuer?: Keypair;
    trustlineRecipients?: readonly Keypair[];
    amount?: string;
  }>;

export type IssuedDemoAsset = Readonly<{
  issuer: Keypair;
  asset: Asset;
  recipient: string;
  amount: string;
  transactionHashes: readonly string[];
}>;

/**
 * A trustline is authorized by the account itself; issuance is authorized by the
 * issuer. Those are two different signatures, so they are two different functions.
 * The counterparty is a `G…` string in both, which is what makes it impossible to
 * hand either function a key its caller should never hold.
 */
export type EstablishTrustlineOptions = FetchOptions &
  Readonly<{
    account: Keypair;
    asset: Readonly<{ code: string; issuer: string }>;
    limit?: string;
  }>;

export type IssueAssetToOptions = FetchOptions &
  Readonly<{
    issuer: Keypair;
    destination: string;
    asset: Readonly<{ code: string; issuer?: string }>;
    amount: string;
  }>;

type SacRpc = Readonly<{
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

export type DeploySacOptions = FetchOptions &
  Readonly<{
    rpc?: SacRpc;
    rpcUrl?: string;
    pollIntervalMs?: number;
    settlementTimeoutMs?: number;
    resourceLimits?: SorobanResourceLimits;
  }>;

const bounded = (value: number, label: string, maximum: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new WireError(`${label} must be an integer from 1 to ${maximum} ms`);
  }
  return value;
};

const fetchWithTimeout = async (
  fetchLike: typeof globalThis.fetch,
  input: string | URL,
  init: RequestInit,
  callerSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) abort();
  else callerSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Testnet request timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    return await fetchLike(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw new WireError("Testnet HTTP request failed", { cause: error });
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", abort);
  }
};

const json = async (response: Response, label: string): Promise<unknown> => {
  if (!response.ok) {
    throw new WireError(`${label} returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new WireError(`${label} returned invalid JSON`, { cause: error });
  }
};

const baseUrl = (value: string): URL => {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
};

const loadAccount = async (
  keypair: Keypair,
  options: FetchOptions,
): Promise<Account> => {
  const fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = bounded(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "Testnet timeout",
    MAX_TIMEOUT_MS,
  );
  const response = await fetchWithTimeout(
    fetchLike,
    new URL(
      `accounts/${encodeURIComponent(keypair.publicKey())}`,
      baseUrl(options.horizonUrl ?? NETWORKS.testnet.horizonUrl),
    ),
    { method: "GET", redirect: "error" },
    signal,
    timeoutMs,
  );
  const parsed = HorizonAccountSchema.safeParse(
    await json(response, "Horizon account request"),
  );
  if (!parsed.success) {
    throw new WireError("Horizon returned malformed account data", {
      cause: parsed.error,
    });
  }
  if (parsed.data.account_id !== keypair.publicKey()) {
    throw new WireError("Horizon returned a different account");
  }
  return new Account(parsed.data.account_id, parsed.data.sequence);
};

const submitHorizon = async (
  transaction: Transaction,
  options: FetchOptions,
): Promise<string> => {
  const fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = bounded(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "Testnet timeout",
    MAX_TIMEOUT_MS,
  );
  const body = new URLSearchParams({ tx: transaction.toXDR() });
  const response = await fetchWithTimeout(
    fetchLike,
    new URL("transactions", baseUrl(options.horizonUrl ?? NETWORKS.testnet.horizonUrl)),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
    },
    signal,
    timeoutMs,
  );
  const parsed = TransactionHashSchema.safeParse(
    await json(response, "Horizon transaction submission"),
  );
  if (!parsed.success) {
    throw new WireError("Horizon returned malformed transaction data", {
      cause: parsed.error,
    });
  }
  return parsed.data.hash;
};

const buildAndSubmit = async (
  keypair: Keypair,
  operation: ReturnType<typeof Operation.changeTrust> | ReturnType<typeof Operation.payment>,
  options: FetchOptions,
): Promise<string> => {
  const source = await loadAccount(keypair, options);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORKS.testnet.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  transaction.sign(keypair);
  return submitHorizon(transaction, options);
};

export const generateKeypair = (): Keypair => Keypair.random();

const AMOUNT_PATTERN = /^\d+(?:\.\d{1,7})?$/;
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;

/**
 * TypeScript cannot stop a `Keypair` reaching a parameter typed `string` once the
 * call crosses a module or a JSON boundary, so the guard is a runtime one. Passing
 * a signing key where a public address belongs is the exact mistake this split
 * exists to prevent, so it gets its own message rather than a generic parse error.
 */
const requirePublicAddress = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new WireError(
      `${label} must be a G… public key string, not a Keypair — the holder of that key must not be this caller`,
    );
  }
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new WireError(`${label} must be a valid Stellar ed25519 public key`);
  }
  return value;
};

const requireAssetCode = (code: unknown, label: string): string => {
  if (typeof code !== "string" || !ASSET_CODE_PATTERN.test(code)) {
    throw new WireError(`${label} must be 1 to 12 alphanumeric characters`);
  }
  return code;
};

const requireAmount = (amount: string, label: string): string => {
  if (!AMOUNT_PATTERN.test(amount) || Number(amount) <= 0) {
    throw new WireError(`${label} must be a positive decimal with at most 7 places`);
  }
  return amount;
};

/** Establish a trustline using only the account's own signing key. */
export const establishTrustline = async (
  options: EstablishTrustlineOptions,
): Promise<string> => {
  if (!options.account.canSign()) {
    throw new WireError("The trustline account must contain a signing key");
  }
  const code = requireAssetCode(options.asset?.code, "Trustline asset code");
  const issuer = requirePublicAddress(options.asset?.issuer, "Trustline asset issuer");
  if (issuer === options.account.publicKey()) {
    throw new WireError("An issuing account cannot hold a trustline to its own asset");
  }
  if (options.limit !== undefined) {
    requireAmount(options.limit, "Trustline limit");
  }
  return buildAndSubmit(
    options.account,
    Operation.changeTrust({
      asset: new Asset(code, issuer),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }),
    options,
  );
};

/** Issue an asset to a destination using only the issuer's signing key. */
export const issueAssetTo = async (options: IssueAssetToOptions): Promise<string> => {
  if (!options.issuer.canSign()) {
    throw new WireError("The issuing account must contain a signing key");
  }
  const code = requireAssetCode(options.asset?.code, "Issued asset code");
  const destination = requirePublicAddress(options.destination, "Issuance destination");
  const issuerAddress = options.issuer.publicKey();
  if (options.asset?.issuer !== undefined) {
    const declared = requirePublicAddress(options.asset.issuer, "Issued asset issuer");
    if (declared !== issuerAddress) {
      // Otherwise a function named "issue" would submit a payment of somebody
      // else's asset: a transfer wearing an issuance's name, and a confused
      // deputy in precisely the boundary this split exists to harden.
      throw new WireError(
        `Issued asset issuer ${declared} does not match the signing issuer ${issuerAddress}`,
      );
    }
  }
  if (destination === issuerAddress) {
    throw new WireError("An issuer cannot issue to itself");
  }
  const amount = requireAmount(options.amount, "Issued amount");
  return buildAndSubmit(
    options.issuer,
    Operation.payment({ destination, asset: new Asset(code, issuerAddress), amount }),
    options,
  );
};

export const fundWithFriendbot = async (
  address: string,
  options: FriendbotOptions = {},
): Promise<string> => {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new WireError("Friendbot address must be a valid Stellar public key");
  }
  const fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = bounded(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "Friendbot timeout",
    MAX_TIMEOUT_MS,
  );
  const url = new URL(options.friendbotUrl ?? NETWORKS.testnet.friendbotUrl);
  url.searchParams.set("addr", address);
  const response = await fetchWithTimeout(
    fetchLike,
    url,
    { method: "GET", redirect: "error" },
    signal,
    timeoutMs,
  );
  const parsed = TransactionHashSchema.safeParse(await json(response, "Friendbot"));
  if (!parsed.success) {
    throw new WireError("Friendbot returned malformed transaction data", {
      cause: parsed.error,
    });
  }
  return parsed.data.hash;
};

export const issueDemoAsset = async (
  options: IssueDemoAssetOptions,
): Promise<IssuedDemoAsset> => {
  if (options.code !== "PLAY") {
    throw new WireError("The demo asset code must be PLAY");
  }
  const amount = options.amount ?? "1000";
  if (!/^\d+(?:\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    throw new WireError("PLAY amount must be a positive decimal with at most 7 places");
  }
  const issuer = options.issuer ?? generateKeypair();
  if (!issuer.canSign() || !options.recipient.canSign()) {
    throw new WireError("PLAY issuer and recipient must contain signing keys");
  }
  if (options.issuer === undefined) {
    await fundWithFriendbot(issuer.publicKey(), options);
  }
  const asset = new Asset("PLAY", issuer.publicKey());
  const recipients = new Map<string, Keypair>();
  for (const recipient of [
    options.recipient,
    ...(options.trustlineRecipients ?? []),
  ]) {
    if (!recipient.canSign()) {
      throw new WireError("Every PLAY trustline recipient must contain a signing key");
    }
    if (recipient.publicKey() !== issuer.publicKey()) {
      recipients.set(recipient.publicKey(), recipient);
    }
  }

  // Composed from the two single-key primitives. This wrapper is the only place
  // that legitimately holds both keys, which is why it is for single-process
  // demos only — a custodial deployment calls the primitives across its boundary.
  const transactionHashes: string[] = [];
  for (const recipient of recipients.values()) {
    transactionHashes.push(
      await establishTrustline({
        ...options,
        account: recipient,
        asset: { code: asset.getCode(), issuer: issuer.publicKey() },
      }),
    );
  }
  transactionHashes.push(
    await issueAssetTo({
      ...options,
      issuer,
      destination: options.recipient.publicKey(),
      asset: { code: asset.getCode(), issuer: issuer.publicKey() },
      amount,
    }),
  );
  return Object.freeze({
    issuer,
    asset,
    recipient: options.recipient.publicKey(),
    amount,
    transactionHashes: Object.freeze(transactionHashes),
  });
};

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("SAC deployment aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("SAC deployment aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** A plain asset descriptor, safe to pass across a package boundary. */
export type AssetDescriptor = Readonly<{ code: string; issuer: string }>;

/**
 * Accepts either an `Asset` or a plain `{ code, issuer }` descriptor.
 *
 * The descriptor form exists because `instanceof` is unreliable across package
 * boundaries: a caller that installs its own copy of `@stellar/stellar-base`
 * builds an `Asset` from a *different* class, and an `instanceof` check inside
 * this package rejects it. Passing data rather than a class instance sidesteps
 * that entirely, and matches `establishTrustline` and `issueAssetTo`.
 */
export const deploySacFor = async (
  assetInput: Asset | AssetDescriptor,
  sourceKeypair: Keypair,
  options: DeploySacOptions = {},
): Promise<string> => {
  if (!sourceKeypair.canSign()) {
    throw new WireError("SAC deployment source must contain a signing key");
  }
  // Duck-typed rather than `instanceof`: see the note above. A descriptor from a
  // caller's own copy of stellar-base must work exactly as well as ours.
  const asset: Asset =
    typeof (assetInput as Asset).getCode === "function"
      ? (assetInput as Asset)
      : new Asset(
          requireAssetCode((assetInput as AssetDescriptor)?.code, "SAC asset code"),
          requirePublicAddress((assetInput as AssetDescriptor)?.issuer, "SAC asset issuer"),
        );
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = bounded(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "SAC RPC timeout",
    MAX_TIMEOUT_MS,
  );
  const pollIntervalMs = bounded(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "SAC poll interval",
    5_000,
  );
  const settlementTimeoutMs = bounded(
    options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS,
    "SAC settlement timeout",
    MAX_SETTLEMENT_TIMEOUT_MS,
  );
  const rpc =
    options.rpc ??
    new StellarRpc(options.rpcUrl ?? NETWORKS.testnet.rpcUrl, {
      ...(options.fetchLike === undefined ? {} : { fetchLike: options.fetchLike }),
    });
  const source = await loadAccount(sourceKeypair, options);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORKS.testnet.networkPassphrase,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();
  const simulation = await rpc.simulateTransaction(
    transaction.toXDR(),
    signal,
    timeoutMs,
  );
  if ("error" in simulation) {
    throw new WireError(
      typeof simulation.error === "string"
        ? `SAC deployment simulation failed: ${simulation.error}`
        : "SAC deployment simulation returned a malformed error",
    );
  }
  const inspected = inspectSorobanSimulation(
    simulation,
    options.resourceLimits ?? TESTNET_SAC_RESOURCE_LIMITS,
    BigInt(BASE_FEE),
  );
  const assembled = TransactionBuilder.cloneFrom(transaction, {
    // stellar-base adds the XDR resourceFee while building the envelope.
    fee: BASE_FEE,
    sorobanData: inspected.sorobanData,
  }).build();
  const originalOperation = transaction.toEnvelope().v1().tx().operations()[0];
  const assembledEnvelope = assembled.toEnvelope().v1().tx();
  let assembledData: import("@stellar/stellar-base").xdr.SorobanTransactionData;
  try {
    assembledData = assembledEnvelope.ext().sorobanData();
  } catch (error) {
    throw new WireError("SAC deployment omitted Soroban resource data", {
      cause: error,
    });
  }
  if (assembled.source !== sourceKeypair.publicKey()) {
    throw new WireError("SAC deployment source changed before signing");
  }
  if (assembled.fee !== inspected.totalFeeStroops.toString()) {
    throw new WireError("SAC deployment fee changed before signing");
  }
  if (assembled.signatures.length !== 0) {
    throw new WireError("SAC deployment unexpectedly contained signatures");
  }
  if (
    assembledEnvelope.operations().length !== 1 ||
    !assembledEnvelope.operations()[0].toXDR().equals(originalOperation.toXDR())
  ) {
    throw new WireError("SAC deployment operation changed before signing");
  }
  if (!assembledData.toXDR().equals(inspected.sorobanData.toXDR())) {
    throw new WireError("SAC deployment resources changed before signing");
  }
  const expectedHash = assembled.hash().toString("hex");
  assembled.sign(sourceKeypair);
  const submitted = await rpc.sendTransaction(
    assembled.toXDR(),
    signal,
    timeoutMs,
  );
  if (submitted.hash.toLowerCase() !== expectedHash) {
    throw new WireError("SAC deployment RPC returned a different transaction hash");
  }
  if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
    throw new WireError(`SAC deployment submission returned ${submitted.status}`);
  }
  const deadline = Date.now() + settlementTimeoutMs;
  while (Date.now() < deadline) {
    const result = await rpc.getTransaction(submitted.hash, signal, timeoutMs);
    if (result.status === "SUCCESS") {
      if (
        result.hash !== undefined &&
        result.hash.toLowerCase() !== expectedHash
      ) {
        throw new WireError(
          "SAC deployment RPC returned completion for a different hash",
        );
      }
      return asset.contractId(NETWORKS.testnet.networkPassphrase);
    }
    if (result.status === "FAILED") {
      throw new WireError(`SAC deployment transaction ${submitted.hash} failed`);
    }
    await delay(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
      signal,
    );
  }
  throw new WireError(
    `SAC deployment transaction ${submitted.hash} did not complete in time`,
  );
};
