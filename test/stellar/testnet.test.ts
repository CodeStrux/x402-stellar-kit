import {
  Asset,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-base";
import { describe, expect, it, vi } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import {
  deploySacFor,
  fundWithFriendbot,
  generateKeypair,
  issueDemoAsset,
} from "../../src/stellar/testnet.js";
import { deterministicKeypair } from "./helpers.js";

describe("testnet bootstrap helpers", () => {
  it("generates an in-memory keypair and funds only its public address", async () => {
    const keypair = generateKeypair();
    const fetchLike = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ hash: "a".repeat(64) }), { status: 200 }),
    );

    await fundWithFriendbot(keypair.publicKey(), { fetchLike });

    expect(keypair.canSign()).toBe(true);
    expect(String(fetchLike.mock.calls[0][0])).toBe(
      `${NETWORKS.testnet.friendbotUrl}/?addr=${keypair.publicKey()}`,
    );
    expect(String(fetchLike.mock.calls[0][0])).not.toContain(keypair.secret());
  });

  it("creates PLAY trustlines and issues PLAY with classic transactions", async () => {
    const issuer = deterministicKeypair("PLAY issuer");
    const payer = deterministicKeypair("PLAY payer");
    const merchant = deterministicKeypair("PLAY merchant");
    const sequences = new Map([
      [issuer.publicKey(), "10"],
      [payer.publicKey(), "20"],
      [merchant.publicKey(), "30"],
    ]);
    const submitted: Transaction[] = [];
    const fetchLike = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (init?.method === "POST") {
        const transaction = new URLSearchParams(String(init.body)).get("tx");
        if (transaction === null) throw new Error("missing tx");
        const decoded = TransactionBuilder.fromXDR(
          transaction,
          NETWORKS.testnet.networkPassphrase,
        );
        if (!(decoded instanceof Transaction)) throw new Error("expected tx");
        submitted.push(decoded);
        return new Response(JSON.stringify({ hash: "b".repeat(64) }), {
          status: 200,
        });
      }
      const account = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify({ account_id: account, sequence: sequences.get(account) }),
        { status: 200 },
      );
    });

    const issued = await issueDemoAsset({
      code: "PLAY",
      issuer,
      recipient: payer,
      trustlineRecipients: [merchant],
      amount: "25",
      fetchLike,
    });

    expect(issued.issuer.publicKey()).toBe(issuer.publicKey());
    expect(issued.asset).toBeInstanceOf(Asset);
    expect(issued.asset.getCode()).toBe("PLAY");
    expect(issued.asset.getIssuer()).toBe(issuer.publicKey());
    expect(submitted).toHaveLength(3);
    expect(submitted.slice(0, 2).map((transaction) => transaction.operations[0])).toEqual([
      expect.objectContaining({
        type: "changeTrust",
        line: expect.objectContaining({ code: "PLAY", issuer: issuer.publicKey() }),
      }),
      expect.objectContaining({
        type: "changeTrust",
        line: expect.objectContaining({ code: "PLAY", issuer: issuer.publicKey() }),
      }),
    ]);
    expect(submitted[2].operations[0]).toMatchObject({
      type: "payment",
      destination: payer.publicKey(),
      amount: "25.0000000",
      asset: expect.objectContaining({ code: "PLAY", issuer: issuer.publicKey() }),
    });
  });

  it("deploys the PLAY SAC and returns its deterministic contract id", async () => {
    const issuer = deterministicKeypair("SAC issuer");
    const asset = new Asset("PLAY", issuer.publicKey());
    const transactionData = new SorobanDataBuilder()
      .setResourceFee(500)
      .build()
      .toXDR("base64");
    let submitted = "";
    let submittedHash = "";
    const rpc = {
      simulateTransaction: async () => ({
        latestLedger: 100,
        transactionData,
        minResourceFee: "500",
        results: [],
      }),
      sendTransaction: async (transaction: string) => {
        submitted = transaction;
        const decoded = TransactionBuilder.fromXDR(
          transaction,
          NETWORKS.testnet.networkPassphrase,
        );
        if (!(decoded instanceof Transaction)) throw new Error("expected tx");
        submittedHash = decoded.hash().toString("hex");
        return {
          hash: submittedHash,
          status: "PENDING" as const,
          latestLedger: 100,
        };
      },
      getTransaction: async () => ({
        status: "SUCCESS" as const,
        hash: submittedHash,
        ledger: 101,
      }),
    };
    const fetchLike = async () =>
      new Response(
        JSON.stringify({ account_id: issuer.publicKey(), sequence: "10" }),
        { status: 200 },
      );

    await expect(
      deploySacFor(asset, issuer, {
        rpc,
        fetchLike,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe(asset.contractId(NETWORKS.testnet.networkPassphrase));

    const transaction = TransactionBuilder.fromXDR(
      submitted,
      NETWORKS.testnet.networkPassphrase,
    );
    expect(transaction).toBeInstanceOf(Transaction);
    if (!(transaction instanceof Transaction)) throw new Error("expected tx");
    expect(transaction.source).toBe(issuer.publicKey());
    expect(transaction.signatures).toHaveLength(1);
    const operation = transaction.toEnvelope().v1().tx().operations()[0];
    expect(operation.body().switch().value).toBe(
      xdr.OperationType.invokeHostFunction().value,
    );
    expect(
      operation
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .switch().value,
    ).toBe(xdr.HostFunctionType.hostFunctionTypeCreateContract().value);
  });
});
