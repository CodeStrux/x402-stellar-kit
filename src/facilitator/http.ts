import type { z } from "zod";

import { X402_VERSION } from "../constants.js";
import { WireError } from "../errors.js";
import {
  FacilitatorRequestSchema,
  SettlementResponseSchema,
  VerifyResponseSchema,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type VerifyResponse,
} from "../wire.js";
import type { Facilitator } from "./index.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export type HttpFacilitatorOptions = Readonly<{
  baseUrl: string;
  headers?: HeadersInit;
  fetchLike?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Permits cleartext only for an explicitly selected loopback dev endpoint. */
  allowHttpOnLoopback?: boolean;
}>;

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

const boundedTimeout = (timeoutMs: number): number => {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new WireError(
      `Facilitator timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`,
    );
  }
  return timeoutMs;
};

const callSignal = (
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(caller?.reason);
  if (caller?.aborted === true) {
    abort();
  } else {
    caller?.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Facilitator request timed out after ${timeoutMs} ms`),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    },
  };
};

export class HttpFacilitator implements Facilitator {
  readonly #baseUrl: URL;
  readonly #headers: Headers;
  readonly #fetchLike: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  constructor(options: HttpFacilitatorOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch (error) {
      throw new WireError("Facilitator base URL is invalid", { cause: error });
    }
    const secureTransport =
      baseUrl.protocol === "https:" ||
      (baseUrl.protocol === "http:" &&
        options.allowHttpOnLoopback === true &&
        isLoopback(baseUrl.hostname));
    if (
      !secureTransport ||
      baseUrl.username.length > 0 ||
      baseUrl.password.length > 0 ||
      baseUrl.search.length > 0 ||
      baseUrl.hash.length > 0
    ) {
      throw new WireError(
        "Facilitator base URL must use HTTPS without credentials, query, or fragment; loopback HTTP requires explicit opt-in",
      );
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
    this.#baseUrl = baseUrl;
    this.#headers = new Headers(options.headers);
    this.#headers.set("content-type", "application/json");
    this.#fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#signal = options.signal;
  }

  async #post<T>(
    path: "verify" | "settle",
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let request: unknown;
    try {
      request = FacilitatorRequestSchema.parse({
        x402Version: X402_VERSION,
        paymentPayload: payload,
        paymentRequirements: requirements,
      });
    } catch (error) {
      throw new WireError("Cannot send invalid facilitator request data", {
        cause: error,
      });
    }

    const bounded = callSignal(this.#signal, this.#timeoutMs);
    try {
      const response = await this.#fetchLike(new URL(path, this.#baseUrl), {
        method: "POST",
        headers: new Headers(this.#headers),
        body: JSON.stringify(request),
        signal: bounded.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new WireError(
          `Facilitator /${path} returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        body = (await response.json()) as unknown;
      } catch (error) {
        throw new WireError(`Facilitator /${path} returned invalid JSON`, {
          cause: error,
        });
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new WireError(`Facilitator /${path} returned malformed data`, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof WireError) throw error;
      throw new WireError(`Facilitator /${path} request failed`, { cause: error });
    } finally {
      bounded.cleanup();
    }
  }

  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.#post("verify", payload, requirements, VerifyResponseSchema);
  }

  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    return this.#post("settle", payload, requirements, SettlementResponseSchema);
  }
}
