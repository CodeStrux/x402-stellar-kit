# Changelog

This project follows semantic versioning for `0.x`: a breaking change bumps the **minor**.

> Sections are titled `## Unreleased` until the version is cut. `npm version minor` performs the
> bump, so a published tree never carries a changelog naming a version its own manifest does not.

## Unreleased

### Security

- `scripts/verify-pack.sh` packs the package, extracts the tarball, and scans the
  extracted contents. `dist/` is gitignored and shipped via `files`, and
  `secret-scan.sh` excluded it, so 68 of the 88 published files had never been read
  by any control in this repository. Also asserts every advertised entry point is
  present and diffs the packed file list against `scripts/packed-files.txt`.
- `scripts/secret-scan.sh` streams file content to `grep` instead of holding it in a
  shell variable. `content="$(cat file)"` cannot survive a NUL byte; bash drops it,
  and dropping it deletes the byte acting as a word boundary, so `x\0S…` becomes
  `xS…` and every `\b`-anchored pattern stops matching. Measured on bash 5.3: the
  same file and pattern report clean through the variable and hit through the stream.
- `scripts/secret-scan.sh --path DIR` scans a directory outside git's view.

### Changed

- CI pins actions to commit SHAs, drops the checkout credentials, and gains a
  timeout, job-level permissions and concurrency. SHA pinning is enforced repository-wide.
- `npm run verify` now includes `verify:pack`.

### Added

- `.github/workflows/release.yml` stages a provenanced release over OIDC. It cannot
  publish; a maintainer promotes the staged tarball with 2FA.
- `.github/workflows/live.yml` runs the testnet suite weekly — the only control that
  would notice Stellar changing underneath the library.
- `.github/workflows/dependency-review.yml` on pull requests, advisory.
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, CODEOWNERS, issue and pull-request templates,
  Dependabot, `.gitattributes`, `.editorconfig`, `.nvmrc`.

## 0.2.0

Ten defects found by a security review of the initial release. `0.1.0` is deprecated: it is live on
npm with payment-authorization defects, and this is the release that retires it.

### Breaking

- **`ResourceResult` no longer has a `paid` variant.** `handle()` now returns `verified` carrying a
  single-use, memoised `settle()`. Settling before the application handler runs charges the payer for
  a response they never receive — and on their side a settled-but-failed request becomes a
  non-expiring indeterminate debit a human has to reconcile by hand.

  ```ts
  // before
  const result = await server.handle(request);
  if (result.kind === "paid") return respond(200, body, result.headers);

  // after — serve first, settle only once the handler has produced the thing paid for
  const result = await server.handle(request);
  if (result.kind === "verified") {
    const body = await produceTheResource();
    const settled = await result.settle();
    if (settled.kind === "rejected") return respond(settled.status, settled.reason);
    return respond(settled.status, body, settled.headers);
  }
  ```

  All three bundled adapters already do this. The Express adapter intercepts `end`, because Express
  hands the response to the application rather than back to the middleware.

- **`WindowStore` is asynchronous, and `reserve` now decides.** Every method returns a `Promise`, and
  `reserve` takes the cap and returns `{ accepted }`.

  AGENTS.md has always told production adopters to supply "one durable, shared, atomic store". None
  of Postgres, Redis, or anything else with a network in front of it is reachable from a synchronous
  signature — the kit mandated something its own interface forbade. Async alone was not enough:
  `pay()` read the window, consulted an approver, and only then reserved. Against a shared store two
  replicas both pass that check and both reserve, so the real ceiling becomes cap × replicas.

  ```ts
  // before
  interface WindowStore {
    spentInWindow(now: number): bigint;
    reserve(id: string, units: bigint, now: number, intentHash: string): void;
    commit(id: string): void;
    // …
  }

  // after
  interface WindowStore {
    spentInWindow(now: number): Promise<bigint>;
    reserve(
      id: string, units: bigint, now: number, intentHash: string, capUnits: bigint,
    ): Promise<{ accepted: true } | { accepted: false; spentUnits: bigint }>;
    commit(id: string): Promise<void>;
    // …
  }
  ```

  **Your implementation must make `reserve` atomic** — one statement, one transaction, or a lock. A
  read followed by a write reopens the race this signature exists to close, and no single-process
  test can tell the difference. `Payer` and the adapters keep their existing signatures; only the
  store changes.

- **`PaymentRequired["accepts"]` widens** to include offers on schemes this kit cannot pay. Narrow
  with the exported `isExactOffer`, or use `selectPayableRequirement`, before building an intent.
  Type-level only — no runtime behaviour changes for a single-scheme challenge.

### Security

- **`assertInvocation` now binds ScVal *types*, not only decoded values.** `scValToNative` flattens
  `scvString`/`scvSymbol`/`scvAddress` to one string and eight integer widths to one `bigint`, so a
  `transfer` carrying an `scvString` "address" or an `scvU128` amount matched the approved intent on
  every field, was signed, and was transmitted — to be refused on-chain *after* the payer already
  carried a non-expiring debit. A hostile signer could freeze a payer's budget without spending a
  stroop.
- **`LocalFacilitator` serializes settlements.** Two concurrent settlements read the same fee-source
  sequence from Horizon and both built the same transaction; the loser got `tx_bad_seq` — and that
  loser's payer had already transmitted their signature. One instance now settles one payment at a
  time, so throughput is bounded by ledger close. Two instances sharing a `sourceKeypair` still
  collide: give each its own fee source.
- **The MCP server reports a transmitted payment instead of hiding it.** A payment that had left the
  process surfaced as a generic `InternalError` — the shape that invites a retry, and a retry after
  transmission pays twice. `x402_paid_fetch` now returns `outcome: "indeterminate"` with
  `transmitted: true` and the `intentHash`, and says plainly not to retry. Only that tool can report
  it, because only it can transmit.
- **A mixed-scheme 402 no longer discards a payable offer.** `accepts` failed whole if any entry was
  not `exact`, so a challenge advertising another rail beside a perfectly payable one was rejected as
  malformed wire data. `POL-SCHEME` — documented all along — was unreachable through the real payment
  path; it now fires. The encode path stays strict: a resource server built on this kit still cannot
  advertise a scheme it could not settle.
- **The payment timeout has a floor of 10 seconds and must be whole seconds.** The check was
  `> 0`, so a hostile server advertising a two-second timeout got a payment signed with time bounds
  already close to expired: it could never settle, yet the payer transmitted it and the reservation
  became a permanent debit. Repeat that and the rolling budget drains without a payment ever landing.
  The floor is enforced in the policy engine *and* in `authorizationWindowLedgers`, because `Signer`
  is a seam an adopter can drive directly.

### Fixed

- **The Express adapter can be told to trust `X-Forwarded-Proto`.** Behind any TLS terminator the
  origin sees plain HTTP, so the reconstructed URL said `http://` while the configured resource said
  `https://`, and every paid request was refused. Pass `trustForwardedProto: true`. It is off by
  default because the header is set by whoever is talking to the process, and Express already honours
  it under `trust proxy`. A resource-URL mismatch now names both URLs and the likely cause instead of
  saying only "Resource URL mismatch". Hono and Next were never affected.

### Packaging

- **`scripts/verify-dist.sh`** refuses a stale or incomplete `dist/`, checking freshness rather than
  mere existence, and resolving every entry point in `exports`. `prepublishOnly` runs it too — but as
  defence in depth only: this repo's `.npmrc` sets `ignore-scripts=true`, which npm applies to its own
  lifecycle scripts, so `npm publish` run here would skip it. `npm run verify` is the gate that
  actually holds.
- **`npm run typecheck`** type-checks `test/` for the first time. `tsconfig.json` covers only `src/`,
  `mcp/` and `examples/`, so a type error in a test was invisible to `npm run build` — and the async
  `WindowStore` change is exactly the kind whose entire risk surface is test code. It found several
  pre-existing errors, now fixed.
- Added `SECURITY.md`, this changelog, and a CI workflow running build, typecheck, tests, the secret
  scan and the dist check on every push and pull request.

## 0.1.0

Initial release. **Deprecated** — payment-authorization defects, fixed in `0.2.0`.
