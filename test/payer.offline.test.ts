import { describe, expect, it } from "vitest";

import { AutoApprover, type Approver } from "../src/approver/index.js";
import { HEADERS } from "../src/constants.js";
import {
  ApprovalDenied,
  BindingDrift,
  PolicyDenied,
  UpstreamFailed,
  WireError,
} from "../src/errors.js";
import { MockFacilitator } from "../src/facilitator/mock.js";
import type { PaymentIntent } from "../src/intent.js";
import { Payer } from "../src/payer.js";
import type { PolicyConfig } from "../src/policy/types.js";
import { MemoryWindowStore, type WindowStore } from "../src/policy/window.js";
import { createResourceServer } from "../src/server/resource.js";
import { MockSigner, type Signer } from "../src/signer.js";
import {
  encodePaymentRequired,
  encodeSettlementResponse,
} from "../src/wire.js";

const payerAddress = "payer-a";
const payTo = "payee-a";
const asset = "asset-a";
const network = "stellar:testnet";
const resourceUrl = "https://resource.example.test/data";
const now = 10_000;

const policy = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
  allowedNetworks: [network],
  originAllowlist: ["https://resource.example.test"],
  payToAllowlist: [payTo],
  assetAllowlist: [asset],
  maxPaymentUnits: 1_000_000n,
  windowCapUnits: 2_000_000n,
  windowSeconds: 3_600,
  maxTimeoutSeconds: 60,
  autoApproveMaxUnits: 100_000n,
  ...overrides,
});

type RecordedCall = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

const localFetch = (
  server: ReturnType<typeof createResourceServer>,
  calls: RecordedCall[],
): typeof globalThis.fetch =>
  (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    calls.push({ url, init });
    const headers = new Headers(init?.headers);
    const result = await server.handle({
      method: init?.method ?? "GET",
      url,
      headers,
    });

    if (result.kind === "challenge") {
      return new Response("payment required", {
        status: result.status,
        headers: result.headers,
      });
    }
    if (result.kind === "verified") {
      // Serve then settle, as every adapter now does.
      const body = JSON.stringify({ message: "paid content" });
      const settled = await result.settle();
      if (settled.kind === "rejected") {
        return new Response(settled.reason, { status: settled.status });
      }
      return new Response(body, { status: settled.status, headers: settled.headers });
    }
    return new Response(result.reason, { status: result.status });
  }) as typeof globalThis.fetch;

const setup = (signer: Signer = new MockSigner(payerAddress)) => {
  const facilitator = new MockFacilitator(payerAddress);
  facilitator.credit(payerAddress, 500_000n);
  const server = createResourceServer({
    price: "0.01",
    payTo,
    asset,
    network,
    facilitator,
    resource: { url: resourceUrl, description: "Paid data" },
  });
  const calls: RecordedCall[] = [];
  const window = new MemoryWindowStore(3_600);
  return { facilitator, server, calls, window, signer };
};

describe("offline payer loop", () => {
  it("probes, binds, reserves, signs, settles, and commits", async () => {
    const context = setup();
    const payer = new Payer({
      signer: context.signer,
      policy: policy(),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    const result = await payer.pay(resourceUrl);

    expect(result).toMatchObject({
      status: 200,
      body: JSON.stringify({ message: "paid content" }),
      amountUnits: 100_000n,
      intentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      settlement: {
        success: true,
        network,
        payer: payerAddress,
        transaction: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(context.calls).toHaveLength(2);
    expect(new Headers(context.calls[0].init?.headers).has(HEADERS.paymentSignature)).toBe(
      false,
    );
    expect(new Headers(context.calls[1].init?.headers).has(HEADERS.paymentSignature)).toBe(
      true,
    );
    expect(await context.window.spentInWindow(now)).toBe(100_000n);
    expect(context.facilitator.balance(payerAddress)).toBe(400_000n);
    expect(context.facilitator.balance(payTo)).toBe(100_000n);
  });

  it("does not issue the second request when verifyBinding detects drift", async () => {
    const honest = new MockSigner(payerAddress);
    const signer: Signer = {
      address: () => honest.address(),
      sign: async (intent: PaymentIntent) =>
        honest.sign({ ...intent, amountUnits: intent.amountUnits + 1n }),
      verifyBinding: (transaction: string, intent: PaymentIntent) =>
        honest.verifyBinding(transaction, intent),
    };
    const context = setup(signer);
    const payer = new Payer({
      signer,
      policy: policy(),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toBeInstanceOf(BindingDrift);
    expect(context.calls).toHaveLength(1);
    expect(await context.window.spentInWindow(now)).toBe(0n);
    expect(context.facilitator.balance(payerAddress)).toBe(500_000n);
  });

  it("awaits an asynchronous binding failure before transmitting", async () => {
    const honest = new MockSigner(payerAddress);
    const signer: Signer = {
      address: () => honest.address(),
      sign: (intent) => honest.sign(intent),
      verifyBinding: async () => {
        await Promise.resolve();
        throw new BindingDrift();
      },
    };
    const context = setup(signer);
    const payer = new Payer({
      signer,
      policy: policy(),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toBeInstanceOf(BindingDrift);
    expect(context.calls).toHaveLength(1);
    expect(await context.window.spentInWindow(now)).toBe(0n);
  });

  it("never calls an approver or signer after policy denial", async () => {
    let approvals = 0;
    let signatures = 0;
    const context = setup({
      address: () => payerAddress,
      sign: async () => {
        signatures += 1;
        return { transaction: "unreachable" };
      },
      verifyBinding: () => undefined,
    });
    const approver: Approver = {
      approve: async () => {
        approvals += 1;
        return { approved: true, evidence: {} };
      },
    };
    const payer = new Payer({
      signer: context.signer,
      approver,
      policy: policy({ maxPaymentUnits: 99_999n }),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toMatchObject({
      name: "PolicyDenied",
      code: "POL-MAX",
    });
    expect(approvals).toBe(0);
    expect(signatures).toBe(0);
    expect(context.calls).toHaveLength(1);
  });

  it("uses the default deny-all approver above the automatic limit", async () => {
    const context = setup();
    const payer = new Payer({
      signer: context.signer,
      policy: policy({ autoApproveMaxUnits: 0n }),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toBeInstanceOf(ApprovalDenied);
    expect(context.calls).toHaveLength(1);
    expect(await context.window.spentInWindow(now)).toBe(0n);
  });

  it("rechecks the window after asynchronous approval before reserving", async () => {
    const context = setup();
    const approver: Approver = {
      approve: async () => {
        await context.window.reserve(
          "concurrent",
          150_000n,
          now,
          "concurrent-intent",
          200_000n,
        );
        return { approved: true, evidence: {} };
      },
    };
    const payer = new Payer({
      signer: context.signer,
      approver,
      policy: policy({
        autoApproveMaxUnits: 0n,
        windowCapUnits: 200_000n,
      }),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toMatchObject({
      code: "POL-WINDOW",
    });
    expect(context.calls).toHaveLength(1);
  });

  it("rejects a challenge whose resource URL differs from the caller URL", async () => {
    let calls = 0;
    const fetchLike = (async (): Promise<Response> => {
      calls += 1;
      return new Response("payment required", {
        status: 402,
        headers: {
          [HEADERS.paymentRequired]: encodePaymentRequired({
            x402Version: 2,
            resource: { url: "https://other.example.test/data" },
            accepts: [
              {
                scheme: "exact",
                network,
                amount: "100000",
                asset,
                payTo,
                maxTimeoutSeconds: 60,
              },
            ],
          }),
        },
      });
    }) as typeof globalThis.fetch;
    const payer = new Payer({
      signer: new MockSigner(payerAddress),
      policy: policy(),
      fetchLike,
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toBeInstanceOf(WireError);
    expect(calls).toBe(1);
  });

  it("calls the configured approver only for approval_required", async () => {
    const context = setup();
    const payer = new Payer({
      signer: context.signer,
      approver: new AutoApprover(),
      policy: policy({ autoApproveMaxUnits: 0n }),
      window: context.window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).resolves.toMatchObject({ status: 200 });
  });

  it("keeps reservation ids unique across Payer instances sharing a store", async () => {
    const honest = new MockSigner(payerAddress);
    let signatures = 0;
    const signer: Signer = {
      address: () => honest.address(),
      sign: async (intent) => {
        signatures += 1;
        return honest.sign(intent);
      },
      verifyBinding: (transaction, intent) =>
        honest.verifyBinding(transaction, intent),
    };
    const context = setup(signer);
    const fetchLike = localFetch(context.server, context.calls);
    const options = {
      signer,
      policy: policy(),
      window: context.window,
      fetchLike,
      now: () => now,
    } as const;

    await new Payer(options).pay(resourceUrl);
    await expect(new Payer(options).pay(resourceUrl)).rejects.toBeInstanceOf(
      UpstreamFailed,
    );
    expect(signatures).toBe(2);
  });

  it("executes reserve, sign, binding check, transmit, and commit in order", async () => {
    const events: string[] = [];
    const realSigner = new MockSigner(payerAddress);
    const signer: Signer = {
      address: () => realSigner.address(),
      sign: async (intent) => {
        events.push("sign");
        return realSigner.sign(intent);
      },
      verifyBinding: (transaction, intent) => {
        events.push("binding");
        realSigner.verifyBinding(transaction, intent);
      },
    };
    const record = async (event: string): Promise<void> => {
      events.push(event);
    };
    const window: WindowStore = {
      spentInWindow: async () => 0n,
      reserve: async () => {
        events.push("reserve");
        return { accepted: true };
      },
      commit: () => record("commit"),
      markIndeterminate: () => record("indeterminate"),
      listIndeterminate: async () => [],
      release: () => record("release"),
    };
    const fetchLike = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signed = new Headers(init?.headers).has(HEADERS.paymentSignature);
      if (!signed) {
        events.push("probe");
        return new Response("payment required", {
          status: 402,
          headers: {
            [HEADERS.paymentRequired]: encodePaymentRequired({
              x402Version: 2,
              resource: { url: resourceUrl },
              accepts: [
                {
                  scheme: "exact",
                  network,
                  amount: "100000",
                  asset,
                  payTo,
                  maxTimeoutSeconds: 60,
                },
              ],
            }),
          },
        });
      }

      events.push("transmit");
      return new Response("paid", {
        status: 200,
        headers: {
          [HEADERS.paymentResponse]: encodeSettlementResponse({
            success: true,
            transaction: "a".repeat(64),
            network,
            payer: payerAddress,
          }),
        },
      });
    }) as typeof globalThis.fetch;

    await new Payer({ signer, policy: policy(), window, fetchLike }).pay(
      resourceUrl,
    );

    expect(events).toEqual([
      "probe",
      "reserve",
      "sign",
      "binding",
      "indeterminate",
      "transmit",
      "commit",
    ]);
  });
});

/**
 * The defect these cover, in two halves.
 *
 * `WindowStore` was synchronous — `spentInWindow(now): bigint`,
 * `reserve(...): void`. AGENTS.md tells production adopters to supply "one
 * durable, shared, atomic store", and not one of Postgres, Redis or anything
 * else with a network in front of it can be reached from that signature. The
 * kit mandated something its own interface forbade.
 *
 * Async alone was not enough. `pay()` read the window, consulted an approver,
 * and only then reserved — check-then-act. In-process against a `Map` the gap
 * is unobservable; against a shared store two replicas both pass the check and
 * both reserve, and the real ceiling becomes cap x replicas.
 *
 * Note what makes these bite. Converting `MemoryWindowStore` and every call
 * site together leaves the whole suite passing either way, because nothing in
 * the repo can tell the difference. Both stores below are ones no in-repo
 * implementation can imitate: one resolves on a later macrotask, the other
 * disagrees with itself between `spentInWindow` and `reserve`.
 */
describe("the window store is genuinely asynchronous", () => {
  /** Resolves a turn late, so a missing `await` yields a Promise, not a value. */
  class DeferredWindowStore implements WindowStore {
    readonly #inner: MemoryWindowStore;

    constructor(windowSeconds: number) {
      this.#inner = new MemoryWindowStore(windowSeconds);
    }

    async #later<T>(work: () => Promise<T>): Promise<T> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return work();
    }

    spentInWindow(at: number): Promise<bigint> {
      return this.#later(() => this.#inner.spentInWindow(at));
    }

    reserve(
      id: string,
      units: bigint,
      at: number,
      intentHash: string,
      capUnits: bigint,
    ) {
      return this.#later(() =>
        this.#inner.reserve(id, units, at, intentHash, capUnits),
      );
    }

    commit(id: string): Promise<void> {
      return this.#later(() => this.#inner.commit(id));
    }

    markIndeterminate(id: string): Promise<void> {
      return this.#later(() => this.#inner.markIndeterminate(id));
    }

    listIndeterminate(at: number) {
      return this.#later(() => this.#inner.listIndeterminate(at));
    }

    release(id: string): Promise<void> {
      return this.#later(() => this.#inner.release(id));
    }
  }

  it("pays end to end against a store that resolves later", async () => {
    const context = setup();
    const window = new DeferredWindowStore(3_600);
    const payer = new Payer({
      signer: context.signer,
      policy: policy(),
      window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    const result = await payer.pay(resourceUrl);

    expect(result.settlement.success).toBe(true);
    expect(await window.spentInWindow(now)).toBe(100_000n);
  });
});

describe("the store, not the caller, decides whether the cap allows a payment", () => {
  class CountingSigner implements Signer {
    readonly #delegate = new MockSigner(payerAddress);
    signCalls = 0;

    address(): string {
      return this.#delegate.address();
    }

    async sign(intent: Parameters<Signer["sign"]>[0]) {
      this.signCalls += 1;
      return this.#delegate.sign(intent);
    }

    verifyBinding(transaction: string, intent: Parameters<Signer["sign"]>[0]): void {
      this.#delegate.verifyBinding(transaction, intent);
    }
  }

  it("refuses when reserve rejects, even though the advisory check saw room", async () => {
    // The shape of a real race: the pre-approval read saw an empty budget, and
    // by the time the reservation lands another replica has spent it. Only the
    // store can see that, so only the store can refuse it.
    const signer = new CountingSigner();
    const context = setup(signer);
    const window: WindowStore = {
      spentInWindow: async () => 0n,
      reserve: async () => ({ accepted: false, spentUnits: 490_000n }),
      commit: async () => undefined,
      markIndeterminate: async () => undefined,
      listIndeterminate: async () => [],
      release: async () => undefined,
    };
    const payer = new Payer({
      signer,
      policy: policy(),
      window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    await expect(payer.pay(resourceUrl)).rejects.toMatchObject({
      name: "PolicyDenied",
      code: "POL-WINDOW",
    });
    // Nothing was signed. A refusal that arrives after signing is a different,
    // worse outcome, and asserting this is what stops the test being satisfied
    // by a late failure somewhere else in the flow.
    expect(signer.signCalls).toBe(0);
  });

  it("reports what the store holds, not what the stale local check believed", async () => {
    const context = setup();
    const window: WindowStore = {
      spentInWindow: async () => 0n,
      reserve: async () => ({ accepted: false, spentUnits: 490_000n }),
      commit: async () => undefined,
      markIndeterminate: async () => undefined,
      listIndeterminate: async () => [],
      release: async () => undefined,
    };
    const payer = new Payer({
      signer: context.signer,
      policy: policy(),
      window,
      fetchLike: localFetch(context.server, context.calls),
      now: () => now,
    });

    const failure = await payer.pay(resourceUrl).catch((error: unknown) => error);

    expect(String(failure)).toContain("490000");
    // Guards the un-awaited variant, where the interpolated value reads
    // "undefined" or "[object Promise]" instead of a number.
    expect(String(failure)).not.toContain("undefined");
    expect(String(failure)).not.toContain("Promise");
  });
});
