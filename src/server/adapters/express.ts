import {
  createResourceServer,
  type ResourceServerOptions,
} from "../resource.js";
import {
  acceptsPaymentMethod,
  GET_ONLY_REASON,
  hasRequestBody,
} from "./get-only.js";

type ExpressRequest = Readonly<{
  method: string;
  protocol: string;
  originalUrl: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  get(name: string): string | undefined;
}>;

type ExpressResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ExpressResponse;
  send(body: string): unknown;
};

export type X402ExpressMiddleware = (
  request: ExpressRequest,
  response: ExpressResponse,
  next: (error?: unknown) => void,
) => Promise<void>;

const sendText = (
  response: ExpressResponse,
  status: number,
  body: string,
): void => {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.status(status).send(body);
};

export const x402Express = (
  config: ResourceServerOptions,
): X402ExpressMiddleware => {
  const server = createResourceServer(config);
  return async (request, response, next) => {
    try {
      if (!acceptsPaymentMethod(request.method)) {
        sendText(response, 405, GET_ONLY_REASON);
        return;
      }
      if (hasRequestBody(request.headers)) {
        sendText(response, 400, GET_ONLY_REASON);
        return;
      }
      const host = request.get("host");
      if (host === undefined) throw new Error("Request Host header is required");
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(",") : value,
        ]),
      ) as Record<string, string | undefined>;
      const result = await server.handle({
        method: request.method,
        url: new URL(request.originalUrl, `${request.protocol}://${host}`).toString(),
        headers,
      });
      if (result.kind === "rejected") {
        sendText(response, result.status, result.reason);
        return;
      }
      for (const [name, value] of Object.entries(result.headers)) {
        response.setHeader(name, value);
      }
      if (result.kind === "challenge") {
        sendText(response, result.status, "payment required");
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};
