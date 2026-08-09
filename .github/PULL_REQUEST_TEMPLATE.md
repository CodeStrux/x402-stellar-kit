<!--
Security fix? Stop. Use the private advisory form instead:
https://github.com/CodeStrux/x402-stellar-kit/security/advisories/new
A public pull request describing an authorization defect ships the exploit
before the fix.
-->

## What this changes, and why

<!-- The behaviour before, the behaviour after. If it fixes an issue, link it. -->

## Checks

- [ ] `npm run verify` passes locally (build, type-check, tests, both scans, pack).
- [ ] Commits are signed. `main` requires it — see CONTRIBUTING.md.

## If this touches the money path

The money path is intent binding, the policy engine, the signer, binding
verification, the rolling window, and the `Approver` / `Facilitator` / `Signer` /
`WindowStore` seams. If none of that moved, delete this section.

- [ ] There is a test that **fails without the change** and passes with it. Not a
      test that would have passed anyway.
- [ ] No policy limit was widened, no denial code was removed or downgraded, and
      nothing retries around a denial. A denial is a correct outcome.
- [ ] The seven fields `intentHash` binds are unchanged, or the change is
      explained here as a payment-model change rather than an adapter fix.
- [ ] No new runtime dependency. `dependencies` is exactly `@stellar/stellar-base`
      and `zod`, exact-pinned; adding a third is a decision, not a detail.

## Notes for the reviewer

<!-- What you are least sure about. What you would look at first if this broke. -->
