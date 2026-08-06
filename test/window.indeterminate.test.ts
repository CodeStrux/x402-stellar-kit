import { describe, expect, it } from "vitest";

import { MemoryWindowStore } from "../src/policy/window.js";

describe("indeterminate window reservations", () => {
  it("keeps an indeterminate debit and its reconciliation data past the window", () => {
    const store = new MemoryWindowStore(60);
    const reservedAt = 1_000;

    store.reserve("reservation-a", 25n, reservedAt, "intent-hash-a");
    store.markIndeterminate("reservation-a");

    const afterWindow = reservedAt + 60_000;
    expect(store.spentInWindow(afterWindow)).toBe(25n);
    expect(store.listIndeterminate(afterWindow)).toEqual([
      {
        id: "reservation-a",
        units: 25n,
        reservedAt,
        intentHash: "intent-hash-a",
      },
    ]);
  });
});
