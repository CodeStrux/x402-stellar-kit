import {
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-base";
import { describe, expect, it, vi } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { LocalFacilitator } from "../../src/facilitator/local.js";
import type { SorobanResourceLimits } from "../../src/stellar/resources.js";
import { StellarSigner } from "../../src/stellar/sign.js";
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

const intent = fixedIntent({ amountUnits: 100_000n });

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: intent.network,
  amount: intent.amountUnits.toString(),
  asset: intent.asset,
  payTo: intent.payTo,
  maxTimeoutSeconds: intent.maxTimeoutSeconds,
  extra: { areFeesSponsored: true },
};

/**
 * Two independently signed payments for the same requirements. `sign` draws a
 * fresh nonce each time, so these are genuinely different transactions — not a
 * replay, which the facilitator would be right to refuse for another reason.
 */
const twoPayments = async (): Promise<[PaymentPayload, PaymentPayload]> => {
  const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
    rpc: latestLedgerRpc(),
  });
  const build = async (): Promise<PaymentPayload> => ({
    x402Version: 2,
    resource: { url: intent.resourceUrl },
    accepted: requirements,
    payload: await signer.sign(intent),
  });
  return [await build(), await build()];
};

/**
 * A test double that obeys the one Horizon rule this fix turns on: an account's
 * sequence advances when a transaction is **included in a ledger**, never when
 * it is merely accepted for submission.
 *
 * Getting that rule wrong is what makes a naive version of this test useless. A
 * fake whose sequence never moves reports a collision even for a correctly
 * serialized facilitator; a fake that advances on `sendTransaction` reports
 * success for a facilitator that releases its lock at submission — which the
 * real network would refuse. Modelling inclusion is what makes the assertion
 * mean what it claims.
 */
const harness = (feeSourceId: string) => {
  const transactionData = new SorobanDataBuilder()
    .setResourceFee(500)
    .build()
    .toXDR("base64");
  let horizonSequence = 42n;
  const submittedSequences: string[] = [];
  const included = new Set<string>();

  const fetchLike = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ history_latest_ledger: 1_000, core_latest_ledger: 1_000 }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ account_id: feeSourceId, sequence: horizonSequence.toString() }),
      { status: 200 },
    );
  });

  const rpc = {
    simulateTransaction: vi.fn(async () => ({
      latestLedger: 1_001,
      transactionData,
      minResourceFee: "500",
      results: [],
    })),
    sendTransaction: vi.fn(async (envelope: string) => {
      const decoded = TransactionBuilder.fromXDR(
        envelope,
        NETWORKS.testnet.networkPassphrase,
      );
      if (!(decoded instanceof Transaction)) throw new Error("expected a Transaction");
      submittedSequences.push(decoded.sequence);
      return {
        hash: decoded.hash().toString("hex"),
        status: "PENDING" as const,
        latestLedger: 1_001,
      };
    }),
    getTransaction: vi.fn(async (hash: string) => {
      if (!included.has(hash)) {
        included.add(hash);
        horizonSequence += 1n;
      }
      return { status: "SUCCESS" as const, hash, ledger: 1_002 };
    }),
  };

  return { rpc, fetchLike, submittedSequences };
};

describe("concurrent settlements do not collide on the fee-source sequence", () => {
  /**
   * The defect this covers: `#prepare` read the fee source from Horizon on every
   * call and `TransactionBuilder` incremented that number locally, with no
   * coordination between calls. Two settlements overlapping on one facilitator
   * both read sequence N and both built N+1. The network takes one and refuses
   * the other with `tx_bad_seq` — and the refused payer has already transmitted
   * `PAYMENT-SIGNATURE` and already turned their reservation into a
   * non-expiring debit that only a human can clear.
   */
  it("assigns each concurrent settlement its own sequence number", async () => {
    const feeSource = deterministicKeypair("x402 concurrency fee source");
    const [first, second] = await twoPayments();
    const { rpc, fetchLike, submittedSequences } = harness(feeSource.publicKey());
    const facilitator = new LocalFacilitator({
      rpc,
      sourceKeypair: feeSource,
      resourceLimits,
      fetchLike,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      settlementTimeoutMs: 1_000,
    });

    // Launched together, on purpose. Both reach the Horizon account read before
    // either submits, which is precisely the window the fix has to close.
    const [a, b] = await Promise.all([
      facilitator.settle(first, requirements),
      facilitator.settle(second, requirements),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(submittedSequences).toHaveLength(2);
    // The assertion that bites: unserialized, both of these are "43".
    expect(new Set(submittedSequences).size).toBe(2);
    expect(submittedSequences).toEqual(["43", "44"]);
  });

  it("hands the queue on after a failed settlement rather than poisoning it", async () => {
    const feeSource = deterministicKeypair("x402 concurrency fee source");
    const [first, second] = await twoPayments();
    const { rpc, fetchLike, submittedSequences } = harness(feeSource.publicKey());
    let calls = 0;
    rpc.sendTransaction = vi.fn(async (envelope: string) => {
      calls += 1;
      if (calls === 1) throw new Error("submission exploded");
      const decoded = TransactionBuilder.fromXDR(
        envelope,
        NETWORKS.testnet.networkPassphrase,
      ) as Transaction;
      submittedSequences.push(decoded.sequence);
      return {
        hash: decoded.hash().toString("hex"),
        status: "PENDING" as const,
        latestLedger: 1_001,
      };
    });
    const facilitator = new LocalFacilitator({
      rpc,
      sourceKeypair: feeSource,
      resourceLimits,
      fetchLike,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      settlementTimeoutMs: 1_000,
    });

    const [failed, succeeded] = await Promise.allSettled([
      facilitator.settle(first, requirements),
      facilitator.settle(second, requirements),
    ]);

    expect(failed.status).toBe("rejected");
    // The one behind it must still run. A queue built on `.then(op)` alone
    // would leave every later settlement stuck on a rejected promise.
    expect(succeeded.status).toBe("fulfilled");
  });
});
