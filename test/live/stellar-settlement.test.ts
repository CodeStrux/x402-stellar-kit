import { describe, expect, it } from "vitest";

import { NETWORKS } from "../../src/constants.js";
import { LocalFacilitator } from "../../src/facilitator/local.js";
import type { PaymentIntent } from "../../src/intent.js";
import { isTransientNetworkFailure } from "../../src/network-error.js";
import { StellarRpc } from "../../src/stellar/rpc.js";
import { StellarSigner } from "../../src/stellar/sign.js";
import { TESTNET_DEMO_TRANSFER_LIMITS } from "../../src/stellar/resources.js";
import {
  deploySacFor,
  fundWithFriendbot,
  generateKeypair,
  issueDemoAsset,
} from "../../src/stellar/testnet.js";
import type { PaymentPayload, PaymentRequirements } from "../../src/wire.js";

describe("live Stellar testnet settlement", () => {
  it("settles one sponsored PLAY transfer", async (context) => {
    const rpc = new StellarRpc(NETWORKS.testnet.rpcUrl);
    try {
      await rpc.getLatestLedger(context.signal, 10_000);
    } catch (error) {
      if (!isTransientNetworkFailure(error)) {
        console.error(
          `CODE FAILURE: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      const message = `ENVIRONMENTAL SKIP: Stellar testnet is unreachable: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(message);
      context.skip(message);
      return;
    }

    try {
      const issuer = generateKeypair();
      const merchant = generateKeypair();
      const payer = generateKeypair();
      for (const keypair of [issuer, merchant, payer]) {
        await fundWithFriendbot(keypair.publicKey(), { signal: context.signal });
      }
      const issued = await issueDemoAsset({
        code: "PLAY",
        issuer,
        recipient: payer,
        trustlineRecipients: [merchant],
        amount: "10",
        signal: context.signal,
      });
      const asset = await deploySacFor(issued.asset, issuer, {
        rpc,
        signal: context.signal,
      });
      const intent: PaymentIntent = {
        network: NETWORKS.testnet.caip2,
        scheme: "exact",
        asset,
        payTo: merchant.publicKey(),
        amountUnits: 100_000n,
        resourceUrl: "https://live.example.test/premium",
        maxTimeoutSeconds: 60,
      };
      const signer = StellarSigner.fromSecret(payer.secret(), {
        rpc,
        signal: context.signal,
      });
      const signed = await signer.sign(intent);
      signer.verifyBinding(signed.transaction, intent);
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
      const facilitator = new LocalFacilitator({
        rpc,
        sourceKeypair: issuer,
        resourceLimits: TESTNET_DEMO_TRANSFER_LIMITS,
        signal: context.signal,
        settlementTimeoutMs: 90_000,
      });

      await expect(facilitator.verify(payload, requirements)).resolves.toEqual({
        isValid: true,
        payer: payer.publicKey(),
      });
      const settlement = await facilitator.settle(payload, requirements);

      expect(settlement).toMatchObject({
        success: true,
        transaction: expect.stringMatching(/^[0-9a-f]{64}$/),
        network: NETWORKS.testnet.caip2,
        payer: payer.publicKey(),
      });
      console.log(
        `LIVE SUCCESS: https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`,
      );
    } catch (error) {
      if (isTransientNetworkFailure(error)) {
        const message = `ENVIRONMENTAL SKIP: testnet infrastructure failed: ${error instanceof Error ? error.message : String(error)}`;
        console.warn(message);
        context.skip(message);
      }
      console.error(
        `CODE FAILURE: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  });
});
