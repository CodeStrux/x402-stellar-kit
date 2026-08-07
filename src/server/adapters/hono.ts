import {
  createResourceServer,
  type ResourceServerOptions,
} from "../resource.js";
import {
  acceptsPaymentMethod,
  GET_ONLY_REASON,
  hasRequestBody,
} from "./get-only.js";

type HonoContext = Readonly<{
  req: Readonly<{
    method: string;
    url: string;
    raw: Readonly<{
      body: ReadableStream<Uint8Array> | null;
      headers: Headers;
    }>;
  }>;
  header(name: string, value: string): void;
  text(value: string, status: 400 | 402 | 405): Response;
  /** Set by Hono once the downstream handler has run. */
  res?: { status: number } | undefined;
}>;

export type X402HonoMiddleware = (
  context: HonoContext,
  next: () => Promise<void>,
) => Promise<Response | void>;

export const x402Hono = (
  config: ResourceServerOptions,
): X402HonoMiddleware => {
  const server = createResourceServer(config);
  return async (context, next) => {
    if (!acceptsPaymentMethod(context.req.method)) {
      return context.text(GET_ONLY_REASON, 405);
    }
    if (hasRequestBody(context.req.raw.headers, context.req.raw.body)) {
      return context.text(GET_ONLY_REASON, 400);
    }
    const result = await server.handle({
      method: context.req.method,
      url: context.req.url,
      headers: context.req.raw.headers,
    });
    if (result.kind === "rejected") {
      return context.text(result.reason, result.status);
    }
    if (result.kind === "challenge") {
      for (const [name, value] of Object.entries(result.headers)) {
        context.header(name, value);
      }
      return context.text("payment required", result.status);
    }
    // Serve first, settle second. A handler that throws or answers 5xx must not
    // cost the payer anything: they would be billed for a response they never
    // received, and their budget would carry a non-expiring indeterminate debit
    // needing manual reconciliation.
    await next();

    const status = context.res?.status ?? 200;
    if (status < 200 || status >= 300) return;

    const settled = await result.settle();
    if (settled.kind === "rejected") {
      return context.text(settled.reason, settled.status);
    }
    for (const [name, value] of Object.entries(settled.headers)) {
      context.header(name, value);
    }
  };
};
