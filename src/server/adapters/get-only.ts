export const GET_ONLY_REASON =
  "x402 payments require GET with no body because PaymentIntent does not bind the request method or body";

export const acceptsPaymentMethod = (method: string): boolean =>
  method.toUpperCase() === "GET";

type BodyHeaders =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | Readonly<{ get(name: string): string | null }>;

const headerValue = (headers: BodyHeaders, name: string): string | undefined => {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  if (typeof value === "string" || value === undefined) return value;
  return value.join(",");
};

export const hasRequestBody = (
  headers: BodyHeaders,
  body?: unknown,
): boolean => {
  if (body !== undefined && body !== null) return true;
  if (headerValue(headers, "transfer-encoding") !== undefined) return true;
  const contentLength = headerValue(headers, "content-length");
  return contentLength !== undefined && !/^0+$/.test(contentLength.trim());
};
