import { describe, expect, it, vi } from "vitest";

import { HEADERS } from "../src/constants.js";
import { UpstreamFailed } from "../src/errors.js";
import { Payer } from "../src/payer.js";
import type { PolicyConfig } from "../src/policy/types.js";
import { MemoryWindowStore } from "../src/policy/window.js";
import { MockSigner } from "../src/signer.js";
import {
  encodePaymentRequired,
  encodeSettlementResponse,
} from "../src/wire.js";

const payerAddress = "payer-a";
const network = "stellar:testnet";
const resourceUrl = "https://resource.example.test/data";
const now = 10_000;
const amountUnits = 100n;

const policy: PolicyConfig = {
  allowedNetworks: [network],
  originAllowlist: ["https://resource.example.test"],
  payToAllowlist: ["payee-a"],
  assetAllowlist: ["asset-a"],
  maxPaymentUnits: 1_000n,
  windowCapUnits: 150n,
  windowSeconds: 3_600,
  maxTimeoutSeconds: 60,
  autoApproveMaxUnits: 100n,
};

const challengeResponse = (): Response =>
  new Response("payment required", {
    status: 402,
    headers: {
      [HEADERS.paymentRequired]: encodePaymentRequired({
        x402Version: 2,
        resource: { url: resourceUrl },
        accepts: [
          {
            scheme: "exact",
            network,
            amount: amountUnits.toString(),
            asset: "asset-a",
            payTo: "payee-a",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    },
  });

const settlementResponse = (
  overrides: Partial<{
    success: boolean;
    network: string;
    payer: string;
  }> = {},
): Response =>
  new Response("paid", {
    status: 200,
    headers: {
      [HEADERS.paymentResponse]: encodeSettlementResponse({
        success: true,
        transaction: "a".repeat(64),
        network,
        payer: payerAddress,
        ...overrides,
      }),
    },
  });

type FailureCase = Readonly<{
  name: string;
  failPaidRequest: () => Response | Promise<Response>;
  upstreamStatus?: number;
}>;

const failureCases: readonly FailureCase[] = [
  {
    name: "fetch rejects",
    failPaidRequest: async () => {
      throw new TypeError("connection reset");
    },
  },
  {
    name: "upstream returns 500",
    failPaidRequest: () => new Response("failed", { status: 500 }),
    upstreamStatus: 500,
  },
  {
    name: "PAYMENT-RESPONSE is missing",
    failPaidRequest: () => new Response("paid", { status: 200 }),
  },
  {
    name: "settlement reports success false",
    failPaidRequest: () => settlementResponse({ success: false }),
  },
  {
    name: "settlement reports the wrong network",
    failPaidRequest: () => settlementResponse({ network: "stellar:pubnet" }),
  },
  {
    name: "settlement reports the wrong payer",
    failPaidRequest: () => settlementResponse({ payer: "payer-b" }),
  },
];

describe("indeterminate payer outcomes", () => {
  it.each(failureCases)(
    "keeps the budget debited when $name",
    async ({ failPaidRequest, upstreamStatus }) => {
      const window = new MemoryWindowStore(policy.windowSeconds);
      const fetchLike = vi.fn(async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        if (!new Headers(init?.headers).has(HEADERS.paymentSignature)) {
          return challengeResponse();
        }
        return failPaidRequest();
      }) as unknown as typeof globalThis.fetch;
      const payer = new Payer({
        signer: new MockSigner(payerAddress),
        policy,
        window,
        fetchLike,
        now: () => now,
      });

      let thrown: unknown;
      try {
        await payer.pay(resourceUrl);
      } catch (error) {
        thrown = error;
      }

      const indeterminate = window.listIndeterminate(now);
      expect(indeterminate).toHaveLength(1);
      expect(indeterminate[0]).toMatchObject({
        units: amountUnits,
        reservedAt: now,
        intentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(window.spentInWindow(now)).toBe(amountUnits);
      expect(thrown).toMatchObject({
        transmitted: true,
        intentHash: indeterminate[0]?.intentHash,
      });
      if (upstreamStatus !== undefined) {
        expect(thrown).toBeInstanceOf(UpstreamFailed);
        expect(thrown).toMatchObject({ status: upstreamStatus });
      }

      await expect(payer.pay(resourceUrl)).rejects.toMatchObject({
        name: "PolicyDenied",
        code: "POL-WINDOW",
      });
      expect(fetchLike).toHaveBeenCalledTimes(3);
      expect(window.spentInWindow(now)).toBe(amountUnits);
      expect(window.listIndeterminate(now)).toEqual(indeterminate);
    },
  );

  it("keeps an in-flight transmitted payment debited past the window", async () => {
    let currentNow = now;
    let rejectPaidRequest: ((reason: unknown) => void) | undefined;
    let signalPaidRequest: (() => void) | undefined;
    const paidRequestStarted = new Promise<void>((resolve) => {
      signalPaidRequest = resolve;
    });
    const pendingPaidResponse = new Promise<Response>((_resolve, reject) => {
      rejectPaidRequest = reject;
    });
    let paidRequests = 0;
    const fetchLike = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!new Headers(init?.headers).has(HEADERS.paymentSignature)) {
        return challengeResponse();
      }

      paidRequests += 1;
      if (paidRequests === 1) {
        signalPaidRequest?.();
        return pendingPaidResponse;
      }
      return new Response("unexpected second payment", { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const window = new MemoryWindowStore(policy.windowSeconds);
    const payer = new Payer({
      signer: new MockSigner(payerAddress),
      policy,
      window,
      fetchLike,
      now: () => currentNow,
    });

    const firstFailure = payer.pay(resourceUrl).catch((error: unknown) => error);
    await paidRequestStarted;
    currentNow += policy.windowSeconds * 1_000;

    await expect(payer.pay(resourceUrl)).rejects.toMatchObject({
      name: "PolicyDenied",
      code: "POL-WINDOW",
    });
    expect(paidRequests).toBe(1);
    expect(window.spentInWindow(currentNow)).toBe(amountUnits);

    rejectPaidRequest?.(new TypeError("connection reset"));
    await expect(firstFailure).resolves.toMatchObject({
      transmitted: true,
      intentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(window.listIndeterminate(currentNow)).toHaveLength(1);
  });
});
