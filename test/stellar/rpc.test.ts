import { describe, expect, it, vi } from "vitest";

import { WireError } from "../../src/errors.js";
import { StellarRpc } from "../../src/stellar/rpc.js";

const signal = (): AbortSignal => new AbortController().signal;

const rpcResponse = (result: unknown, id = 1): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("StellarRpc", () => {
  it("emits JSON-RPC 2.0 and validates each supported result", async () => {
    const replies = [
      rpcResponse({ id: "ledger-id", sequence: 123, protocolVersion: 25 }),
      rpcResponse({
        latestLedger: 123,
        transactionData: "AAAA",
        minResourceFee: "42",
        results: [],
      }, 2),
      rpcResponse(
        { hash: "a".repeat(64), status: "PENDING", latestLedger: 123 },
        3,
      ),
      rpcResponse(
        { status: "SUCCESS", hash: "a".repeat(64), ledger: 123 },
        4,
      ),
    ];
    const fetchLike = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => replies.shift() as Response);
    const rpc = new StellarRpc("https://rpc.example.test", { fetchLike });

    await expect(rpc.getLatestLedger(signal(), 1_000)).resolves.toMatchObject({
      sequence: 123,
    });
    await expect(
      rpc.simulateTransaction("AAAA", signal(), 1_000),
    ).resolves.toMatchObject({ minResourceFee: "42" });
    await expect(
      rpc.sendTransaction("AAAA", signal(), 1_000),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(
      rpc.getTransaction("a".repeat(64), signal(), 1_000),
    ).resolves.toMatchObject({ status: "SUCCESS" });

    expect(
      fetchLike.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      ),
    ).toEqual([
      { jsonrpc: "2.0", id: 1, method: "getLatestLedger" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "simulateTransaction",
        params: { transaction: "AAAA" },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "sendTransaction",
        params: { transaction: "AAAA" },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "getTransaction",
        params: { hash: "a".repeat(64) },
      },
    ]);
    for (const [, init] of fetchLike.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });

  it("turns malformed and JSON-RPC error responses into WireError", async () => {
    const malformed = new StellarRpc("https://rpc.example.test", {
      fetchLike: async () => rpcResponse({ sequence: "not-a-number" }),
    });
    const failed = new StellarRpc("https://rpc.example.test", {
      fetchLike: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "bad params" },
          }),
          { status: 200 },
        ),
    });

    await expect(malformed.getLatestLedger(signal(), 1_000)).rejects.toBeInstanceOf(
      WireError,
    );
    await expect(failed.getLatestLedger(signal(), 1_000)).rejects.toBeInstanceOf(
      WireError,
    );
  });

  it("bounds the caller timeout", async () => {
    const rpc = new StellarRpc("https://rpc.example.test", {
      fetchLike: async () => rpcResponse({ id: "x", sequence: 1, protocolVersion: 25 }),
    });

    await expect(rpc.getLatestLedger(signal(), 0)).rejects.toBeInstanceOf(WireError);
    await expect(rpc.getLatestLedger(signal(), 60_001)).rejects.toBeInstanceOf(
      WireError,
    );
  });

  it("requires HTTPS unless loopback HTTP is explicitly enabled", () => {
    expect(() => new StellarRpc("http://rpc.example.test")).toThrow(WireError);
    expect(() => new StellarRpc("http://127.0.0.1:8000")).toThrow(WireError);
    expect(
      () =>
        new StellarRpc("http://127.0.0.1:8000", {
          allowHttpOnLoopback: true,
          fetchLike: vi.fn(),
        }),
    ).not.toThrow();
  });
});
