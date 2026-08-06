const errorChain = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ");
};

/** Distinguishes retryable infrastructure failures from request/code errors. */
export const isTransientNetworkFailure = (error: unknown): boolean => {
  const message = errorChain(error);
  for (const match of message.matchAll(/\bHTTP\s+(\d{3})\b/gi)) {
    const status = Number(match[1]);
    if (status === 408 || status === 429 || status >= 500) return true;
  }
  return /(?:\btimed?\s*out\b|\btimeout\b|\bfetch failed\b|\bAbortError\b|\bECONN[A-Z_]*\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bUND_ERR_[A-Z_]+\b|\bCERT_[A-Z_]+\b)/i.test(
    message,
  );
};
