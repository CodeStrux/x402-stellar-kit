import {
  createResourceServer,
  type ResourceServerOptions,
} from "../resource.js";
import {
  acceptsPaymentMethod,
  GET_ONLY_REASON,
  hasRequestBody,
} from "./get-only.js";

export type X402RouteHandler<
  RequestType extends Request = Request,
  ContextType = unknown,
> = (
  request: RequestType,
  context: ContextType,
) => Response | Promise<Response>;

export const x402Next = (config: ResourceServerOptions) => {
  const server = createResourceServer(config);
  return <RequestType extends Request, ContextType>(
    handler: X402RouteHandler<RequestType, ContextType>,
  ): X402RouteHandler<RequestType, ContextType> =>
    async (request, context) => {
      if (!acceptsPaymentMethod(request.method)) {
        return new Response(GET_ONLY_REASON, { status: 405 });
      }
      if (hasRequestBody(request.headers, request.body)) {
        return new Response(GET_ONLY_REASON, { status: 400 });
      }
      const result = await server.handle({
        method: request.method,
        url: request.url,
        headers: request.headers,
      });
      if (result.kind === "rejected") {
        return new Response(result.reason, { status: result.status });
      }
      if (result.kind === "challenge") {
        return new Response("payment required", {
          status: result.status,
          headers: result.headers,
        });
      }
      // Serve first, settle second. A handler that throws or answers 5xx must
      // not cost the payer anything: they would be billed for a response they
      // never received, and their budget would carry a non-expiring
      // indeterminate debit needing manual reconciliation.
      const downstream = await handler(request, context);
      if (!downstream.ok) return downstream;

      const settled = await result.settle();
      if (settled.kind === "rejected") {
        return new Response(settled.reason, { status: settled.status });
      }

      const headers = new Headers(downstream.headers);
      for (const [name, value] of Object.entries(settled.headers)) {
        headers.set(name, value);
      }
      return new Response(downstream.body, {
        status: downstream.status,
        statusText: downstream.statusText,
        headers,
      });
    };
};
