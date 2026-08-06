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
    await next();
    for (const [name, value] of Object.entries(result.headers)) {
      context.header(name, value);
    }
  };
};
