# Security Review Follow-Ups — Approval Freshness Engine

*Disposition record for the three items raised in the security review of the*
*`ruleset-governed-failsafe` branch. Confluence-ready. Full architecture: [SECURITY-REVIEW.md](SECURITY-REVIEW.md), [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).*

## What this document is
The security review raised three items against the fresh-approval / fail-closed design. This
page reproduces each item in its original framing (**Concern / Where it stands / Fix / Decision**),
answers it, states its disposition, and cites the exact evidence — source files and the tests that
prove the behavior. Everything here is verifiable from a clean checkout with `npm test` and
`npx tsc --noEmit`.

| # | Item | Disposition |
|---|------|-------------|
| 1 | Fresh-approval fallback credential custody | **DECISION** — P3 sign-off, org's call (options framed below) |
| 2 | Foreign-author gate must use platform-verified identity | **FIXED** — gate-for-P2 satisfied |
| 3 | Control-surface governance (CODEOWNERS + self-governance) | **FIXED** — gate-for-P2 satisfied |

Items 2 and 3 are code changes that gate the P2 (deterministic-only, live-on-pilots) milestone;
both are implemented and tested. Item 1 is not a defect — it is a deliberate custody decision the
review correctly flagged for an explicit org sign-off, presented here with both options and a
recommendation.

---

## Item 1 — Fresh-approval fallback credential custody

**Concern.** The optional fresh-approval fallback workflow
(`.github/workflows/fresh-approval-fallback.yaml`) runs on GitHub's infrastructure and
authenticates as the engine's GitHub App. To do that it needs the App private key available as an
org-level Actions secret (`AFE_APP_PRIVATE_KEY`). That is a **second custody point** for a
credential that, in the engine's normal runtime, has no human standing access at all. Is that
second copy an acceptable trade for the liveness it buys, and who signs off?

**Where it stands.** The concern is accurate and the trade-off is real. It is not a bug — the
custody split is inherent to running a fallback on infrastructure the engine does not control. The
relevant facts, all already true in the code and deployment surface:

- **Engine-runtime custody (the tight one).** In normal operation the App private key lives in AWS
  Secrets Manager, reached via EKS Pod Identity (`afe-role`), IAM-scoped to the engine pod, with
  **no human standing access**. See [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) §4.2 and
  `deploy/helm/`.
- **Fallback custody (the second point).** Enabling the fallback adds one more place the same key
  lives: the org Actions secret `AFE_APP_PRIVATE_KEY`, scoped to enrolled repos only. Its custodian
  is the org's Actions-secrets administrators, a different (and typically broader) set of people
  than the engine's IAM boundary.
- **Blast radius is bounded by the App's grant, not by where the key sits.** The App holds
  `pull_requests:write`, `checks:write`, `contents:read` — and explicitly **no**
  approve / merge / push / administration / actions / workflows / ruleset scope. The worst thing a
  holder of a leaked key can do is set a check to success or dismiss a review. Both remain **behind
  GitHub's native "≥ 1 approving review" ruleset rule, which the key cannot alter** — there is no
  ruleset-write credential anywhere in the system. A leaked fallback key cannot merge code, cannot
  approve a PR, and cannot weaken the gate it operates under.
- **The workflow is a deterministic echo, not a judgment engine.** It runs with `permissions: {}`,
  has no `workflow_dispatch` and no free-form inputs, mints a short-lived App token, and only ever
  writes the hardcoded literal conclusion `"success"` after a TOCTOU re-verification that a
  platform-verified fresh approval exists on the exact current head SHA. It cannot be coaxed into
  writing anything else.

**The decision (both options, honestly).**

- **Option A — Enable the fallback (accept the second custody point).** Blocked PRs get unblocked
  by a fresh human re-approval *even while the engine pod is down*, on GitHub's own infra, within
  about a minute. Cost: the App private key exists in a second custody domain (org Actions
  secrets), widening the set of people/systems that could in principle exfiltrate it — bounded, as
  above, to "set a check green or dismiss a review, never merge/approve/alter the gate."
- **Option B — Omit the fallback (single custody point, still fail-closed).** The key lives only in
  the engine's Secrets Manager path. During an engine outage, freshly-pushed PRs stay natively
  blocked and wait for the engine to return **or** for an org owner's audited break-glass. This is
  still fully fail-closed and secure; the cost is purely UX/latency during an outage (developers
  cannot self-unblock via re-review until the engine is back).

**Recommendation.** Enable the fallback **with** the mitigations already in place (least-privilege
App grant, `permissions: {}` workflow, hardcoded-literal echo, enrolled-repo-only secret scope,
TOCTOU re-verify). The liveness benefit is material and the residual risk is tightly bounded by the
App's inability to merge, approve, or touch the ruleset. **This is explicitly the org's P3
sign-off call, not an engineering default** — an org with stricter key-custody policy can choose
Option B and lose only outage-window self-service, never security.

**Decision status.** OPEN — **P3 sign-off required from the org.** No code change; the doc and the
runbook (README step 5) make the trade-off explicit at deploy time.

**Evidence.**
- App grant / least privilege: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) §2.1, §4.2;
  README "Implementation Runbook" step 2.
- Runtime custody (no human standing access): [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)
  §4.2; `deploy/helm/`.
- Fallback custody + scope: README "Implementation Runbook" step 5;
  `.github/workflows/fresh-approval-fallback.yaml` (header comment documents the key-custody
  trade-off).
- Echo is a deterministic, verified restatement (no approve path): `src/github/freshApproval.ts`;
  tests `test/fresh_approval.test.ts`, `test/no_approve_path.test.ts`,
  `test/check_conclusion_guard.test.ts`.
- Gate is native and un-writable by any runtime credential:
  [SECURITY-REVIEW.md](SECURITY-REVIEW.md) invariant 7; `deploy/rulesets/enrolled-ruleset.json`.

---

## Item 2 — Foreign-author gate must use platform-verified identity

**Concern.** Stage 0 dismisses any delta containing a commit authored by someone other than the PR
author (the "someone else pushed onto my approved branch" hijack). But the author list was built
with a spoofable fallback:

```ts
commitAuthors: commits.map((c) => c.author?.login ?? c.commit.author?.name ?? "")
```

`c.commit.author.name` is **user-controlled git metadata**. An attacker can run
`git config user.name <pr-author-login>` so that a foreign commit reports the PR author's name in
its git metadata. Whenever GitHub cannot resolve a verified account for that commit (`c.author`
is `null`), the gate would read the attacker-supplied name, conclude the commit is authored by the
PR author, and **preserve a stale approval over an impersonated commit**. Separately, `forcePushed`
was hardcoded `false`, so a history rewrite could slip the same gate.

**Where it stands.** FIXED. The identity contract is now: an author is **only** a
GitHub-resolved account login, or `null`. Attacker-controlled git author name/email is never read
for identity purposes.

**Fix.**
- **Identity is the GitHub-verified login or nothing.** `buildDelta` in `src/github/pr.ts` now maps
  `commits.map((c) => c.author?.login ?? null)` — the spoofable `c.commit.author.name` /
  `.email` fallback is gone, with a security-rationale comment stating why (git author metadata is
  attacker-controlled; only the GitHub-resolved account is identity).
- **`null` is categorically foreign.** `Delta.commitAuthors` is now `(string | null)[]`
  (`src/stages/types.ts`). `null` means "GitHub could not resolve a verified account for this
  commit" and Stage 0 treats it as foreign. The existing rule-2 filter
  (`!a || a !== delta.prAuthor`) already implements this; rule 2's comment now states the identity
  contract explicitly (`src/stages/stage0_hardrules.ts`).
- **Fail-closed author.** `prAuthor` stays `pr.user?.login ?? ""`; an empty author makes every
  commit foreign → dismiss.
- **Force-push is now actually detected, two ways.** `buildDelta` takes a required
  `opts: { webhookForced: boolean }` sourced from the push event payload's `forced` flag. As
  defense-in-depth that works even if the push webhook was lost, it also inspects the compare
  status of the first compare page for basehead `${approvedSha}...${headSha}`: a status of
  `"diverged"` or `"behind"` means `headSha` no longer contains `approvedSha` — history was
  rewritten since approval regardless of what any webhook said — and sets `forcePushed = true`.
  `"ahead"` / `"identical"` are normal.

**Decision status.** FIXED — gate-for-P2 satisfied. No decision outstanding.

**Evidence.**
- Identity mapping + force-push corroboration: `src/github/pr.ts` (`buildDelta`).
- Type contract: `src/stages/types.ts` (`Delta.commitAuthors: (string | null)[]`).
- Foreign-author gate + identity-contract comment: `src/stages/stage0_hardrules.ts` (rule 2,
  reason code `foreign_author_commit`).
- Tests (`npm test`):
  - `test/stage0.test.ts` — the review's exact attack: a commit with `c.author = null` and
    `c.commit.author.name === <pr-author login>` must yield a `null` author and be dismissed as
    `foreign_author_commit` (the spoof test).
  - `test/build_delta.test.ts` — `buildDelta` unit tests with a faked octokit: never reads
    `commit.author.name` even when present; `webhookForced: true` → `forcePushed` true;
    compare status `"diverged"` → `forcePushed` true even with `webhookForced: false`; `"ahead"`
    + `webhookForced: false` → `forcePushed` false.
  - `test/build_delta.test.ts` — static guard: asserts `src/github/pr.ts` contains no
    `commit.author` / `commit.committer` property access, so the spoofable fallback cannot
    silently return.

---

## Item 3 — Control-surface governance

**Concern.** The engine's own control surface — its workflows, the merge-gate ruleset, the
deployment/identity surface, the config schema, the model prompt, the gate code itself, the
GitHub writer, and the invariant tests — is high-value: a change there can weaken every judgment
the engine makes downstream. Two gaps: (a) that surface had no CODEOWNERS enforcement requiring
security-team review, and (b) nothing stopped the engine from **evaluating and preserving an
approval on a PR that modifies its own gates** — i.e. the engine grading its own control surface.

**Where it stands.** FIXED, in two parts.

**Fix — 3a. `.github/CODEOWNERS` (new file).** A CODEOWNERS file routes the control surface to a
security-review owner. It ships with the placeholder owner `@YOUR-ORG/security-review` and a header
comment explaining that forks **must** replace the placeholder with a real team **and** enable the
CODEOWNERS required-review ruleset toggle on their engine repo. Enforcement is by the ruleset's
`require_code_owner_review: true`, already present in `deploy/rulesets/enrolled-ruleset.json`. The
governed groups (and why each is control surface):

- `/.github/` — workflows including the fresh-approval fallback, plus CODEOWNERS itself
- `/deploy/rulesets/` — the merge gate
- `/deploy/helm/`, `/deploy/terraform/` — the deployment surface for the engine identity
  (Pod Identity, secrets, IAM)
- `/src/config/` — thresholds schema + `loadConfig`
- `/config/` — the denylist location ([IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) §6)
- `/src/model/` — `prompt.ts` is control logic; provider wiring
- `/src/stages/` — the gates themselves
- `/src/github/` — the entire GitHub boundary: the echo (`freshApproval.ts`), the only GitHub
  writer (`actuator.ts`), identity/force-push resolution (`pr.ts`), and webhook signature
  verification (`auth.ts`). Directory-wide, so future files here are control surface by default
- `/src/index.ts` — webhook server + event dispatch
- `/src/audit/` — the immutable audit trail
- `/test/no_approve_path.test.ts`, `/test/check_conclusion_guard.test.ts` — the invariant proofs

**Fix — 3b. Self-governance rule in Stage 0 (the engine cannot grade its own control surface).**

- A new **rule 0** runs before the force-push rule in `src/stages/stage0_hardrules.ts`. It matches
  changed files against a **hardcoded** constant `SELF_GOVERNANCE_GLOBS` — deliberately kept in
  code, **not in config**, so the mutable config can never loosen it (invariant). The globs mirror
  the CODEOWNERS groups above.
- When `cfg.selfGovernedRepos.includes(delta.repo)` **and** any changed file matches any
  `SELF_GOVERNANCE_GLOB` (minimatch, `dot: true`, `nocase: true`), Stage 0 dismisses with reason
  code `self_governance` and a message stating the engine does not evaluate changes to its own
  control surface and that human review is required.
- `selfGovernedRepos: string[]` is a **required** field on `EngineConfig` (`src/config/schema.ts`)
  — deployments must consciously set it (typically `["<org>/approval-freshness-engine"]` plus any
  fork/ops repos that host engine control surface). `Delta` gains `repo: string` ("owner/name"),
  populated by `buildDelta` from its owner/repo params (`src/stages/types.ts`).

**Semantics (why this closes the boundary).** The engine already evaluates a PR against the
**deployed** config, so a PR can never loosen the rules it is judged under mid-flight. The
self-governance rule closes the remaining boundary: the engine never *preserves* an approval on a
PR that changes its own gates, prompt, echo, workflows, or ruleset. Such PRs always get fresh human
review — CODEOWNERS-required security review plus native re-approval — with the engine's opinion
withheld. The action space is unchanged (`{dismiss, set-check success|failure, no-op}`); this rule
only ever *dismisses*.

**Decision status.** FIXED — gate-for-P2 satisfied. No decision outstanding. (Operational note: each
fork must replace the CODEOWNERS placeholder team and set `selfGovernedRepos` — both are now runbook
steps; see README.)

**Evidence.**
- CODEOWNERS control surface: `.github/CODEOWNERS`; ruleset enforcement
  `deploy/rulesets/enrolled-ruleset.json` (`require_code_owner_review: true`).
- Self-governance rule + hardcoded globs: `src/stages/stage0_hardrules.ts` (rule 0,
  `SELF_GOVERNANCE_GLOBS`, reason code `self_governance`).
- Config contract: `src/config/schema.ts` (`selfGovernedRepos: string[]`, required);
  `src/stages/types.ts` (`Delta.repo`, `ReasonCode` `self_governance`).
- Tests (`npm test`):
  - `test/self_governance.test.ts` — engine repo + `src/model/prompt.ts` change (even one
    whitespace line) → dismiss `self_governance`; engine repo + an ordinary file
    (`src/somethingelse.ts`) → falls through (`null`); a non-self repo + `.github/workflows`
    change → **not** `self_governance` but still `denylist_path` (proving no behavior change for
    enrolled repos); case-evasion `SRC/Model/Prompt.ts` still trips (`nocase`).
  - `test/self_governance.test.ts` — the gate-implementation files themselves are covered:
    `src/github/pr.ts` (identity resolution), `src/github/auth.ts` (webhook signature
    verification), `src/index.ts` (event dispatch) and `src/audit/logger.ts` each trip
    `self_governance` — a regression pin from adversarial review so the control surface can
    never silently narrow below the code that implements the gates.
  - `test/self_governance.test.ts` — CODEOWNERS sync guard: parses `.github/CODEOWNERS` and
    asserts every `SELF_GOVERNANCE_GLOB` path prefix is CODEOWNERS-covered **in both
    directions**, so the two lists cannot drift apart silently.

---

## Verifying this document

From a clean checkout on `ruleset-governed-failsafe`:

```
npm i
npm test            # all pre-existing tests plus the new item-2 / item-3 tests
npx tsc --noEmit    # clean
```

The invariants asserted throughout — no approve path, action space
`{dismiss, set-check success|failure, no-op}`, static org-owned ruleset with `integration_id`
pinning, `SELF_GOVERNANCE_GLOBS` as a code constant rather than config — are enforced by the tests
cited under each item above, not by prose.
