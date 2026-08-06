# Agent Surface Design

## Scope

This brief exposes the existing, verified x402 payment behavior to web frameworks, examples, coding agents, and MCP clients. It does not change intent fields, policy order, approval semantics, signing, binding verification, settlement, or the existing fixtures and security tooling. The public package keeps exactly two runtime dependencies.

## Adapter architecture

Each adapter accepts the existing `ResourceServerOptions`, creates one `createResourceServer(config)` instance, and translates framework request/response shapes around `handle()`. A challenge or rejection stops the framework chain. A paid result allows the protected handler to run exactly once and adds the core `PAYMENT-RESPONSE` header without replacing the application's status, body, or unrelated headers.

- `x402Hono(config)` returns structural Hono middleware.
- `x402Express(config)` returns structural Express middleware and forwards thrown failures to `next(error)`.
- `x402Next(config)` returns a curried App Router wrapper: `x402Next(config)(handler)`.

The adapters are available only through `./server/hono`, `./server/express`, and `./server/next` package exports. They are not added to the package root. Framework packages are exact-pinned development dependencies only.

## Examples

`charge-my-api` defines a Hono app with one free route and exactly one paid GET route. It uses the mock facilitator and an in-process request in its executable path, so it terminates offline and demonstrates the 402 challenge without credentials.

`pay-an-endpoint` builds an offline resource bridge, a `Payer`, and a complete explicit `PolicyConfig`. It uses `PromptApprover` only on an interactive TTY and `AutoApprover` for the unattended runnable path, then prints only the intent hash and deterministic mock transaction hash. Both examples are executable files and are also launched as child processes by the offline test suite.

## MCP architecture and trust boundary

The MCP entry point is a separate package export. Its constructor receives payer inputs once, clones and freezes policy lists, selects or creates one `WindowStore`, and constructs one `Payer` over those exact objects. No tool receives a policy mutation operation, signer accessor, seed accessor, or approval-evidence accessor.

The server exposes three tools:

1. `x402_render_payment_intent` probes a URL, chooses the same first allowed-network offer as `Payer.pay`, renders the seven-field `PaymentIntent`, and computes its approval hash. It never signs, transmits a payment signature, or settles.
2. `x402_paid_fetch` accepts only `url`. The raw MCP arguments are inspected before normal validation so any supplied method or body receives an explicit error explaining that method/body are not bound by `intentHash`. The actual request path is always the existing GET-only `Payer.pay` flow.
3. `x402_budget_status` reads the retained window store and returns the cap, current debit, non-negative remaining units, and indeterminate reservations.

Tool results serialize bigint values as decimal strings and select safe fields explicitly. They never serialize a signer, key, seed, signed transaction, payment signature, or approver evidence. Policy, approval, and binding denials return `isError: false` with a structured `{ outcome: "denied", code, reason }` result. Operational and invalid-argument failures remain MCP errors. Diagnostics use only an injected stderr-shaped writer, defaulting to `process.stderr`.

The SDK is loaded lazily only when the MCP entry point is used. A missing SDK throws one actionable sentence containing `npm install @modelcontextprotocol/sdk`. It is declared as an optional peer and exact-pinned only as a development dependency.

## GET-only safety property

`PaymentIntent` binds network, scheme, asset, payee, amount, resource URL, and timeout. It does not bind an HTTP method or request body. Therefore the packaged payer and MCP surface authorize only GET resources and refuse to imply authorization for a method or body that the approval hash cannot cover. Binding those fields is a payment-model change and is outside this brief.

## Documentation and skill

`AGENTS.md` is the operational source of truth for coding agents: invariant, seams, copy-paste recipes, all denial codes, binding drift, indeterminate outcomes, testing, and GET-only limitation. `CLAUDE.md` delegates to it with one line. `README.md` teaches the three demo rungs, protocol flow, server and payer entry paths, safety model, dependency posture, fixtures, agent guidance, and testnet warning. `skill/SKILL.md` condenses the invariant, tool flow, denial handling, and stop rules into fewer than 80 lines.

## Verification strategy

Adapter tests exercise real Hono and Express applications plus a Web-standard Next wrapper, first asserting a decodable 402 challenge and then a paid pass-through. Example tests execute both compiled examples offline. MCP tests use the SDK's linked in-memory transports, count signing/settlement side effects, verify structured denials, exercise forbidden method/body arguments, and recursively scan results for secret-like or approval-evidence fields. Documentation tests extract every fenced TypeScript/JavaScript block and run the TypeScript checker against repository source mappings.

The final gates are the exact commands in Brief 03, including clean installation, build, all offline tests, offline demo, dependency assertions, exact-version scan, secret scan, and package dry run.
