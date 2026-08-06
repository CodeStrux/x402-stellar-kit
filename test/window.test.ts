import { describe, expect, it } from "vitest";

import { MemoryWindowStore } from "../src/policy/window.js";

describe("MemoryWindowStore", () => {
  it("counts reservations and committed entries", () => {
    const store = new MemoryWindowStore(60);

    store.reserve("a", 10n, 1_000, "intent-a");
    store.reserve("b", 20n, 1_001, "intent-b");
    expect(store.spentInWindow(1_002)).toBe(30n);

    store.commit("a");
    expect(store.spentInWindow(1_003)).toBe(30n);
  });

  it("release frees a reservation", () => {
    const store = new MemoryWindowStore(60);
    store.reserve("a", 10n, 1_000, "intent-a");

    store.release("a");

    expect(store.spentInWindow(1_001)).toBe(0n);
  });

  it("an uncommitted reservation still consumes the window", () => {
    const store = new MemoryWindowStore(60);

    store.reserve("pending", 25n, 1_000, "intent-pending");

    expect(store.spentInWindow(60_999)).toBe(25n);
  });

  it("expires entries at the exact configured age", () => {
    const store = new MemoryWindowStore(60);
    store.reserve("old", 25n, 1_000, "intent-old");
    store.commit("old");

    expect(store.spentInWindow(60_999)).toBe(25n);
    expect(store.spentInWindow(61_000)).toBe(0n);
  });

  it("rejects duplicate reservation ids", () => {
    const store = new MemoryWindowStore(60);
    store.reserve("same", 10n, 1_000, "intent-same");

    expect(() => store.reserve("same", 10n, 1_001, "intent-same")).toThrow(
      "Duplicate reservation id",
    );
  });

  it("rejects non-positive reservations and invalid windows", () => {
    expect(() => new MemoryWindowStore(0)).toThrow("Invalid windowSeconds");
    const store = new MemoryWindowStore(60);
    expect(() => store.reserve("zero", 0n, 1_000, "intent-zero")).toThrow(
      "Reservation units must be positive",
    );
  });

  it("requires a reservation before commit", () => {
    const store = new MemoryWindowStore(60);

    expect(() => store.commit("missing")).toThrow("Unknown reservation id");
  });
});
