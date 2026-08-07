export type IndeterminateReservation = Readonly<{
  id: string;
  units: bigint;
  reservedAt: number;
  intentHash: string;
}>;

export type ReserveOutcome =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; spentUnits: bigint }>;

/**
 * The rolling spend window.
 *
 * Every method is asynchronous, and that is not ceremony. The only correct
 * store for a deployment with more than one payer sharing a budget is a durable
 * shared one — Postgres, Redis, something with a network in front of it — and
 * none of those can be reached from a synchronous signature. A synchronous
 * interface silently restricted every adopter to the in-process default while
 * the documentation told them to replace it.
 *
 * `reserve` decides, rather than merely recording. `Payer.pay` still evaluates
 * the window before consulting an approver, so a doomed payment is refused
 * before a human is interrupted — but that check is advisory, and between it
 * and the reservation another replica may have spent the budget. Only the store
 * can see that. Handing `capUnits` in and taking a verdict back is what lets
 * the check and the reservation be one atomic step; a store that just writes
 * down what it is told turns a shared cap into cap × replicas, which is the
 * exact failure `MemoryWindowStore` warns about below.
 *
 * An implementation must make `reserve` atomic against concurrent callers —
 * one statement, one transaction, or a lock. A read followed by a write reopens
 * the race this signature exists to close, and no test in a single process can
 * tell the difference.
 */
export interface WindowStore {
  spentInWindow(now: number): Promise<bigint>;
  reserve(
    id: string,
    units: bigint,
    now: number,
    intentHash: string,
    capUnits: bigint,
  ): Promise<ReserveOutcome>;
  commit(id: string): Promise<void>;
  markIndeterminate(id: string): Promise<void>;
  listIndeterminate(now: number): Promise<readonly IndeterminateReservation[]>;
  release(id: string): Promise<void>;
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

  #total(now: number): bigint {
    this.#expire(now);
    let total = 0n;
    for (const entry of this.#entries.values()) {
      total += entry.units;
    }
    return total;
  }

  async spentInWindow(now: number): Promise<bigint> {
    return this.#total(now);
  }

  /**
   * Atomic here only because a `Map` cannot be interleaved: nothing awaits
   * between reading the total and writing the entry, so no other caller can run
   * in the gap. A store with a network in front of it has to earn the same
   * property deliberately — one statement, one transaction, or a lock.
   *
   * A refusal is a return value; a malformed call is still a throw. `accepted:
   * false` means the budget said no, which is an ordinary outcome the payer
   * turns into POL-WINDOW. A duplicate id or a non-positive amount is a caller
   * bug, and quietly reporting those as "over budget" would hide it.
   */
  async reserve(
    id: string,
    units: bigint,
    now: number,
    intentHash: string,
    capUnits: bigint,
  ): Promise<ReserveOutcome> {
    if (units <= 0n) {
      throw new RangeError("Reservation units must be positive");
    }
    const spentUnits = this.#total(now);
    if (this.#entries.has(id)) {
      throw new Error("Duplicate reservation id");
    }
    if (spentUnits + units > capUnits) {
      return Object.freeze({ accepted: false as const, spentUnits });
    }
    this.#entries.set(id, {
      units,
      reservedAt: now,
      intentHash,
      state: "reserved",
    });
    return Object.freeze({ accepted: true as const });
  }

  async commit(id: string): Promise<void> {
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
  async markIndeterminate(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new Error("Unknown reservation id");
    }
    entry.state = "indeterminate";
  }

  async listIndeterminate(now: number): Promise<readonly IndeterminateReservation[]> {
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

  async release(id: string): Promise<void> {
    this.#entries.delete(id);
  }
}
