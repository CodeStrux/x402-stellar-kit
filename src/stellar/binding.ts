import {
  Address,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  scValToNative,
  xdr,
} from "@stellar/stellar-base";

import { NETWORKS } from "../constants.js";
import { BindingDrift } from "../errors.js";
import type { PaymentIntent } from "../intent.js";
import { authorizationWindowLedgers } from "./timing.js";

const SPONSORED_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_LEDGER_SEQUENCE = 0xffff_ffff;

export type StellarBindingPolicy = Readonly<{
  /** Trusted current ledger used to bound the absolute auth expiration. */
  currentLedger?: number;
  /** Test hook; production callers should use the local clock. */
  nowSeconds?: number;
}>;

const drift = (field: string): never => {
  throw new BindingDrift(`Signed transaction ${field} differed from the approved intent`);
};

const networkPassphrase = (network: string): string => {
  if (network === NETWORKS.testnet.caip2) return NETWORKS.testnet.networkPassphrase;
  if (network === NETWORKS.pubnet.caip2) return NETWORKS.pubnet.networkPassphrase;
  return drift("network");
};

const assertInvocation = (
  invocation: xdr.InvokeContractArgs,
  intent: PaymentIntent,
  expectedAddress: string,
): void => {
  if (Address.fromScAddress(invocation.contractAddress()).toString() !== intent.asset) {
    drift("asset");
  }
  if (invocation.functionName().toString() !== "transfer") {
    drift("method");
  }
  const args = invocation.args();
  if (args.length !== 3) {
    drift("arguments");
  }

  let from: unknown;
  let to: unknown;
  let amount: unknown;
  try {
    [from, to, amount] = args.map(scValToNative);
  } catch (error) {
    throw new BindingDrift("Signed transaction arguments could not be decoded", {
      cause: error,
    });
  }
  if (from !== expectedAddress) drift("from");
  if (to !== intent.payTo) drift("to");
  if (typeof amount !== "bigint" || amount !== intent.amountUnits) {
    drift("amount");
  }
};

const assertSameInvocation = (
  operation: xdr.InvokeContractArgs,
  authorized: xdr.InvokeContractArgs,
): void => {
  if (
    !operation.toXDR().equals(authorized.toXDR())
  ) {
    throw new BindingDrift(
      "Signed transaction authorization invocation differed from the transfer operation",
    );
  }
};

/**
 * Decodes the artifact that would be transmitted and independently validates
 * its operation and authorization. No field is accepted merely because it was
 * present in the approved intent.
 */
export const verifyStellarBinding = (
  transaction: string,
  intent: PaymentIntent,
  expectedAddress: string,
  policy: StellarBindingPolicy = {},
): void => {
  try {
    const passphrase = networkPassphrase(intent.network);
    if (
      transaction.length === 0 ||
      Buffer.from(transaction, "base64").toString("base64") !== transaction
    ) {
      throw new BindingDrift("Signed transaction XDR was not canonical base64");
    }
    const decoded = TransactionBuilder.fromXDR(transaction, passphrase);
    if (!(decoded instanceof Transaction)) {
      throw new BindingDrift("Signed transaction envelope type was not supported");
    }
    if (decoded.source !== SPONSORED_SOURCE) drift("sponsored source");
    if (decoded.operations.length !== 1) drift("operation count");
    if (decoded.signatures.length !== 0) drift("envelope signatures");
    const timeBounds = decoded.timeBounds;
    const nowSeconds = policy.nowSeconds ?? Math.floor(Date.now() / 1_000);
    if (timeBounds === undefined) {
      throw new BindingDrift(
        "Signed transaction timeout differed from the approved intent",
      );
    }
    if (
      timeBounds.minTime !== "0" ||
      !Number.isInteger(nowSeconds) ||
      nowSeconds < 0
    ) {
      drift("timeout");
    }
    const maximumTime = BigInt(timeBounds.maxTime);
    const approvedTimeout = Math.min(intent.maxTimeoutSeconds, 600);
    if (
      maximumTime === 0n ||
      maximumTime < BigInt(Math.max(0, nowSeconds - MAX_CLOCK_SKEW_SECONDS)) ||
      maximumTime >
        BigInt(nowSeconds + Math.ceil(approvedTimeout) + MAX_CLOCK_SKEW_SECONDS)
    ) {
      drift("timeout");
    }

    const operation = decoded.operations[0];
    if (operation.type !== "invokeHostFunction") drift("operation type");
    const invokeOperation = operation as import("@stellar/stellar-base").Operation.InvokeHostFunction;
    if (invokeOperation.source !== undefined) drift("operation source");
    if (
      invokeOperation.func.switch().value !==
      xdr.HostFunctionType.hostFunctionTypeInvokeContract().value
    ) {
      drift("method");
    }
    const invocation = invokeOperation.func.invokeContract();
    assertInvocation(invocation, intent, expectedAddress);

    const auth = invokeOperation.auth;
    if (auth === undefined || auth.length !== 1) {
      drift("authorization entry count");
    }
    const entry = auth![0];
    if (
      entry.credentials().switch().value !==
      xdr.SorobanCredentialsType.sorobanCredentialsAddress().value
    ) {
      drift("authorization signer");
    }
    const credentials = entry.credentials().address();
    if (Address.fromScAddress(credentials.address()).toString() !== expectedAddress) {
      drift("authorization signer");
    }
    const expiration = credentials.signatureExpirationLedger();
    if (expiration === 0) {
      drift("authorization expiration");
    }
    if (policy.currentLedger !== undefined) {
      if (
        !Number.isInteger(policy.currentLedger) ||
        policy.currentLedger < 0 ||
        policy.currentLedger > MAX_LEDGER_SEQUENCE
      ) {
        drift("current ledger");
      }
      const latestPermitted =
        policy.currentLedger + authorizationWindowLedgers(intent.maxTimeoutSeconds);
      if (expiration < policy.currentLedger || expiration > latestPermitted) {
        drift("authorization expiration");
      }
    }
    if (
      entry.rootInvocation().function().switch().value !==
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
        .value
    ) {
      drift("authorization method");
    }
    if (entry.rootInvocation().subInvocations().length !== 0) {
      drift("authorization sub-invocations");
    }
    const authorizedInvocation = entry.rootInvocation().function().contractFn();
    assertSameInvocation(invocation, authorizedInvocation);
    assertInvocation(authorizedInvocation, intent, expectedAddress);

    const nativeSignature = scValToNative(credentials.signature()) as unknown;
    if (!Array.isArray(nativeSignature) || nativeSignature.length !== 1) {
      drift("authorization signature");
    }
    const signatureRecord = (nativeSignature as unknown[])[0];
    if (
      signatureRecord === null ||
      typeof signatureRecord !== "object" ||
      !("public_key" in signatureRecord) ||
      !("signature" in signatureRecord)
    ) {
      drift("authorization signature");
    }
    const publicKey = Buffer.from(
      (signatureRecord as { public_key: Uint8Array }).public_key,
    );
    const signature = Buffer.from(
      (signatureRecord as { signature: Uint8Array }).signature,
    );
    if (
      publicKey.length !== 32 ||
      signature.length !== 64 ||
      StrKey.encodeEd25519PublicKey(publicKey) !== expectedAddress
    ) {
      drift("authorization signer");
    }

    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(passphrase, "utf8")),
        nonce: credentials.nonce(),
        invocation: entry.rootInvocation(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
      }),
    );
    const payload = hash(preimage.toXDR());
    if (!Keypair.fromPublicKey(expectedAddress).verify(payload, signature)) {
      throw new BindingDrift(
        "Signed transaction network passphrase or authorization signature differed",
      );
    }
  } catch (error) {
    if (error instanceof BindingDrift) throw error;
    throw new BindingDrift("Signed transaction XDR could not be decoded", {
      cause: error,
    });
  }
};

export { verifyStellarBinding as verifyBinding };
