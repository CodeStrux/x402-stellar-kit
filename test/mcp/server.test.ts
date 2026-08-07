import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { createX402McpServer } from "../../mcp/server.js";
import type { ApprovalResult, Approver } from "../../src/approver/index.js";
import type { Facilitator } from "../../src/facilitator/index.js";
import { MockFacilitator } from "../../src/facilitator/mock.js";
import type { PaymentIntent } from "../../src/intent.js";
import type { PolicyConfig } from "../../src/policy/types.js";
import { MemoryWindowStore } from "../../src/policy/window.js";
import { createResourceServer, type ResourceResult } from "../../src/server/resource.js";
import { MockSigner, type Signer } from "../../src/signer.js";

const resourceUrl = "https://example.test/mcp-resource";
const payerAddress = "payer-mcp";
const payeeAddress = "payee-mcp";
const asset = "asset-mcp";
const network = "stellar:testnet";
const privateSentinel = "never-return-private-material";
const approvalSentinel = "never-return-approval-material";

class RecordingSigner implements Signer {
  readonly privateMaterial = privateSentinel;
  readonly #delegate = new MockSigner(payerAddress);
  signCalls = 0;

  address(): string {
    return this.#delegate.address();
  }

  async sign(intent: PaymentIntent): Promise<{ transaction: string }> {
    this.signCalls += 1;
    return this.#delegate.sign(intent);
  }

  verifyBinding(transaction: string, intent: PaymentIntent): void {
    this.#delegate.verifyBinding(transaction, intent);
  }
}

class CodeSpoofingSigner extends RecordingSigner {
  override async sign(): Promise<{ transaction: string }> {
    this.signCalls += 1;
    throw Object.assign(new Error(privateSentinel), { code: "POL-MAX" });
  }
}

class McpErrorSpoofingSigner extends RecordingSigner {
  override async sign(): Promise<{ transaction: string }> {
    this.signCalls += 1;
    throw new McpError(ErrorCode.InternalError, privateSentinel);
  }
}

class EvidenceApprover implements Approver {
  async approve(_intent: PaymentIntent, intentHash: string): Promise<ApprovalResult> {
    return {
      approved: true,
      evidence: { challenge: intentHash, private: approvalSentinel },
    };
  }
}

class SensitiveDenyingApprover implements Approver {
  async approve(): Promise<ApprovalResult> {
    return { approved: false, reason: privateSentinel };
  }
}

const asResponse = async (result: ResourceResult): Promise<Response> => {
  if (result.kind === "rejected") {
    return new Response(result.reason, { status: result.status });
  }
  if (result.kind === "challenge") {
    return new Response("payment required", {
      status: result.status,
      headers: result.headers,
    });
  }
  const body = "paid MCP body";
  const settled = await result.settle();
  if (settled.kind === "rejected") {
    return new Response(settled.reason, { status: settled.status });
  }
  return new Response(body, { status: settled.status, headers: settled.headers });
};

const createHarness = (maxPaymentUnits = 200_000n) => {
  const delegate = new MockFacilitator(payerAddress);
  delegate.credit(payerAddress, 1_000_000n);
  let settlementCalls = 0;
  const facilitator: Facilitator = {
    verify: (payload, requirements) => delegate.verify(payload, requirements),
    settle: (payload, requirements) => {
      settlementCalls += 1;
      return delegate.settle(payload, requirements);
    },
  };
  const resource = createResourceServer({
    price: "0.01",
    payTo: payeeAddress,
    asset,
    network,
    facilitator,
    resource: { url: resourceUrl, description: "MCP test resource" },
  });
  const fetchLike: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    return await asResponse(
      await resource.handle({
        method: request.method,
        url: request.url,
        headers: request.headers,
      }),
    );
  };
  const policy: PolicyConfig = {
    allowedNetworks: [network],
    originAllowlist: [new URL(resourceUrl).origin],
    payToAllowlist: [payeeAddress],
    assetAllowlist: [asset],
    maxPaymentUnits,
    windowCapUnits: 500_000n,
    windowSeconds: 3_600,
    maxTimeoutSeconds: 60,
    autoApproveMaxUnits: 0n,
  };
  const signer = new RecordingSigner();
  const window = new MemoryWindowStore(policy.windowSeconds);
  return {
    policy,
    signer,
    window,
    fetchLike,
    settlementCalls: () => settlementCalls,
  };
};

const clients: Client[] = [];
const servers: Array<Awaited<ReturnType<typeof createX402McpServer>>> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const connect = async (
  harness: ReturnType<typeof createHarness>,
  approver: Approver = new EvidenceApprover(),
  limits: Readonly<{
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  }> = {},
) => {
  const server = await createX402McpServer({
    signer: harness.signer,
    policy: harness.policy,
    window: harness.window,
    approver,
    fetchLike: harness.fetchLike,
    now: () => 1_000,
    ...limits,
  });
  const client = new Client({ name: "x402-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const structured = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> => {
  if (result.structuredContent === undefined || result.structuredContent === null) {
    throw new Error("Expected structured tool content");
  }
  return result.structuredContent as Record<string, unknown>;
};

describe("x402 MCP server", () => {
  it("renders the bound intent without signing or settling", async () => {
    const harness = createHarness();
    const client = await connect(harness);

    const result = await client.callTool({
      name: "x402_render_payment_intent",
      arguments: { url: resourceUrl },
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      outcome: "intent",
      intent: {
        network,
        scheme: "exact",
        asset,
        payTo: payeeAddress,
        amountUnits: "100000",
        resourceUrl,
        maxTimeoutSeconds: 60,
      },
      intentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(harness.signer.signCalls).toBe(0);
    expect(harness.settlementCalls()).toBe(0);
  });

  it("returns a policy denial as structured data instead of throwing", async () => {
    const harness = createHarness(99_999n);
    const client = await connect(harness);

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toEqual({
      outcome: "denied",
      code: "POL-MAX",
      reason: "The payment amount is non-positive or exceeds the per-payment cap.",
    });
    expect(harness.signer.signCalls).toBe(0);
    expect(harness.settlementCalls()).toBe(0);
  });

  it("does not echo approver-provided denial text", async () => {
    const client = await connect(createHarness(), new SensitiveDenyingApprover());

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });

    expect(structured(result)).toEqual({
      outcome: "denied",
      code: "POL-DENIED",
      reason: "The approver denied the payment.",
    });
    expect(JSON.stringify(result)).not.toContain(privateSentinel);
  });

  it("does not trust a policy-shaped code thrown by an external signer", async () => {
    const harness = createHarness();
    harness.signer = new CodeSpoofingSigner();
    const client = await connect(harness);

    let failure: unknown;
    try {
      await client.callTool({
        name: "x402_paid_fetch",
        arguments: { url: resourceUrl },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toMatch(/inspect stderr diagnostics/);
    expect(String(failure)).not.toContain(privateSentinel);
    const budget = await client.callTool({
      name: "x402_budget_status",
      arguments: {},
    });
    expect(structured(budget)).toMatchObject({
      spentUnits: "0",
      remainingUnits: "500000",
      indeterminate: [],
    });
  });

  it("redacts an MCP error propagated by an external signer", async () => {
    const harness = createHarness();
    harness.signer = new McpErrorSpoofingSigner();
    const client = await connect(harness);

    let failure: unknown;
    try {
      await client.callTool({
        name: "x402_paid_fetch",
        arguments: { url: resourceUrl },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toMatch(/inspect stderr diagnostics/);
    expect(String(failure)).not.toContain(privateSentinel);
  });

  it("keeps a code-spoofed post-transmission failure indeterminate", async () => {
    const harness = createHarness();
    const fetchLike = harness.fetchLike;
    let calls = 0;
    harness.fetchLike = async (input, init) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error(privateSentinel), { code: "POL-MAX" });
      }
      return fetchLike(input, init);
    };
    const client = await connect(harness);

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });

    // Reported as an outcome, not thrown. The spoofed POL-MAX must not survive
    // either: a denial code claims nothing was spent, and something was.
    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      outcome: "indeterminate",
      transmitted: true,
    });
    expect(structured(result)).not.toHaveProperty("code");
    expect(JSON.stringify(result)).not.toContain(privateSentinel);
    const budget = await client.callTool({
      name: "x402_budget_status",
      arguments: {},
    });
    expect(structured(budget)).toMatchObject({
      spentUnits: "100000",
      remainingUnits: "400000",
      indeterminate: [
        expect.objectContaining({ units: "100000" }),
      ],
    });
  });

  it("bounds a paid response body and retains the transmitted debit", async () => {
    const harness = createHarness();
    const client = await connect(harness, new EvidenceApprover(), {
      maxResponseBytes: 4,
    });

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });
    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({ outcome: "indeterminate" });

    const budget = await client.callTool({
      name: "x402_budget_status",
      arguments: {},
    });
    expect(structured(budget)).toMatchObject({
      spentUnits: "100000",
      remainingUnits: "400000",
      indeterminate: [expect.objectContaining({ units: "100000" })],
    });
  });

  it("times out slow paid response bodies and retains the transmitted debit", async () => {
    const harness = createHarness();
    const fetchLike = harness.fetchLike;
    let calls = 0;
    harness.fetchLike = async (input, init) => {
      calls += 1;
      const response = await fetchLike(input, init);
      if (calls !== 2) return response;
      void response.body?.cancel();
      const encoded = new TextEncoder().encode("slow body");
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 75));
            controller.enqueue(encoded);
            controller.close();
          },
        }),
        { status: response.status, headers: response.headers },
      );
    };
    const client = await connect(harness, new EvidenceApprover(), {
      requestTimeoutMs: 10,
    });

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });
    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({ outcome: "indeterminate" });

    const budget = await client.callTool({
      name: "x402_budget_status",
      arguments: {},
    });
    expect(structured(budget)).toMatchObject({
      spentUnits: "100000",
      remainingUnits: "400000",
      indeterminate: [expect.objectContaining({ units: "100000" })],
    });
  });

  it("rejects method and body arguments with the missing-binding reason", async () => {
    const client = await connect(createHarness());

    await expect(
      client.callTool({
        name: "x402_paid_fetch",
        arguments: { url: resourceUrl, method: "POST" },
      }),
    ).rejects.toThrow(/intentHash does not bind HTTP methods/);
    await expect(
      client.callTool({
        name: "x402_paid_fetch",
        arguments: { url: resourceUrl, body: "change state" },
      }),
    ).rejects.toThrow(/intentHash does not bind request bodies/);
  });

  it("reports remaining budget and persistent indeterminate reservations", async () => {
    const harness = createHarness();
    await harness.window.reserve("pending-1", 125_000n, 1_000, "a".repeat(64), 500_000n);
    await harness.window.markIndeterminate("pending-1");
    const client = await connect(harness);

    const result = await client.callTool({ name: "x402_budget_status", arguments: {} });

    expect(structured(result)).toEqual({
      outcome: "budget",
      windowCapUnits: "500000",
      spentUnits: "125000",
      remainingUnits: "375000",
      windowSeconds: 3_600,
      indeterminate: [
        {
          id: "pending-1",
          units: "125000",
          reservedAt: 1_000,
          intentHash: "a".repeat(64),
        },
      ],
    });
  });

  it("exposes only the three fixed-policy tools and never returns private material", async () => {
    const harness = createHarness();
    const client = await connect(harness);
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "x402_render_payment_intent",
      "x402_paid_fetch",
      "x402_budget_status",
    ]);
    const paidTool = listed.tools.find((tool) => tool.name === "x402_paid_fetch");
    expect(paidTool?.description).toMatch(/GET only/);
    expect(paidTool?.description).toMatch(/does not bind method or body/);
    expect(paidTool?.inputSchema).toEqual({
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
      additionalProperties: false,
    });

    const results = [
      await client.callTool({
        name: "x402_render_payment_intent",
        arguments: { url: resourceUrl },
      }),
      await client.callTool({
        name: "x402_paid_fetch",
        arguments: { url: resourceUrl },
      }),
      await client.callTool({ name: "x402_budget_status", arguments: {} }),
    ];
    const paidResult = results[1];
    if (paidResult === undefined) throw new Error("Expected paid result");
    expect(structured(paidResult)).toMatchObject({
      outcome: "paid",
      remoteContent: {
        contentIndex: 1,
        trust: "untrusted-remote-data",
      },
    });
    expect(structured(paidResult)).not.toHaveProperty("body");
    expect(paidResult.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/untrusted remote data/i),
      }),
      {
        type: "resource",
        resource: {
          uri: resourceUrl,
          mimeType: "text/plain",
          text: "paid MCP body",
          _meta: { "x402/trust": "untrusted-remote-data" },
        },
      },
    ]);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain(approvalSentinel);
    expect(serialized).not.toContain('"evidence"');
  });
});

describe("the preview chooses the same offer the payment would", () => {
  const challengeHeader = (accepts: readonly unknown[]): string =>
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        error: "Payment required",
        resource: { url: resourceUrl, description: "MCP test resource" },
        accepts,
      }),
      "utf8",
    ).toString("base64");

  const exactOffer = {
    scheme: "exact",
    network,
    amount: "100000",
    asset,
    payTo: payeeAddress,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };

  const serving = (accepts: readonly unknown[]) => {
    const harness = createHarness();
    return {
      ...harness,
      fetchLike: async () =>
        new Response("payment required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challengeHeader(accepts) },
        }),
    };
  };

  it("renders the exact offer out of a mixed-scheme challenge", async () => {
    const client = await connect(
      serving([{ scheme: "upto", network, maxAmount: "500000" }, exactOffer]),
    );

    const result = await client.callTool({
      name: "x402_render_payment_intent",
      arguments: { url: resourceUrl },
    });

    expect(structured(result)).toMatchObject({
      outcome: "intent",
      intent: { scheme: "exact", amountUnits: "100000", payTo: payeeAddress },
    });
  });

  it("denies POL-SCHEME when no offer uses a payable scheme", async () => {
    const client = await connect(serving([{ scheme: "upto", network }]));

    const result = await client.callTool({
      name: "x402_render_payment_intent",
      arguments: { url: resourceUrl },
    });

    expect(structured(result)).toEqual({
      outcome: "denied",
      code: "POL-SCHEME",
      reason: "The payment scheme is not exact.",
    });
  });
});

/**
 * The defect these cover: `denialCode` deliberately returns `undefined` for any
 * error carrying `transmitted === true`, so a payment that had already left the
 * process fell through to a generic `InternalError` reading "inspect stderr
 * diagnostics". That is the shape that invites a retry, and a retry after
 * transmission pays twice — with `intentHash`, the one handle a human has for
 * reconciling it, sitting unread on the error object the whole time.
 */
describe("a transmitted payment is reported, never hidden behind an internal error", () => {
  const transmitted = (): Error =>
    Object.assign(new Error(privateSentinel), {
      transmitted: true,
      intentHash: "f".repeat(64),
    });

  /**
   * Fails only on the request that carries `PAYMENT-SIGNATURE`.
   *
   * This is the whole reason the test bites. Call 1 is `probe`; by call 2
   * `Payer.pay` has already set `signatureTransmitted` (src/payer.ts:250), so
   * the failure runs through `withTransmissionContext` and is stamped with real
   * `transmitted`/`intentHash` properties. A test that failed earlier would
   * produce an ordinary error, take the pre-transmission release path, and pass
   * with or without the fix.
   */
  const failingAfterTransmission = (harness: ReturnType<typeof createHarness>) => {
    let calls = 0;
    const fetchLike: typeof globalThis.fetch = async (input, init) => {
      calls += 1;
      if (calls >= 2) throw new Error("connection reset after the signature left");
      return harness.fetchLike(input, init);
    };
    return { ...harness, fetchLike };
  };

  it("returns an indeterminate outcome carrying the intent hash", async () => {
    const harness = createHarness();
    const client = await connect(failingAfterTransmission(harness));

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      outcome: "indeterminate",
      transmitted: true,
      intentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(result)).toMatch(/do not retry/i);
  });

  it("reports the same intent hash the preview rendered", async () => {
    const harness = createHarness();
    const preview = await (await connect(harness)).callTool({
      name: "x402_render_payment_intent",
      arguments: { url: resourceUrl },
    });
    const client = await connect(failingAfterTransmission(harness));

    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });

    expect(structured(result).intentHash).toBe(structured(preview).intentHash);
  });

  it("returns rather than throws, so a client cannot treat it as retryable", async () => {
    const harness = createHarness();
    const client = await connect(failingAfterTransmission(harness));

    // Not `rejects`: a thrown McpError is a protocol failure a client may retry
    // automatically, which is the one thing that must not happen here.
    const result = await client.callTool({
      name: "x402_paid_fetch",
      arguments: { url: resourceUrl },
    });
    expect(result).toBeDefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain(approvalSentinel);
  });

  it("still refuses a payment that failed before transmission with an error", async () => {
    // A signer that throws never reaches the transport, so nothing was
    // transmitted and nothing may have settled. Claiming indeterminacy here
    // would be a lie in the safe direction, which is still a lie.
    const harness = createHarness();
    harness.signer.sign = async () => {
      throw new Error("signer unavailable");
    };
    const client = await connect(harness);

    await expect(
      client.callTool({ name: "x402_paid_fetch", arguments: { url: resourceUrl } }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("ignores a forged transmitted flag from a tool that cannot transmit", async () => {
    // x402_render_payment_intent advertises that it pays nothing and never
    // settles. A `transmitted` flag reaching it is forged by definition, and
    // answering it with "money may have moved" would contradict the tool's own
    // description on the strength of an attacker-set property.
    const harness = createHarness();
    const client = await connect({
      ...harness,
      fetchLike: async () => {
        throw transmitted();
      },
    });

    await expect(
      client.callTool({
        name: "x402_render_payment_intent",
        arguments: { url: resourceUrl },
      }),
    ).rejects.toBeInstanceOf(McpError);
  });
});
