import {
  Address,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { BindingDrift } from "../../src/errors.js";
import { verifyStellarBinding } from "../../src/stellar/binding.js";
import { StellarSigner } from "../../src/stellar/sign.js";
import {
  deterministicKeypair,
  fixedIntent,
  latestLedgerRpc,
  payerKeypair,
} from "./helpers.js";

const mutateInvocation = (
  transaction: string,
  mutate: (invocation: xdr.InvokeContractArgs) => void,
): string => {
  const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  const hostFunction = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp();
  mutate(hostFunction.hostFunction().invokeContract());
  return envelope.toXDR("base64");
};

const expectField = async (
  action: () => void | Promise<void>,
  field: string,
): Promise<void> => {
  try {
    await action();
    throw new Error(`expected ${field} drift`);
  } catch (error) {
    expect(error).toBeInstanceOf(BindingDrift);
    expect((error as Error).message.toLowerCase()).toContain(field);
  }
};

describe("Stellar binding verification", () => {
  it("names every transfer field that differs from the approved intent", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent();
    const { transaction } = await signer.sign(intent);
    await expectField(
      () =>
        signer.verifyBinding(
          mutateInvocation(transaction, (call) =>
            call.contractAddress(Address.contract(Buffer.alloc(32, 3)).toScAddress()),
          ),
          intent,
        ),
      "asset",
    );
    await expectField(
      () =>
        signer.verifyBinding(
          mutateInvocation(transaction, (call) => call.functionName("approve")),
          intent,
        ),
      "method",
    );
    await expectField(
      () =>
        signer.verifyBinding(
          mutateInvocation(transaction, (call) => {
            const args = call.args();
            args[0] = Address.fromString(
              deterministicKeypair("other from").publicKey(),
            ).toScVal();
            call.args(args);
          }),
          intent,
        ),
      "from",
    );
    await expectField(
      () =>
        signer.verifyBinding(
          mutateInvocation(transaction, (call) => {
            const args = call.args();
            args[1] = Address.fromString(
              deterministicKeypair("other recipient").publicKey(),
            ).toScVal();
            call.args(args);
          }),
          intent,
        ),
      "to",
    );
    await expectField(
      () =>
        signer.verifyBinding(
          mutateInvocation(transaction, (call) => {
            const args = call.args();
            args[2] = nativeToScVal(intent.amountUnits + 1n, { type: "i128" });
            call.args(args);
          }),
          intent,
        ),
      "amount",
    );
  });

  it("detects a transaction authorized for a different network", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const approved = fixedIntent();
    const signedForPubnet = await signer.sign({
      ...approved,
      network: NETWORKS.pubnet.caip2,
    });

    await expectField(
      () => signer.verifyBinding(signedForPubnet.transaction, approved),
      "network",
    );
  });

  it("rejects a hostile auth entry signed by a different key", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent();
    const { transaction } = await signer.sign(intent);
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    const hostFunction = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp();
    const original = hostFunction.auth()[0];
    const hostile = deterministicKeypair("hostile auth signer");
    const hostileEntry = await authorizeEntry(
      original,
      hostile,
      original.credentials().address().signatureExpirationLedger(),
      NETWORKS.testnet.networkPassphrase,
    );
    hostFunction.auth([hostileEntry]);

    await expectField(
      () => signer.verifyBinding(envelope.toXDR("base64"), intent),
      "signer",
    );
  });

  it("accepts the transaction it just produced", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent();
    const { transaction } = await signer.sign(intent);

    expect(() => signer.verifyBinding(transaction, intent)).not.toThrow();
    expect(() =>
      verifyStellarBinding(transaction, intent, payerKeypair.publicKey(), {
        currentLedger: 1_000,
      }),
    ).not.toThrow();
  });

  it("rejects an otherwise valid authorization beyond the intent's ledger window", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent();
    const { transaction } = await signer.sign(intent);
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    const operation = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp();
    operation.auth([
      await authorizeEntry(
        operation.auth()[0],
        payerKeypair,
        1_013,
        NETWORKS.testnet.networkPassphrase,
      ),
    ]);

    await expectField(
      () =>
        verifyStellarBinding(
          envelope.toXDR("base64"),
          intent,
          payerKeypair.publicKey(),
          { currentLedger: 1_000 },
        ),
      "authorization expiration",
    );
  });

  it("rejects transaction time bounds beyond the approved timeout", async () => {
    const signer = StellarSigner.fromSecret(payerKeypair.secret(), {
      rpc: latestLedgerRpc(),
    });
    const intent = fixedIntent();
    const { transaction } = await signer.sign(intent);
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    envelope
      .v1()
      .tx()
      .cond()
      .timeBounds()
      .maxTime(xdr.Uint64.fromString(String(Math.floor(Date.now() / 1_000) + 3_600)));

    await expectField(
      () => signer.verifyBinding(envelope.toXDR("base64"), intent),
      "timeout",
    );
  });
});
