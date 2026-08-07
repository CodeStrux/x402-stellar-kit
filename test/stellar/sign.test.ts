import { StrKey, scValToNative, xdr } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { BindingDrift, WireError } from "../../src/errors.js";
import { StellarSigner } from "../../src/stellar/sign.js";
import {
  decodedTransfer,
  fixedIntent,
  latestLedgerRpc,
  payerKeypair,
} from "./helpers.js";

describe("StellarSigner", () => {
  it("builds a sponsored SAC transfer and preserves an i128 above MAX_SAFE_INTEGER", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent();

    const signed = await signer.sign(intent);
    const decoded = decodedTransfer(signed.transaction);
    const auth = decoded.operation.auth?.[0];
    if (auth === undefined) throw new Error("missing auth entry");
    const credentials = auth.credentials().address();
    const signatures = scValToNative(credentials.signature()) as Array<{
      public_key: Buffer;
      signature: Buffer;
    }>;

    expect(decoded.tx.source).toBe(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    expect(decoded.tx.operations).toHaveLength(1);
    expect(decoded.contract).toBe(intent.asset);
    expect(decoded.method).toBe("transfer");
    expect(decoded.args).toEqual([
      payerKeypair.publicKey(),
      intent.payTo,
      9_007_199_254_740_993n,
    ]);
    expect(credentials.signatureExpirationLedger()).toBe(1_012);
    expect(signatures).toHaveLength(1);
    expect(StrKey.encodeEd25519PublicKey(signatures[0].public_key)).toBe(
      payerKeypair.publicKey(),
    );
    expect(signer.address()).toBe(payerKeypair.publicKey());
    expect(JSON.stringify(signer)).toBe('"[redacted]"');
    expect(NETWORKS.testnet.networkPassphrase).toContain("Test SDF Network");
  });

  it("rejects amounts outside the positive i128 transfer range", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });

    await expect(
      signer.sign(fixedIntent({ amountUnits: 1n << 127n })),
    ).rejects.toBeInstanceOf(WireError);
    await expect(
      signer.sign(fixedIntent({ amountUnits: 0n })),
    ).rejects.toBeInstanceOf(WireError);
  });
});

describe("the authorization window is actually bounded", () => {
  /**
   * The defect this covers: `verifyBinding` called `verifyStellarBinding` with
   * no `currentLedger`, so the only expiration it could reject was zero. An
   * authorization signed for a sixty-second window could be redeemed days
   * later, still nominally covered by the intent hash a human approved.
   *
   * Note what this does NOT do: tamper with a signed transaction. Editing
   * `signatureExpirationLedger` after the fact invalidates the ed25519
   * signature, so the existing signature check catches it and the ledger bound
   * is never reached. The real hazard is a signer that *validly signs* a
   * long-lived authorization — the custodial/KMS seam AGENTS.md tells adopters
   * to supply — which is what a hostile `getLatestLedger` reproduces here.
   */
  const AT_LEDGER = 1_000;

  it("accepts the expiration its own signature was built with", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(AT_LEDGER),
    });
    const intent = fixedIntent();
    const signed = await signer.sign(intent);
    await expect(signer.verifyBinding(signed.transaction, intent)).resolves.toBeUndefined();
  });

  it("refuses a validly signed authorization that outlives the approved window", async () => {
    // Signs for ledger 5,000,000 + window — months out, against a 60s approval.
    const hostile = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(5_000_000),
    });
    const intent = fixedIntent();
    const signed = await hostile.sign(intent);

    // The payer's own signer, which knows what ledger it is really on.
    const honest = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(AT_LEDGER),
    });
    await expect(honest.verifyBinding(signed.transaction, intent)).rejects.toBeInstanceOf(
      BindingDrift,
    );
  });

  it("bounds a transaction it did not sign, rather than skipping the check", async () => {
    const hostile = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(5_000_000),
    });
    const intent = fixedIntent();
    const signed = await hostile.sign(intent);

    // A fresh instance holds no recorded ledger for this transaction, so it has
    // to go and ask. The one thing it must not do is wave the check through.
    const fresh = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(AT_LEDGER),
    });
    await expect(fresh.verifyBinding(signed.transaction, intent)).rejects.toBeInstanceOf(
      BindingDrift,
    );
  });
});
