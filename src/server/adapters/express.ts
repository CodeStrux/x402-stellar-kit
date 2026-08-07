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
  /**
   * Needed to settle *after* the handler and *before* the response flushes.
   * Express hands the response to the application rather than back to the
   * middleware, so intercepting `end` is the only point at which both facts —
   * "the handler succeeded" and "no bytes have left yet" — are true at once.
   */
  end: (...args: never[]) => unknown;
  statusCode: number;
  headersSent: boolean;
};

export type X402ExpressOptions = ResourceServerOptions &
  Readonly<{
    /**
     * Trust `X-Forwarded-Proto` when reconstructing the request URL.
     *
     * Off by default, and deliberately so. The header is set by whoever is
     * talking to this process, and Express already honours it once the
     * application sets `trust proxy` — so reading it unconditionally would
     * override an operator who decided otherwise, in a library that authorizes
     * payments. Turn it on when a TLS terminator you control sits in front of
     * this service, which is the case on Cloud Run, an ALB, nginx, Fly, or
     * Render, and the reason an otherwise correct deployment answers 400 to
     * every paid request.
     */
    trustForwardedProto?: boolean;
  }>;

/**
 * The client-facing scheme from a possibly chained `X-Forwarded-Proto`.
 *
 * Proxies append, so `https, http` means the caller arrived over TLS and the
 * first hop is the one that matters. Anything that is not exactly `http` or
 * `https` is discarded rather than concatenated into a URL — this value is
 * about to be parsed as an origin.
 *
 * Stricter than Express's own parse, which does not restrict the value at all.
 * An app with `trust proxy` enabled may therefore see a scheme this rejects;
 * that asymmetry is intentional, in the safe direction.
 */
const forwardedScheme = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first === "http" || first === "https" ? first : undefined;
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
  config: X402ExpressOptions,
): X402ExpressMiddleware => {
  const server = createResourceServer(config);
  const trustForwardedProto = config.trustForwardedProto === true;
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
      // `request.protocol` already reflects X-Forwarded-Proto when the app sets
      // `trust proxy`; the override matters only when it does not, which is
      // exactly when the reconstructed URL would otherwise say http and the
      // configured resource says https.
      const scheme =
        (trustForwardedProto
          ? forwardedScheme(headers["x-forwarded-proto"])
          : undefined) ?? request.protocol;
      const result = await server.handle({
        method: request.method,
        url: new URL(request.originalUrl, `${scheme}://${host}`).toString(),
        headers,
      });
      if (result.kind === "rejected") {
        sendText(response, result.status, result.reason);
        return;
      }
      if (result.kind === "challenge") {
        for (const [name, value] of Object.entries(result.headers)) {
          response.setHeader(name, value);
        }
        sendText(response, result.status, "payment required");
        return;
      }

      /**
       * Serve first, settle second.
       *
       * A handler that throws or answers 5xx must not cost the payer anything:
       * they would be billed for a response they never received, and their
       * budget would carry a non-expiring indeterminate debit that a human has
       * to reconcile by hand.
       *
       * Express gives the response to the application, not back to us, so the
       * hand-off happens at `end` — the last moment where the handler's status
       * is known and nothing has been written to the socket.
       */
      const originalEnd = response.end.bind(response) as (...args: never[]) => unknown;
      let finishing = false;
      response.end = function patchedEnd(...args: never[]): unknown {
        // Re-entrant call from our own flush below, or headers already gone.
        if (finishing || response.headersSent) return originalEnd(...args);
        finishing = true;

        const succeeded = response.statusCode >= 200 && response.statusCode < 300;
        if (!succeeded) return originalEnd(...args);

        void result
          .settle()
          .then((settled) => {
            if (settled.kind === "rejected") {
              // The resource was produced but could not be paid for. Answering
              // 200 here would give it away; answering 402 is the truth.
              response.statusCode = settled.status;
              response.setHeader("content-type", "text/plain; charset=utf-8");
              return originalEnd(settled.reason as never);
            }
            for (const [name, value] of Object.entries(settled.headers)) {
              response.setHeader(name, value);
            }
            return originalEnd(...args);
          })
          .catch(() => {
            if (!response.headersSent) response.statusCode = 402;
            return originalEnd();
          });
        return response;
      } as ExpressResponse["end"];

      next();
    } catch (error) {
      next(error);
    }
  };
};
