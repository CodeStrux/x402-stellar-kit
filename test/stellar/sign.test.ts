import { StrKey, scValToNative } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { WireError } from "../../src/errors.js";
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
