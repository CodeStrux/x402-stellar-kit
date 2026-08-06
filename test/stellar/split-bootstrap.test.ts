import { Transaction } from "@stellar/stellar-base";
import { describe, expect, it, vi } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import {
  establishTrustline,
  generateKeypair,
  issueAssetTo,
} from "../../src/stellar/testnet.js";

/**
 * Horizon stub: answers the account load, then captures the submitted envelope.
 * Every test here asserts on what was signed and by whom, because the whole point
 * of the split is that each function may only ever wield one key.
 */
const horizonStub = () => {
  const submitted: Transaction[] = [];
  const fetchLike = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/accounts/")) {
      const address = url.split("/accounts/")[1]!.split("?")[0]!;
      return new Response(
        JSON.stringify({ id: address, account_id: address, sequence: "1" }),
        { status: 200 },
      );
    }
    const body = String(init?.body ?? "");
    const xdrValue = decodeURIComponent(body.replace(/^tx=/, ""));
    submitted.push(
      new Transaction(xdrValue, NETWORKS.testnet.networkPassphrase),
    );
    return new Response(JSON.stringify({ hash: "b".repeat(64) }), { status: 200 });
  });
  return { fetchLike, submitted };
};

describe("establishTrustline — the account's key only", () => {
  it("signs with the account and never needs the issuer's key", async () => {
    const account = generateKeypair();
    const issuer = generateKeypair();
    const { fetchLike, submitted } = horizonStub();

    const hash = await establishTrustline({
      account,
      asset: { code: "PLAY", issuer: issuer.publicKey() },
      fetchLike,
    });

    expect(hash).toBe("b".repeat(64));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.source).toBe(account.publicKey());
    expect(submitted[0]!.operations[0]!.type).toBe("changeTrust");
    // The issuer was referenced by address alone.
    expect(JSON.stringify(fetchLike.mock.calls)).not.toContain(issuer.secret());
  });

  it("rejects a Keypair passed where a public address belongs", async () => {
    const account = generateKeypair();
    const issuer = generateKeypair();
    await expect(
      establishTrustline({
        account,
        // deliberately wrong: a signing key where a G… string is required
        asset: { code: "PLAY", issuer: issuer as unknown as string },
        fetchLike: horizonStub().fetchLike,
      }),
    ).rejects.toThrow(/must be a G… public key string, not a Keypair/u);
  });

  it("rejects an invalid issuer address, a bad asset code, and a self-trustline", async () => {
    const account = generateKeypair();
    const { fetchLike } = horizonStub();

    await expect(
      establishTrustline({ account, asset: { code: "PLAY", issuer: "not-an-address" }, fetchLike }),
    ).rejects.toThrow(/valid Stellar ed25519 public key/u);

    await expect(
      establishTrustline({
        account,
        asset: { code: "not a code!", issuer: generateKeypair().publicKey() },
        fetchLike,
      }),
    ).rejects.toThrow(/1 to 12 alphanumeric/u);

    await expect(
      establishTrustline({
        account,
        asset: { code: "PLAY", issuer: account.publicKey() },
        fetchLike,
      }),
    ).rejects.toThrow(/cannot hold a trustline to its own asset/u);
  });
});

describe("issueAssetTo — the issuer's key only", () => {
  it("signs with the issuer and takes the destination as an address", async () => {
    const issuer = generateKeypair();
    const destination = generateKeypair();
    const { fetchLike, submitted } = horizonStub();

    const hash = await issueAssetTo({
      issuer,
      destination: destination.publicKey(),
      asset: { code: "PLAY" },
      amount: "100",
      fetchLike,
    });

    expect(hash).toBe("b".repeat(64));
    expect(submitted[0]!.source).toBe(issuer.publicKey());
    expect(submitted[0]!.operations[0]!.type).toBe("payment");
    expect(JSON.stringify(fetchLike.mock.calls)).not.toContain(destination.secret());
  });

  it("rejects an asset issuer that differs from the signing issuer", async () => {
    const issuer = generateKeypair();
    const other = generateKeypair();
    await expect(
      issueAssetTo({
        issuer,
        destination: generateKeypair().publicKey(),
        asset: { code: "PLAY", issuer: other.publicKey() },
        amount: "100",
        fetchLike: horizonStub().fetchLike,
      }),
    ).rejects.toThrow(/does not match the signing issuer/u);
  });

  it("rejects a Keypair destination, self-issuance, and bad amounts", async () => {
    const issuer = generateKeypair();
    const { fetchLike } = horizonStub();
    const base = { issuer, asset: { code: "PLAY" as const }, fetchLike };

    await expect(
      issueAssetTo({
        ...base,
        destination: generateKeypair() as unknown as string,
        amount: "1",
      }),
    ).rejects.toThrow(/not a Keypair/u);

    await expect(
      issueAssetTo({ ...base, destination: issuer.publicKey(), amount: "1" }),
    ).rejects.toThrow(/cannot issue to itself/u);

    for (const amount of ["0", "-1", "1.12345678", "abc", ""]) {
      await expect(
        issueAssetTo({ ...base, destination: generateKeypair().publicKey(), amount }),
      ).rejects.toThrow(/positive decimal with at most 7 places/u);
    }
  });
});
