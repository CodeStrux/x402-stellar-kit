import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { WireError } from "../../src/errors.js";
import { HttpFacilitator } from "../../src/facilitator/http.js";
import type {
  FacilitatorRequest,
  SettlementResponse,
  VerifyResponse,
} from "../../src/wire.js";

const fixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(`fixtures/x402/${name}.decoded.json`, "utf8")) as T;

describe("HttpFacilitator", () => {
  it("posts the fixture-pinned envelope and caller-supplied authorization", async () => {
    const verifyRequest = await fixture<FacilitatorRequest>("verify-request");
    const verifyResponse = await fixture<VerifyResponse>("verify-response-ok");
    const settleResponse = await fixture<SettlementResponse>("settle-response");
    const replies = [verifyResponse, settleResponse];
    const fetchLike = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(replies.shift()), { status: 200 }),
    );
    const facilitator = new HttpFacilitator({
      baseUrl: "https://facilitator.example.test/x402/testnet",
      headers: { authorization: "Bearer caller-token" },
      fetchLike,
      timeoutMs: 1_000,
    });

    await expect(
      facilitator.verify(
        verifyRequest.paymentPayload,
        verifyRequest.paymentRequirements,
      ),
    ).resolves.toEqual(verifyResponse);
    await expect(
      facilitator.settle(
        verifyRequest.paymentPayload,
        verifyRequest.paymentRequirements,
      ),
    ).resolves.toEqual(settleResponse);

    expect(fetchLike).toHaveBeenCalledTimes(2);
    expect(fetchLike.mock.calls.map(([url]) => String(url))).toEqual([
      "https://facilitator.example.test/x402/testnet/verify",
      "https://facilitator.example.test/x402/testnet/settle",
    ]);
    for (const [, init] of fetchLike.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual(verifyRequest);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer caller-token");
      expect(headers.get("content-type")).toBe("application/json");
    }
    expect(Array.isArray(JSON.parse(String(fetchLike.mock.calls[0][1]?.body)).paymentRequirements)).toBe(false);
  });

  it("rejects malformed facilitator responses as WireError", async () => {
    const request = await fixture<FacilitatorRequest>("verify-request");
    const facilitator = new HttpFacilitator({
      baseUrl: "https://facilitator.example.test",
      fetchLike: async () =>
        new Response(JSON.stringify({ isValid: "yes" }), { status: 200 }),
    });

    await expect(
      facilitator.verify(request.paymentPayload, request.paymentRequirements),
    ).rejects.toBeInstanceOf(WireError);
  });

  it("rejects unbounded timeouts before transport", async () => {
    expect(
      () =>
        new HttpFacilitator({
          baseUrl: "https://facilitator.example.test",
          timeoutMs: 60_001,
        }),
    ).toThrow(WireError);
  });

  it("requires HTTPS unless loopback HTTP is explicitly enabled", () => {
    expect(
      () => new HttpFacilitator({ baseUrl: "http://facilitator.example.test" }),
    ).toThrow(WireError);
    expect(
      () => new HttpFacilitator({ baseUrl: "http://localhost:8080" }),
    ).toThrow(WireError);
    expect(
      () =>
        new HttpFacilitator({
          baseUrl: "http://localhost:8080",
          allowHttpOnLoopback: true,
          fetchLike: vi.fn(),
        }),
    ).not.toThrow();
  });
});
