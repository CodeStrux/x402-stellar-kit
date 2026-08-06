import { vi } from "vitest";

globalThis.fetch = vi.fn(async () => {
  throw new Error("Network access is disabled in the test suite");
}) as typeof globalThis.fetch;
