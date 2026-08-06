import { createHash } from "node:crypto";

import {
  Address,
  Keypair,
  TransactionBuilder,
  scValToNative,
  type Operation,
} from "@stellar/stellar-base";

import { NETWORKS } from "../../src/constants.js";
import type { PaymentIntent } from "../../src/intent.js";

export const deterministicKeypair = (label: string): Keypair =>
  Keypair.fromRawEd25519Seed(createHash("sha256").update(label).digest());

export const payerKeypair = deterministicKeypair("x402-stellar-kit test payer");
export const merchantKeypair = deterministicKeypair(
  "x402-stellar-kit test merchant",
);

export const fixedIntent = (
  overrides: Partial<PaymentIntent> = {},
): PaymentIntent => ({
  network: NETWORKS.testnet.caip2,
  scheme: "exact",
  asset: NETWORKS.testnet.usdcContract,
  payTo: merchantKeypair.publicKey(),
  amountUnits: 9_007_199_254_740_993n,
  resourceUrl: "https://resource.example.test/paid",
  maxTimeoutSeconds: 60,
  ...overrides,
});

export const latestLedgerRpc = (sequence = 1_000) => ({
  getLatestLedger: async () => ({
    id: "ledger-id",
    sequence,
    protocolVersion: 25,
  }),
});

export const decodedTransfer = (transaction: string): {
  tx: import("@stellar/stellar-base").Transaction;
  operation: Operation.InvokeHostFunction;
  contract: string;
  method: string;
  args: unknown[];
} => {
  const tx = TransactionBuilder.fromXDR(
    transaction,
    NETWORKS.testnet.networkPassphrase,
  ) as import("@stellar/stellar-base").Transaction;
  const operation = tx.operations[0] as Operation.InvokeHostFunction;
  const invocation = operation.func.invokeContract();
  return {
    tx,
    operation,
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    method: invocation.functionName().toString(),
    args: invocation.args().map(scValToNative),
  };
};
