import { describe, expect, it } from "vitest";

import { MemoryWindowStore } from "../src/policy/window.js";

/** Well above every amount here, so the cap is not what is under test. */
const CAP = 1_000_000n;

describe("MemoryWindowStore", () => {
  it("counts reservations and committed entries", async () => {
    const store = new MemoryWindowStore(60);

    await store.reserve("a", 10n, 1_000, "intent-a", CAP);
    await store.reserve("b", 20n, 1_001, "intent-b", CAP);
    expect(await store.spentInWindow(1_002)).toBe(30n);

    await store.commit("a");
    expect(await store.spentInWindow(1_003)).toBe(30n);
  });

  it("release frees a reservation", async () => {
    const store = new MemoryWindowStore(60);
    await store.reserve("a", 10n, 1_000, "intent-a", CAP);

    await store.release("a");

    expect(await store.spentInWindow(1_001)).toBe(0n);
  });

  it("an uncommitted reservation still consumes the window", async () => {
    const store = new MemoryWindowStore(60);

    await store.reserve("pending", 25n, 1_000, "intent-pending", CAP);

    expect(await store.spentInWindow(60_999)).toBe(25n);
  });

  it("expires entries at the exact configured age", async () => {
    const store = new MemoryWindowStore(60);
    await store.reserve("old", 25n, 1_000, "intent-old", CAP);
    await store.commit("old");

    expect(await store.spentInWindow(60_999)).toBe(25n);
    expect(await store.spentInWindow(61_000)).toBe(0n);
  });

  it("rejects duplicate reservation ids", async () => {
    const store = new MemoryWindowStore(60);
    await store.reserve("same", 10n, 1_000, "intent-same", CAP);

    await expect(
      store.reserve("same", 10n, 1_001, "intent-same", CAP),
    ).rejects.toThrow("Duplicate reservation id");
  });

  it("rejects non-positive reservations and invalid windows", async () => {
    // The constructor stays synchronous: nothing about validating an argument
    // needs to reach a database.
    expect(() => new MemoryWindowStore(0)).toThrow("Invalid windowSeconds");
    const store = new MemoryWindowStore(60);
    await expect(store.reserve("zero", 0n, 1_000, "intent-zero", CAP)).rejects.toThrow(
      "Reservation units must be positive",
    );
  });

  it("requires a reservation before commit", async () => {
    const store = new MemoryWindowStore(60);

    await expect(store.commit("missing")).rejects.toThrow("Unknown reservation id");
  });
});

describe("the store, not the caller, enforces the cap", () => {
  /**
   * `Payer.pay` evaluates the window before consulting an approver, but that
   * check is advisory — it can be seconds stale, and against a shared store
   * another replica may have spent the budget in between. These pin the store's
   * own verdict, which is the one that actually binds.
   */
  it("refuses a reservation that would cross the cap, and reports what it holds", async () => {
    const store = new MemoryWindowStore(60);
    await store.reserve("first", 80n, 1_000, "intent-first", 100n);

    const outcome = await store.reserve("second", 30n, 1_001, "intent-second", 100n);

    expect(outcome).toEqual({ accepted: false, spentUnits: 80n });
    // A refused reservation must leave nothing behind.
    expect(await store.spentInWindow(1_002)).toBe(80n);
  });

  it("admits a reservation that lands exactly on the cap", async () => {
    const store = new MemoryWindowStore(60);
    await store.reserve("first", 80n, 1_000, "intent-first", 100n);

    expect(await store.reserve("second", 20n, 1_001, "intent-second", 100n)).toEqual({
      accepted: true,
    });
    expect(await store.spentInWindow(1_002)).toBe(100n);
  });

  it("counts an indeterminate debit against the cap forever", async () => {
    const store = new MemoryWindowStore(60);
    await store.reserve("gone", 80n, 1_000, "intent-gone", 100n);
    await store.markIndeterminate("gone");

    // Long past the window. An uncertain spend must not quietly free budget.
    const outcome = await store.reserve("later", 30n, 999_000, "intent-later", 100n);

    expect(outcome).toEqual({ accepted: false, spentUnits: 80n });
  });
});
