# Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the verified x402 kit usable from common API frameworks and safe coding-agent surfaces without changing payment behavior.

**Architecture:** Thin framework adapters wrap the existing resource server, offline examples exercise the existing mock path, and a separate lazy-loaded MCP entry point owns an immutable payer/policy/window tuple. Documentation is executable through fenced-block type checks, while package subpaths keep optional integrations away from the root import graph.

**Tech Stack:** TypeScript 5.9, Node.js 22 ESM, Vitest, Hono, Express, Next.js structural route handlers, MCP TypeScript SDK, Zod, Stellar base primitives.

## Global Constraints

- Do not modify any existing payment behavior, signature, policy order, or policy meaning.
- Treat `fixtures/x402/**`, its README, secret scanning files, hooks, and ignore rules as read-only.
- Runtime `dependencies` remain exactly `@stellar/stellar-base` and `zod`, with exact versions.
- Declare `@modelcontextprotocol/sdk` as peer `>=1.0.0` and mark it optional.
- Keep every package.json development version exact and use no `^` or `~` prefixes.
- Do not add private infrastructure strings, credential paths, internal product names, or any Stellar secret key.
- MCP stdout is JSON-RPC only; diagnostics go to stderr.
- MCP policy is fixed at process construction and tools cannot return key material or approval evidence.
- MCP paid fetch is GET-only and rejects method/body arguments with the intent-binding reason.
- Make no Git commits.

---

### Task 1: Package scaffolding and framework adapters

**Files:**
- Create: `src/server/adapters/hono.ts`
- Create: `src/server/adapters/express.ts`
- Create: `src/server/adapters/next.ts`
- Create: `test/adapters/hono.test.ts`
- Create: `test/adapters/express.test.ts`
- Create: `test/adapters/next.test.ts`
- Create: `test/adapters/helpers.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `createResourceServer(options: ResourceServerOptions)` and `ResourceResult`.
- Produces: `x402Hono(config)`, `x402Express(config)`, and `x402Next(config)(handler)` through isolated server subpaths.

- [ ] **Step 1: Install exact development-only framework and type packages and add the three conditional package exports.**

  Use the package manager with exact versions. Add `./server/hono`, `./server/express`, and `./server/next` mappings to `dist/src/server/adapters/*.js` and matching declarations. Do not add adapter barrels to `src/index.ts`.

- [ ] **Step 2: Write adapter tests that fail because the subpath modules do not exist.**

  Each test constructs one mock facilitator/config, obtains an unauthenticated 402, decodes `PAYMENT-REQUIRED`, signs the derived intent with `MockSigner`, retries with `PAYMENT-SIGNATURE`, and asserts the protected handler ran once with a `PAYMENT-RESPONSE` header.

- [ ] **Step 3: Run the focused adapter tests and confirm missing-module failures.**

  Run: `npx vitest run test/adapters`

  Expected: failure resolving one or more `src/server/adapters/*.js` modules.

- [ ] **Step 4: Implement minimal structural adapters.**

  Map Hono from `context.req.raw`, Express from method/protocol/host/originalUrl/headers, and Next from Web `Request`. Return plain-text challenge/rejection responses. On paid results, continue to the protected handler and propagate the core settlement response header.

- [ ] **Step 5: Run adapter tests and the existing resource-server tests.**

  Run: `npx vitest run test/adapters test/facilitator.server.test.ts test/payer.offline.test.ts`

  Expected: all pass with no changed core assertions.

### Task 2: Offline charging and paying examples

**Files:**
- Create: `examples/charge-my-api/index.ts`
- Create: `examples/pay-an-endpoint/index.ts`
- Create: `test/examples.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: server Hono subpath, `Payer`, `PolicyConfig`, `MockFacilitator`, `MockSigner`, `AutoApprover`, and `PromptApprover`.
- Produces: `npm run example:charge` and `npm run example:pay`, both finite offline commands.

- [ ] **Step 1: Write a child-process test that expects both new compiled examples to exit zero and print their identifying result.**

  The charging assertion looks for a 402 demonstration. The paying assertion looks for a 64-hex-character intent hash and transaction hash. Child processes receive no task-specific environment variables and have a finite timeout.

- [ ] **Step 2: Run the example test and confirm both compiled entry points are missing.**

  Run: `npm run build && npx vitest run test/examples.test.ts`

  Expected: non-zero child exit because `dist/examples/charge-my-api/index.js` and `dist/examples/pay-an-endpoint/index.js` do not exist.

- [ ] **Step 3: Implement the minimal Hono charging example.**

  Define one free GET route and exactly one paid GET route. Mount `x402Hono(config)` only on the paid GET route, use `MockFacilitator`, issue an in-process request to the paid path in the executable flow, print its 402 status, and exit.

- [ ] **Step 4: Implement the offline payer example with explicit limits.**

  Build an in-memory Fetch bridge to `createResourceServer`, credit a mock payer, declare all nine `PolicyConfig` fields, select `PromptApprover` for a TTY and `AutoApprover` otherwise, execute `payer.pay(url)`, and print only `intentHash` and `settlement.transaction`.

- [ ] **Step 5: Run the build and focused example test.**

  Run: `npm run build && npx vitest run test/examples.test.ts`

  Expected: both examples exit zero offline.

### Task 3: Optional-peer MCP server

**Files:**
- Create: `mcp/server.ts`
- Create: `test/mcp/server.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: `PayerOptions`, `PolicyConfig`, `WindowStore`, `paymentIntentFromRequirement`, `intentHash`, and SDK server/transports.
- Produces: `createX402McpServer(options)` and `serveX402McpStdio(options)` from the `./mcp` package subpath; tools named exactly as specified in Brief 03.

- [ ] **Step 1: Install an exact development SDK version while declaring peer compatibility and optionality exactly as required.**

  Add `mcp/**/*.ts` to the TypeScript include list and map `./mcp` to `dist/mcp/server.{js,d.ts}`. The root export must not import this module.

- [ ] **Step 2: Write in-memory transport tests before the server exists.**

  Connect a real SDK client and linked transport pair. Assert render returns the seven-field intent/hash while signer and facilitator settlement counters stay zero; a `POL-MAX` payment returns `{ outcome: "denied", code: "POL-MAX" }` without an MCP thrown error; forbidden method/body arguments explain missing intent binding; budget status includes indeterminate rows; and recursive response scanning finds no seed/key/signature/transaction-payload/approval-evidence fields.

- [ ] **Step 3: Run the focused MCP test and confirm module resolution fails.**

  Run: `npx vitest run test/mcp/server.test.ts`

  Expected: failure resolving `mcp/server.js`.

- [ ] **Step 4: Implement immutable construction and safe result serializers.**

  Clone policy lists, create or retain one window, and pass those objects into one `Payer`. Render selects the first offered allowed network, derives and hashes the intent, and returns decimal strings for bigint values. Budget status computes `remainingUnits = max(0, cap - spent)` and maps indeterminate entries explicitly.

- [ ] **Step 5: Implement low-level tool registration and denial handling.**

  Publish exact input schemas with only `url`. Before URL validation, inspect raw arguments for method/body keys and throw a clear invalid-parameters MCP error that states those fields are not authorized because `intentHash` does not bind them. Catch `PolicyDenied`, `ApprovalDenied`, and `BindingDrift` into successful structured denial results; do not catch them as transport errors or retry.

- [ ] **Step 6: Implement lazy SDK loading and stdio startup.**

  Dynamically import the SDK only inside MCP construction/startup. Convert only a genuine module-not-found failure for the SDK specifier into: `MCP support requires @modelcontextprotocol/sdk; install it with npm install @modelcontextprotocol/sdk.` Connect stdio without writing diagnostics to stdout.

- [ ] **Step 7: Run MCP tests, build, and a root-import smoke test.**

  Run: `npx vitest run test/mcp/server.test.ts && npm run build && node -e 'import("./dist/src/index.js")'`

  Expected: all pass and the root import never loads the MCP SDK.

### Task 4: Agent and human documentation

**Files:**
- Create: `AGENTS.md`
- Create: `CLAUDE.md`
- Create: `README.md`
- Create: `skill/SKILL.md`
- Create: `test/docs.test.ts`

**Interfaces:**
- Consumes: every public type and package subpath introduced by Tasks 1-3.
- Produces: compile-checked copy/paste guidance and a triggerable packaged skill under 80 lines.

- [ ] **Step 1: Write the documentation compiler test before adding documentation.**

  Extract every fenced `ts`, `typescript`, `js`, and `javascript` block from README and AGENTS. For each block, invoke the TypeScript compiler API with strict NodeNext settings and source path mappings for the package root and all subpaths. Format diagnostics with the document name and fence index.

- [ ] **Step 2: Run the focused docs test and confirm missing-document failures.**

  Run: `npx vitest run test/docs.test.ts`

  Expected: failure reading `README.md` or `AGENTS.md`.

- [ ] **Step 3: Write AGENTS and the one-line compatibility file.**

  Include the three-sentence package definition, authorization invariant, production seams, both copy/paste recipes, every `PolicyCode` with response, binding drift, indeterminate reservations, offline/live test commands, and GET-only safety limitation. Set `CLAUDE.md` content exactly to `@AGENTS.md` plus its final newline.

- [ ] **Step 4: Write the packaged skill.**

  Use frontmatter name/description that includes “pay for”, “paid endpoint”, “402”, and “x402”. Keep the file under 80 lines and include the invariant, three-tool table, normal flow, complete denial table, human-approval stop rule, immutable-policy rule, secret/evidence rule, and GET-only binding rule.

- [ ] **Step 5: Write README with compilable examples.**

  Lead with the three demo commands verbatim. Add the protocol paragraph/diagram, before-and-after Hono diff, payer recipe, safety stages with binding-check rationale, optional-peer/dependency posture, fixture and AGENTS pointers, known limitation, testnet warning, and Apache-2.0 statement.

- [ ] **Step 6: Run documentation type checks, build, and line-count checks.**

  Run: `npx vitest run test/docs.test.ts && npm run build && test "$(wc -l < skill/SKILL.md)" -lt 80`

  Expected: all fenced code compiles and the skill is below 80 lines.

### Task 5: Security review and full verification

**Files:**
- Review: all files changed by Tasks 1-4
- Modify only when an in-scope verified finding requires remediation.

**Interfaces:**
- Consumes: final working-tree diff and all exact verification commands.
- Produces: no material security findings and a fully verified package surface.

- [ ] **Step 1: Review trust boundaries and reachable attack paths.**

  Trace URL/headers/MCP arguments through origin policy, signing, binding verification, settlement, output serialization, and stderr/stdout handling. Check SSRF, method/body authority confusion, secret/evidence exposure, policy mutation, header spoofing, dependency isolation, error serialization, and indeterminate-budget behavior.

- [ ] **Step 2: Run an independent read-only security reviewer and validate every reported path locally.**

  Fix only high-confidence in-scope findings; any fix requiring a payment-model behavior change must be reported instead of implemented.

- [ ] **Step 3: Run the exact clean verification sequence.**

  Run each command from Brief 03 separately: clean install, build, offline tests, offline demo, runtime dependency equality, optional-peer assertion, package-version-prefix scan, secret scan, and package dry run.

- [ ] **Step 4: Inspect final status and diff without staging or committing.**

  Confirm read-only paths have no task-authored changes and report delivered surfaces, verification evidence, and any remaining limitation.
