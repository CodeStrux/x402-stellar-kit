export type IndeterminateReservation = Readonly<{
  id: string;
  units: bigint;
  reservedAt: number;
  intentHash: string;
}>;

export interface WindowStore {
  spentInWindow(now: number): bigint;
  reserve(id: string, units: bigint, now: number, intentHash: string): void;
  commit(id: string): void;
  markIndeterminate(id: string): void;
  listIndeterminate(now: number): readonly IndeterminateReservation[];
  release(id: string): void;
}

type WindowEntry = {
  readonly units: bigint;
  readonly reservedAt: number;
  readonly intentHash: string;
  state: "reserved" | "committed" | "indeterminate";
};

/**
 * In-process only. A deployment with multiple payers sharing one budget must
 * use a shared WindowStore; otherwise every process enforces a private copy of
 * the cap and silently multiplies the real ceiling by the replica count.
 */
export class MemoryWindowStore implements WindowStore {
  readonly #windowMilliseconds: number;
  readonly #entries = new Map<string, WindowEntry>();

  constructor(windowSeconds: number) {
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new TypeError("Invalid windowSeconds");
    }
    this.#windowMilliseconds = windowSeconds * 1_000;
  }

  #expire(now: number): void {
    for (const [id, entry] of this.#entries) {
      if (
        entry.state !== "indeterminate" &&
        now - entry.reservedAt >= this.#windowMilliseconds
      ) {
        this.#entries.delete(id);
      }
    }
  }

  spentInWindow(now: number): bigint {
    this.#expire(now);
    let total = 0n;
    for (const entry of this.#entries.values()) {
      total += entry.units;
    }
    return total;
  }

  reserve(
    id: string,
    units: bigint,
    now: number,
    intentHash: string,
  ): void {
    if (units <= 0n) {
      throw new RangeError("Reservation units must be positive");
    }
    this.#expire(now);
    if (this.#entries.has(id)) {
      throw new Error("Duplicate reservation id");
    }
    this.#entries.set(id, {
      units,
      reservedAt: now,
      intentHash,
      state: "reserved",
    });
  }

  commit(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new Error("Unknown reservation id");
    }
    entry.state = "committed";
  }

  /**
   * Indeterminate reservations deliberately never age out. They remain a
   * conservative standing debit until a human or reconciler resolves them;
   * expiring them would silently re-open the budget after an uncertain spend.
   */
  markIndeterminate(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new Error("Unknown reservation id");
    }
    entry.state = "indeterminate";
  }

  listIndeterminate(now: number): readonly IndeterminateReservation[] {
    this.#expire(now);
    const reservations: IndeterminateReservation[] = [];
    for (const [id, entry] of this.#entries) {
      if (entry.state === "indeterminate") {
        reservations.push(
          Object.freeze({
            id,
            units: entry.units,
            reservedAt: entry.reservedAt,
            intentHash: entry.intentHash,
          }),
        );
      }
    }
    return Object.freeze(reservations);
  }

  release(id: string): void {
    this.#entries.delete(id);
  }
}
