import { randomBytes } from "node:crypto";

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { BindingDrift } from "../../src/errors.js";
import { verifyStellarBinding } from "../../src/stellar/binding.js";
import { authorizationWindowLedgers } from "../../src/stellar/timing.js";
import { fixedIntent, merchantKeypair, payerKeypair } from "./helpers.js";

const SPONSORED_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const AT_LEDGER = 1_000;

const randomNonce = (): xdr.Int64 =>
  xdr.Int64.fromString(
    BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString("hex")}`)).toString(),
  );

/**
 * Builds a genuine, correctly signed sponsored `transfer` around whatever three
 * ScVal arguments it is handed.
 *
 * This deliberately reimplements `StellarSigner.sign` rather than calling it,
 * because the whole point is to produce an artifact `sign` would never emit and
 * that is otherwise indistinguishable from one it would. Editing the arguments
 * of an already-signed transaction is NOT a substitute: tampering invalidates
 * the ed25519 authorization signature, so the pre-existing signature check
 * catches it and the argument-type gate under test is never reached. The
 * authorization here is signed by `authorizeEntry` over the wrong-typed
 * invocation itself, so every other check in `verifyStellarBinding` — the
 * envelope shape, the time bounds, the sponsored source, the operation/auth XDR
 * equality, the expiration bound, and the signature over the auth preimage —
 * passes on its own terms. The argument types are the only thing wrong with it.
 *
 * The custodial `Signer` seam AGENTS.md tells adopters to supply is exactly
 * where a transaction like this comes from in real life.
 */
const signedTransferWithArguments = async (
  args: readonly [xdr.ScVal, xdr.ScVal, xdr.ScVal],
): Promise<string> => {
  const intent = fixedIntent();
  const hostFunction = new Contract(intent.asset)
    .call("transfer", ...args)
    .body()
    .invokeHostFunctionOp()
    .hostFunction();
  const invocation = hostFunction.invokeContract();
  const unsignedEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(payerKeypair.publicKey()).toScAddress(),
        nonce: randomNonce(),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          xdr.InvokeContractArgs.fromXDR(invocation.toXDR()),
        ),
      subInvocations: [],
    }),
  });
  const entry = (
    Operation.fromXDRObject(
      Operation.invokeHostFunction({ func: hostFunction, auth: [unsignedEntry] }),
    ) as Operation.InvokeHostFunction
  ).auth?.[0];
  if (entry === undefined) throw new Error("could not build the authorization entry");

  const signedEntry = await authorizeEntry(
    entry,
    payerKeypair,
    AT_LEDGER + authorizationWindowLedgers(intent.maxTimeoutSeconds),
    NETWORKS.testnet.networkPassphrase,
  );
  return new TransactionBuilder(new Account(SPONSORED_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORKS.testnet.networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({ func: hostFunction, auth: [signedEntry] }),
    )
    .setTimeout(intent.maxTimeoutSeconds)
    .build()
    .toXDR();
};

const verify = (transaction: string): void => {
  verifyStellarBinding(transaction, fixedIntent(), payerKeypair.publicKey(), {
    currentLedger: AT_LEDGER,
  });
};

const correctArguments = (): [xdr.ScVal, xdr.ScVal, xdr.ScVal] => [
  Address.fromString(payerKeypair.publicKey()).toScVal(),
  Address.fromString(merchantKeypair.publicKey()).toScVal(),
  nativeToScVal(fixedIntent().amountUnits, { type: "i128" }),
];

describe("transfer arguments are bound by ScVal type, not only by value", () => {
  /**
   * The defect this covers: `assertInvocation` compared only the output of
   * `scValToNative`, which flattens scvString/scvSymbol/scvAddress to one
   * string and eight integer widths to one bigint. A wrong-typed transfer
   * therefore matched the approved intent on every field, was signed, and was
   * transmitted — and the payer's reservation became a non-expiring debit for a
   * payment the host was always going to refuse.
   */
  it("accepts a correctly typed transfer", async () => {
    const transaction = await signedTransferWithArguments(correctArguments());
    expect(() => verify(transaction)).not.toThrow();
  });

  it.each([
    [
      "an scvU128 amount",
      2,
      // Same numeric value, same decoded bigint, wrong width. This is the case
      // scValToNative cannot distinguish at all.
      (): xdr.ScVal => nativeToScVal(fixedIntent().amountUnits, { type: "u128" }),
    ],
    [
      "an scvU64 amount",
      2,
      // The approved amount, not a different one. A different value would be
      // caught by the `amount !== intent.amountUnits` comparison below and the
      // case would pass with the fix reverted — proving nothing.
      (): xdr.ScVal => nativeToScVal(fixedIntent().amountUnits, { type: "u64" }),
    ],
    [
      "an scvTimepoint amount",
      2,
      // The bigint-decoding family that is easiest to forget: not an integer
      // width at all, yet scValToNative still hands back a bigint. Again the
      // approved amount, so only the type can reject it.
      (): xdr.ScVal =>
        xdr.ScVal.scvTimepoint(
          xdr.Uint64.fromString(fixedIntent().amountUnits.toString()),
        ),
    ],
    [
      "an scvString payer",
      0,
      // Decodes to the identical G… string as the real address.
      (): xdr.ScVal => xdr.ScVal.scvString(payerKeypair.publicKey()),
    ],
    [
      "an scvString recipient",
      1,
      // Not scvSymbol: a Soroban symbol caps at 32 bytes and a G… address is
      // 56, so a symbol could never carry the matching value and would be
      // caught by the value comparison below instead of the type gate — the
      // test would pass without the fix. scvString holds all 56 characters and
      // decodes to a string indistinguishable from the real recipient, so the
      // type is genuinely the only thing that can reject it.
      (): xdr.ScVal => xdr.ScVal.scvString(merchantKeypair.publicKey()),
    ],
  ] as const)("refuses %s", async (_name, index, build) => {
    const args = correctArguments();
    args[index] = build();
    const transaction = await signedTransferWithArguments(args);
    expect(() => verify(transaction)).toThrow(BindingDrift);
  });

  it("names the argument that drifted rather than reporting a generic failure", async () => {
    const args = correctArguments();
    args[2] = nativeToScVal(fixedIntent().amountUnits, { type: "u128" });
    const transaction = await signedTransferWithArguments(args);
    expect(() => verify(transaction)).toThrow(/amount ScVal type/);
  });
});
