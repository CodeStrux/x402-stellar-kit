import {
  Address,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  scValToNative,
  xdr,
} from "@stellar/stellar-base";
import { describe, expect, it, vi } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { LocalFacilitator } from "../../src/facilitator/local.js";
import { WireError } from "../../src/errors.js";
import { StellarSigner } from "../../src/stellar/sign.js";
import type { SorobanResourceLimits } from "../../src/stellar/resources.js";
import type { PaymentPayload, PaymentRequirements } from "../../src/wire.js";
import {
  deterministicKeypair,
  fixedIntent,
  latestLedgerRpc,
  payerKeypair,
} from "../stellar/helpers.js";

const resourceLimits: SorobanResourceLimits = {
  maxFeeStroops: 1_000_000n,
  maxInstructions: 5_000_000,
  maxDiskReadBytes: 100_000,
  maxWriteBytes: 100_000,
  maxFootprintEntries: 32,
  maxTransactionDataBytes: 64_000,
};

const horizonFetch = (accountId: string, sequence = "42") =>
  vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ history_latest_ledger: 1_000, core_latest_ledger: 1_000 }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ account_id: accountId, sequence }),
      { status: 200 },
    );
  });

describe("LocalFacilitator", () => {
  it("simulates, adds fee-source resources, signs, submits, and polls to success", async () => {
    const feeSource = deterministicKeypair("x402 test fee source");
    const intent = fixedIntent({ amountUnits: 100_000n });
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const signed = await signer.sign(intent);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: intent.network,
      amount: intent.amountUnits.toString(),
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.maxTimeoutSeconds,
      extra: { areFeesSponsored: true },
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: intent.resourceUrl },
      accepted: requirements,
      payload: signed,
    };
    const transactionData = new SorobanDataBuilder()
      .setResourceFee(500)
      .build()
      .toXDR("base64");
    const submitted: string[] = [];
    let submittedHash = "";
    let polls = 0;
    const rpc = {
      simulateTransaction: vi.fn(async () => ({
        latestLedger: 1_001,
        transactionData,
        minResourceFee: "500",
        results: [],
      })),
      sendTransaction: vi.fn(async (xdr: string) => {
        submitted.push(xdr);
        const decoded = TransactionBuilder.fromXDR(
          xdr,
          NETWORKS.testnet.networkPassphrase,
        );
        if (!(decoded instanceof Transaction)) throw new Error("expected tx");
        submittedHash = decoded.hash().toString("hex");
        return {
          hash: submittedHash,
          status: "PENDING" as const,
          latestLedger: 1_001,
        };
      }),
      getTransaction: vi.fn(async () => {
        polls += 1;
        return polls === 1
          ? ({ status: "NOT_FOUND" as const, latestLedger: 1_001 })
          : ({
              status: "SUCCESS" as const,
              hash: submittedHash,
              ledger: 1_002,
            });
      }),
    };
    const fetchLike = horizonFetch(feeSource.publicKey());
    const facilitator = new LocalFacilitator({
      rpc,
      sourceKeypair: feeSource,
      resourceLimits,
      fetchLike,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      settlementTimeoutMs: 1_000,
    });

    await expect(facilitator.verify(payload, requirements)).resolves.toEqual({
      isValid: true,
      payer: payerKeypair.publicKey(),
    });
    const settlement = await facilitator.settle(payload, requirements);
    expect(settlement).toEqual({
      success: true,
      transaction: submittedHash,
      network: NETWORKS.testnet.caip2,
      payer: payerKeypair.publicKey(),
    });

    expect(submitted).toHaveLength(1);
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(2);
    const transaction = TransactionBuilder.fromXDR(
      submitted[0],
      NETWORKS.testnet.networkPassphrase,
    );
    expect(transaction).toBeInstanceOf(Transaction);
    if (!(transaction instanceof Transaction)) throw new Error("expected tx");
    expect(transaction.source).toBe(feeSource.publicKey());
    expect(transaction.fee).toBe("600");
    expect(transaction.signatures).toHaveLength(1);
    expect(transaction.signatures[0].hint()).toEqual(feeSource.signatureHint());
    const operation = transaction.operations[0];
    if (operation.type !== "invokeHostFunction" || operation.auth === undefined) {
      throw new Error("expected invoke auth");
    }
    const credentials = operation.auth[0].credentials().address();
    const authSignature = scValToNative(credentials.signature()) as Array<{
      public_key: Buffer;
    }>;
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(
      payerKeypair.publicKey(),
    );
    expect(StrKey.encodeEd25519PublicKey(authSignature[0].public_key)).toBe(
      payerKeypair.publicKey(),
    );
  });

  it("reports simulation rejection without submitting", async () => {
    const feeSource = deterministicKeypair("x402 rejecting fee source");
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent({ amountUnits: 100_000n });
    const signed = await signer.sign(intent);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: intent.network,
      amount: intent.amountUnits.toString(),
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.maxTimeoutSeconds,
      extra: { areFeesSponsored: true },
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: intent.resourceUrl },
      accepted: requirements,
      payload: signed,
    };
    const sendTransaction = vi.fn();
    const facilitator = new LocalFacilitator({
      sourceKeypair: feeSource,
      resourceLimits,
      rpc: {
        simulateTransaction: async () => ({
          latestLedger: 1_001,
          error: "insufficient balance",
        }),
        sendTransaction,
        getTransaction: async () => ({ status: "NOT_FOUND" as const }),
      },
      fetchLike: horizonFetch(feeSource.publicKey()),
    });

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "insufficient balance",
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects RPC-provided fees and resources above the caller's budget before signing", async () => {
    const feeSource = deterministicKeypair("x402 bounded fee source");
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent({ amountUnits: 100_000n });
    const signed = await signer.sign(intent);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: intent.network,
      amount: intent.amountUnits.toString(),
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.maxTimeoutSeconds,
      extra: { areFeesSponsored: true },
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: intent.resourceUrl },
      accepted: requirements,
      payload: signed,
    };
    const sendTransaction = vi.fn();
    const transactionData = new SorobanDataBuilder()
      .setResources(resourceLimits.maxInstructions + 1, 1, 1)
      .setResourceFee(1)
      .build()
      .toXDR("base64");
    const facilitator = new LocalFacilitator({
      sourceKeypair: feeSource,
      resourceLimits,
      rpc: {
        simulateTransaction: async () => ({
          latestLedger: 1_001,
          transactionData,
          minResourceFee: "1",
          results: [],
        }),
        sendTransaction,
        getTransaction: async () => ({ status: "NOT_FOUND" as const }),
      },
      fetchLike: horizonFetch(feeSource.publicKey()),
    });

    await expect(facilitator.settle(payload, requirements)).rejects.toBeInstanceOf(
      WireError,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects an authorization that outlives the approved timeout before simulation", async () => {
    const feeSource = deterministicKeypair("x402 expiry fee source");
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent({ amountUnits: 100_000n });
    const signed = await signer.sign(intent);
    const envelope = xdr.TransactionEnvelope.fromXDR(signed.transaction, "base64");
    const operation = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp();
    operation.auth([
      await authorizeEntry(
        operation.auth()[0],
        payerKeypair,
        5_000,
        NETWORKS.testnet.networkPassphrase,
      ),
    ]);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: intent.network,
      amount: intent.amountUnits.toString(),
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.maxTimeoutSeconds,
      extra: { areFeesSponsored: true },
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: intent.resourceUrl },
      accepted: requirements,
      payload: { transaction: envelope.toXDR("base64") },
    };
    const simulateTransaction = vi.fn();
    const facilitator = new LocalFacilitator({
      sourceKeypair: feeSource,
      resourceLimits,
      rpc: {
        simulateTransaction,
        sendTransaction: vi.fn(),
        getTransaction: async () => ({ status: "NOT_FOUND" as const }),
      },
      fetchLike: horizonFetch(feeSource.publicKey()),
    });

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: expect.stringMatching(/authorization expiration/i),
    });
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "submission ERROR",
      sendStatus: "ERROR" as const,
      terminalStatus: "NOT_FOUND" as const,
      hashMismatch: false,
      rejects: false,
    },
    {
      label: "terminal FAILED",
      sendStatus: "PENDING" as const,
      terminalStatus: "FAILED" as const,
      hashMismatch: false,
      rejects: false,
    },
    {
      label: "TRY_AGAIN_LATER",
      sendStatus: "TRY_AGAIN_LATER" as const,
      terminalStatus: "NOT_FOUND" as const,
      hashMismatch: false,
      rejects: true,
    },
    {
      label: "a mismatched submission hash",
      sendStatus: "PENDING" as const,
      terminalStatus: "SUCCESS" as const,
      hashMismatch: true,
      rejects: true,
    },
  ])("handles $label without reporting false success", async (testCase) => {
    const feeSource = deterministicKeypair(`x402 ${testCase.label} fee source`);
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent({ amountUnits: 100_000n });
    const signed = await signer.sign(intent);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: intent.network,
      amount: intent.amountUnits.toString(),
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.maxTimeoutSeconds,
      extra: { areFeesSponsored: true },
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: intent.resourceUrl },
      accepted: requirements,
      payload: signed,
    };
    const transactionData = new SorobanDataBuilder()
      .setResourceFee(500)
      .build()
      .toXDR("base64");
    let expectedHash = "";
    const facilitator = new LocalFacilitator({
      sourceKeypair: feeSource,
      resourceLimits,
      rpc: {
        simulateTransaction: async () => ({
          latestLedger: 1_001,
          transactionData,
          minResourceFee: "500",
          results: [],
        }),
        sendTransaction: async (transaction: string) => {
          const decoded = TransactionBuilder.fromXDR(
            transaction,
            NETWORKS.testnet.networkPassphrase,
          );
          if (!(decoded instanceof Transaction)) throw new Error("expected tx");
          expectedHash = decoded.hash().toString("hex");
          return {
            hash: testCase.hashMismatch ? "f".repeat(64) : expectedHash,
            status: testCase.sendStatus,
            latestLedger: 1_001,
          };
        },
        getTransaction: async () =>
          testCase.terminalStatus === "NOT_FOUND"
            ? { status: "NOT_FOUND" as const, latestLedger: 1_001 }
            : {
                status: testCase.terminalStatus,
                hash: expectedHash,
                ledger: 1_002,
              },
      },
      fetchLike: horizonFetch(feeSource.publicKey()),
      pollIntervalMs: 1,
      settlementTimeoutMs: 10,
    });

    const settlement = facilitator.settle(payload, requirements);
    if (testCase.rejects) {
      await expect(settlement).rejects.toBeInstanceOf(WireError);
    } else {
      await expect(settlement).resolves.toMatchObject({ success: false });
    }
  });

  it("bounds polling and fails closed when completion never arrives", async () => {
    const feeSource = deterministicKeypair("x402 polling timeout fee source");
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent({ amountUnits: 100_000n });
    const signed = await signer.sign(intent);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: intent.network,
      amount: intent.amountUnits.toString(),
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.maxTimeoutSeconds,
      extra: { areFeesSponsored: true },
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: intent.resourceUrl },
      accepted: requirements,
      payload: signed,
    };
    const transactionData = new SorobanDataBuilder()
      .setResourceFee(500)
      .build()
      .toXDR("base64");
    const facilitator = new LocalFacilitator({
      sourceKeypair: feeSource,
      resourceLimits,
      rpc: {
        simulateTransaction: async () => ({
          latestLedger: 1_001,
          transactionData,
          minResourceFee: "500",
          results: [],
        }),
        sendTransaction: async (transaction: string) => {
          const decoded = TransactionBuilder.fromXDR(
            transaction,
            NETWORKS.testnet.networkPassphrase,
          );
          if (!(decoded instanceof Transaction)) throw new Error("expected tx");
          return {
            hash: decoded.hash().toString("hex"),
            status: "PENDING" as const,
            latestLedger: 1_001,
          };
        },
        getTransaction: async () => ({
          status: "NOT_FOUND" as const,
          latestLedger: 1_001,
        }),
      },
      fetchLike: horizonFetch(feeSource.publicKey()),
      pollIntervalMs: 1,
      settlementTimeoutMs: 2,
    });

    await expect(facilitator.settle(payload, requirements)).rejects.toThrow(
      /did not complete/i,
    );
  });
});
