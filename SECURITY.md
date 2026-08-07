# Security policy

## What this software is

`x402-stellar-kit` is **testnet-oriented teaching software**, not a production custody system. It is
built so a developer — or a coding agent — can read it and understand how x402 payments work on
Stellar. Anyone pointing it at pubnet owns their own key management, shared-budget implementation,
operational controls, and limits.

That framing is not a disclaimer for defects. The kit sits on a payment authorization path, and a
flaw there can cost someone real money the moment they move past testnet. Reports are welcome.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `0.1.0` | **No** — deprecated for payment-authorization defects. Upgrade to `0.2.0`. |

## Reporting a vulnerability

Email **aaj@codestrux.tech** with:

- what an attacker gains, concretely — a wrong recipient, an unbounded authorization, a double
  payment, a drained budget;
- the smallest reproduction you have, ideally a failing test;
- the version or commit you looked at.

Please **do not open a public issue first** for anything that lets a payment be authorized, redirected,
duplicated, or repudiated. Everything else — a crash, a typing bug, a documentation error — is fine in
the open tracker.

Expect an acknowledgement within **3 working days** and an assessment within **10**. If a report is
valid you will be credited in the changelog unless you would rather not be.

## What is in scope

The money path, and the seams around it:

- intent binding and `intentHash` — the seven fields an approval actually covers;
- the deterministic policy engine and its denial codes;
- signed-transaction verification (`verifyStellarBinding`) before transmission;
- the rolling spend window, including indeterminate reservations;
- the `Approver`, `Signer`, `Facilitator` and `WindowStore` seams, and anything that lets one of them
  exceed the authority its contract describes;
- the MCP surface — in particular any way a tool leaks key material or approval evidence, or reports
  an outcome that invites an agent to retry a payment that may already have settled.

## What is not

- The absence of production custody, rate limiting, or key rotation. Those are deliberately the
  adopter's, and are documented as such in [AGENTS.md](./AGENTS.md).
- `MockFacilitator`, `MockSigner`, `AutoApprover`, and `MemoryWindowStore` used outside the contexts
  their documentation restricts them to.
- Testnet keys, friendbot funding, and anything in `fixtures/`, which is public ledger data.
