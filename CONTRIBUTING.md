# Contributing

Thanks for looking. This is testnet-oriented teaching software that sits on a
payment-authorization path, so the rules below are mostly about one thing: making
sure a change cannot quietly widen what the kit is willing to authorize.

## Before you open a pull request

**If it is a security issue, do not open a pull request.** Use the
[private advisory form](https://github.com/CodeStrux/x402-stellar-kit/security/advisories/new),
or email `aaj@codestrux.tech`. A public patch that describes an authorization
defect ships the exploit before the fix reaches anyone. See [SECURITY.md](./SECURITY.md).

## Getting set up

```bash
npm ci --ignore-scripts     # matches .npmrc and CI; a dependency must not run
                            # code just because it was installed
npm run verify              # build, type-check, tests, both scans, pack
```

Node 22 or newer (`.nvmrc`). `npm test` is offline by construction — `test/setup.ts`
replaces global `fetch` with a throw — so it needs no keys, no network and no
configuration. `npm run demo` is the same: it runs the whole refusal sequence with
nothing provisioned.

`npm run test:live` settles real transactions on Stellar **testnet**. It generates
throwaway keypairs and funds them with friendbot, so it needs network but no
secrets. It is not part of `npm run verify` and does not run on pull requests; CI
runs it on a weekly schedule.

Enable the pre-commit secret scan once per clone:

```bash
git config core.hooksPath .githooks
```

## The one invariant

An agent may **request** a payment; it can never **authorize** one. Deterministic
policy runs before any approver, and an approver can only narrow an
`approval_required` decision — it cannot turn a denial into permission.

The approval challenge is `intentHash`: SHA-256 over seven fields — network,
scheme, asset, payee, amount, resource URL, timeout. Anything outside those seven
fields is not authorized, which is why only bodyless `GET` resources are payable.

**A denial is a correct outcome, not a bug to route around.** If a change makes a
previously denied payment succeed, that is the change, and it needs to be argued
as such. Never widen a limit, switch a recipient, asset or network, split a
payment, or retry around a denial to make a test pass.

## If your change touches the money path

The money path is intent binding, the policy engine, the signer, binding
verification, the rolling spend window, and the `Approver`, `Facilitator`,
`Signer` and `WindowStore` seams.

Write the test first, and **prove it bites**: revert your fix and watch the test
fail. A test that would have passed anyway is worse than no test, because it
reads like coverage. This is not a style preference — a control in this repository
was once silently broken for exactly that reason.

No new runtime dependency. `dependencies` is exactly `@stellar/stellar-base` and
`zod`, both exact-pinned with no `^` or `~`, and README explains why. A third one
is a decision to raise in an issue first, not a detail to slip into a diff.

## How changes land

`main` is protected. Pull requests only, squash merge only, and CI's `verify` job
must be green.

**Commits on `main` must be signed.** GitHub shows unsigned commits as unverified
and the branch rule refuses them. SSH signing is the least friction:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

then add that same public key to your GitHub account a second time, as a
**signing key** (Settings → SSH and GPG keys → New SSH key → key type: *Signing
Key*). An authentication key is not automatically a signing key.

If your fork's commits are unsigned, say so in the pull request — a maintainer can
squash and sign it on merge. Do not force-push a rewritten history to fix it
unless asked; it invalidates review comments.

### One rule about CI that is easy to break by accident

The job id `verify` in `.github/workflows/ci.yml` is a **required status check**.
Renaming it, giving it a job-level `name:`, adding a build matrix (which makes the
check `verify (22)`), or adding `paths:` filters all rename the check context and
make the branch rule permanently unsatisfiable — including for the pull request
that would fix it. If the job genuinely has to be split, add an `if: always()`
aggregator job and re-point the ruleset in the same change.

## For maintainers

Repository admins can bypass the branch rules. That exists for exactly two cases:

1. **Merging an external fork's pull request.** GitHub will not let you squash-merge
   someone else's pull request into a branch that requires signed commits.
2. **Force-pushing to remove a leaked secret**, which `non_fast_forward` otherwise
   forbids.

Anything else goes through a pull request like everyone's.

## Style

There is no linter, deliberately. ESLint and its plugin ecosystem would pull well
over a hundred transitive development dependencies into a package whose entire
argument is a two-dependency surface, and lint plugins are a known supply-chain
vector. `tsc --strict` via `npm run typecheck` covers the errors that matter;
`.editorconfig` and `.gitattributes` cover the whitespace. Match the surrounding
code and you will be fine.

Comments should explain why something is the way it is, especially when it looks
wrong. The interesting comments in this repository are the ones recording a
decision someone would otherwise undo.

## Licence

Apache-2.0. By contributing you agree your contribution is licensed under it.
