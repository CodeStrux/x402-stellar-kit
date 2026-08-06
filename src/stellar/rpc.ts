import { z } from "zod";

import { WireError } from "../errors.js";

const MAX_TIMEOUT_MS = 60_000;
const MAX_LEDGER_SEQUENCE = 0xffff_ffff;
const MAX_I64 = (1n << 63n) - 1n;
const MAX_XDR_STRING_LENGTH = 1_000_000;

const UnsignedI64StringSchema = z
  .string()
  .regex(/^\d+$/)
  .max(19)
  .refine((value) => BigInt(value) <= MAX_I64);

const RpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

const RpcEnvelopeSchema = z.union([
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.number().int(), z.string()]),
      result: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.number().int(), z.string(), z.null()]),
      error: RpcErrorSchema,
    })
    .passthrough(),
]);

export const LatestLedgerSchema = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
    protocolVersion: z.number().int().nonnegative(),
  })
  .passthrough();

const SimulationResultItemSchema = z
  .object({
    auth: z.array(z.string()).optional(),
    xdr: z.string().optional(),
  })
  .passthrough();

const SuccessfulSimulationSchema = z
  .object({
    latestLedger: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
    transactionData: z.string().min(1).max(MAX_XDR_STRING_LENGTH),
    minResourceFee: UnsignedI64StringSchema,
    results: z.array(SimulationResultItemSchema).optional(),
    events: z.array(z.string()).optional(),
    restorePreamble: z
      .object({
        transactionData: z.string().min(1).max(MAX_XDR_STRING_LENGTH),
        minResourceFee: UnsignedI64StringSchema,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const FailedSimulationSchema = z
  .object({
    latestLedger: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
    error: z.string().min(1),
  })
  .passthrough();

export const SimulationResponseSchema = z.union([
  SuccessfulSimulationSchema,
  FailedSimulationSchema,
]);

export const SendTransactionResponseSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    status: z.enum(["PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR"]),
    latestLedger: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
    errorResultXdr: z.string().optional(),
    diagnosticEventsXdr: z.array(z.string()).optional(),
  })
  .passthrough();

const MissingTransactionSchema = z
  .object({
    status: z.literal("NOT_FOUND"),
    latestLedger: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_LEDGER_SEQUENCE)
      .optional(),
  })
  .passthrough();

const CompletedTransactionSchema = z
  .object({
    status: z.enum(["SUCCESS", "FAILED"]),
    hash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    ledger: z.number().int().nonnegative().max(MAX_LEDGER_SEQUENCE),
    latestLedger: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_LEDGER_SEQUENCE)
      .optional(),
    envelopeXdr: z.string().optional(),
    resultXdr: z.string().optional(),
    resultMetaXdr: z.string().optional(),
  })
  .passthrough();

export const GetTransactionResponseSchema = z.union([
  MissingTransactionSchema,
  CompletedTransactionSchema,
]);

export type LatestLedger = z.infer<typeof LatestLedgerSchema>;
export type SimulationResponse = z.infer<typeof SimulationResponseSchema>;
export type SendTransactionResponse = z.infer<
  typeof SendTransactionResponseSchema
>;
export type GetTransactionResponse = z.infer<
  typeof GetTransactionResponseSchema
>;

export type StellarRpcOptions = Readonly<{
  fetchLike?: typeof globalThis.fetch;
  /** Permits cleartext only for an explicitly selected loopback dev endpoint. */
  allowHttpOnLoopback?: boolean;
}>;

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

const validateTimeout = (timeoutMs: number): void => {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new WireError(`RPC timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`);
  }
};

const requestSignal = (
  callerSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } => {
  validateTimeout(timeoutMs);
  const controller = new AbortController();
  const abort = (): void => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) {
    abort();
  } else {
    callerSignal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`RPC request timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", abort);
    },
  };
};

export class StellarRpc {
  readonly #url: string;
  readonly #fetchLike: typeof globalThis.fetch;
  #requestId = 0;

  constructor(url: string, options: StellarRpcOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      throw new WireError("Stellar RPC URL is invalid", { cause: error });
    }
    const secureTransport =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        options.allowHttpOnLoopback === true &&
        isLoopback(parsed.hostname));
    if (
      !secureTransport ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new WireError(
        "Stellar RPC URL must use HTTPS without credentials; loopback HTTP requires explicit opt-in",
      );
    }
    this.#url = parsed.toString();
    this.#fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
  }

  async #call<T>(
    method: string,
    params: Readonly<Record<string, unknown>> | undefined,
    schema: z.ZodType<T>,
    callerSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> {
    const requestId = ++this.#requestId;
    const bounded = requestSignal(callerSignal, timeoutMs);
    try {
      const response = await this.#fetchLike(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: bounded.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new WireError(
          `Stellar RPC ${method} returned HTTP ${response.status}`,
        );
      }

      let body: unknown;
      try {
        body = (await response.json()) as unknown;
      } catch (error) {
        throw new WireError(`Stellar RPC ${method} returned invalid JSON`, {
          cause: error,
        });
      }
      const envelope = RpcEnvelopeSchema.safeParse(body);
      if (!envelope.success) {
        throw new WireError(`Stellar RPC ${method} returned a malformed response`, {
          cause: envelope.error,
        });
      }
      if (envelope.data.id !== requestId) {
        throw new WireError(`Stellar RPC ${method} returned the wrong response id`);
      }
      if ("error" in envelope.data) {
        const rpcError = RpcErrorSchema.safeParse(envelope.data.error);
        if (!rpcError.success) {
          throw new WireError(`Stellar RPC ${method} returned a malformed error`, {
            cause: rpcError.error,
          });
        }
        throw new WireError(
          `Stellar RPC ${method} failed: ${rpcError.data.message}`,
        );
      }
      const result = schema.safeParse(envelope.data.result);
      if (!result.success) {
        throw new WireError(`Stellar RPC ${method} returned a malformed result`, {
          cause: result.error,
        });
      }
      return result.data;
    } catch (error) {
      if (error instanceof WireError) {
        throw error;
      }
      throw new WireError(`Stellar RPC ${method} request failed`, { cause: error });
    } finally {
      bounded.cleanup();
    }
  }

  getLatestLedger(signal: AbortSignal, timeoutMs: number): Promise<LatestLedger> {
    return this.#call(
      "getLatestLedger",
      undefined,
      LatestLedgerSchema,
      signal,
      timeoutMs,
    );
  }

  simulateTransaction(
    transaction: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<SimulationResponse> {
    return this.#call(
      "simulateTransaction",
      { transaction },
      SimulationResponseSchema,
      signal,
      timeoutMs,
    );
  }

  sendTransaction(
    transaction: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<SendTransactionResponse> {
    return this.#call(
      "sendTransaction",
      { transaction },
      SendTransactionResponseSchema,
      signal,
      timeoutMs,
    );
  }

  getTransaction(
    hash: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<GetTransactionResponse> {
    return this.#call(
      "getTransaction",
      { hash },
      GetTransactionResponseSchema,
      signal,
      timeoutMs,
    );
  }
}

export { StellarRpc as SorobanRpcClient };
