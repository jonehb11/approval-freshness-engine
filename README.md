# Approval Freshness Engine

![Approval Freshness Engine Architecture](./docs/architecture.png)

Fail-closed, policy-based replacement for GitHub's blunt "dismiss stale approvals on any push."
Determines whether a human approval is still valid after new commits — **without ever approving anything itself.**

## The invariant
The engine's entire action space is `{dismiss, set-check success|failure, no-op}`. It cannot approve,
merge, or push. Worst-case malfunction ≡ today's behavior or a blocked merge. Enforced by
`test/no_approve_path.test.ts`.

## The ladder
1. **Stage 0 — hard rules (deterministic):** privileged paths (`.tf`, prod, workflows, CODEOWNERS), force-push, non-author commits, injection canaries, size caps → categorical dismiss. No AI.
2. **Stage 1 — semantic diff (deterministic, difftastic):** AST-identical / trivial-class / merge-base-only → preserve. No AI.
3. **Stage 2 — AI classifier (advisory):** low-impact + all deterministic corroboration gates pass → preserve; anything else → dismiss.

## End-to-End Flow & Fail-Safe Mechanics

To make this engine work, **GitHub's native "Dismiss stale pull request approvals" setting must be turned OFF** in enrolled repositories. The engine takes over that responsibility — but the *merge gate itself* is never the engine. It is GitHub's own ruleset enforcement, evaluated natively, on every merge attempt, with no runtime credential able to weaken it. The engine's job is only ever to try to make one boolean true.

**The merge equation** (enrolled repo, per PR, enforced 100% by GitHub — not by the engine):

```
merge allowed  ⇔  approving reviews ≥ 1                                  (ruleset pull_request rule)
               AND check `approval-freshness/evaluated` == success
                   on the CURRENT head SHA, from the engine's GitHub App only
                   (required_status_checks[].integration_id pinned — a same-named
                   check from any other identity, incl. github-actions, is rejected)
```

Status checks are matched strictly per head SHA — a success on a previous commit never carries over (a missing/pending/failed check blocks merge unconditionally). So every new push starts blocked by construction, and only two things can ever turn that check green again:

1. **The engine evaluates the delta and decides PRESERVE** — the normal path. It runs the diff through the 3-stage ladder (below) and, if the change since approval is provably null or corroborated low-impact, sets the check to `success` without touching the approval. If the change is substantive or dangerous, it dismisses the stale approval, sets the check to `failure`, and demands a re-review — merge stays blocked until it does.
2. **A fresh human approval on the exact current head SHA is echoed to check success.** GitHub records the exact commit a review was submitted against (`review.commit_id`) and platform-blocks self-approval. A review that satisfies `state == approved && commit_id == head.sha`, from a human who isn't the PR author, *is* the re-review the system is asking for — echoing it to a check is a mechanical restatement of a platform-verified fact, not a machine judgment. This is implemented twice, redundantly: once in the engine itself (`src/github/freshApproval.ts`, the primary path) and once as a standalone GitHub Actions workflow (`.github/workflows/fresh-approval-fallback.yaml`) that authenticates as the same GitHub App and runs on GitHub's own infrastructure — so the unblock path survives the engine's pod being down.

**The fail-safe story, in one sentence: the ruleset IS the fail-safe.** There is no separate dead-man switch, no auto-revert, no second "native" ruleset state to swap into, and no org-ruleset-write credential anywhere in the system. If the engine crashes, nothing insecure happens — a freshly-pushed PR simply stays in the same natively-blocked state a missing CI check would leave it in. A developer unblocks it exactly the way native GitHub already asks them to: get it re-reviewed. The only "recovery" is a human doing that, on the current head SHA, and the fallback workflow turning that into a green check without the engine needing to be alive. Every failure of every component — model outage, pod crash, webhook loss — resolves to "no success on head SHA," which GitHub already, natively, blocks. Nothing in this design can fail open, and nothing can freeze a merge forever, because a fresh approval is always a way out.

## Layout
- `src/stages/` — the ladder (0/1/2) + orchestrator
- `src/github/` — App auth, PR/delta resolution, the actuator (check success/failure + dismiss; no approve path), and the fresh-approval echo (`freshApproval.ts`)
- `src/model/` — provider-agnostic classifier + versioned control-logic prompt
- `src/audit/` — immutable decision events → Loki audit tenant
- `scripts/p0_backfill.ts` — **read-only** evidence spike → "the number"
- `eval/` — golden-set harness (the security evidence)
- `docs/` — See [Documentation](#documentation) below
- `deploy/` — Helm + Terraform + the static, org-owned ruleset (`deploy/rulesets/`) that is the actual merge gate — never edited at runtime by any automation
- `.github/workflows/fresh-approval-fallback.yaml` — redundant, GitHub-infra-hosted fresh-approval echo (liveness path independent of the engine's uptime)

## Documentation
The `docs/` directory contains all the necessary documents to understand how the engine works and what it does:
- [EPIC.md](docs/EPIC.md) — The high-level product epic and feature breakdown.
- [SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) — The security one-pager detailing the fail-closed invariant.
- [IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) — The full build and implementation details.
- [RUNBOOK.md](docs/RUNBOOK.md) — The operational runbook for on-call and maintenance.
- [SECURITY-FOLLOWUPS.md](docs/SECURITY-FOLLOWUPS.md) — Disposition of the three security-review follow-up items (custody decision + two fixes), with evidence.

## Start here
1. Read the [SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) and [IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) to understand the architecture.
2. `npm i && npm test` — see the invariant + Stage 0 + adversarial gates pass.
3. `npm run p0 -- --days 90 --repos org/a,org/b` — produce the % number (read-only).

## Implementation Runbook — deploying your own instance

Anyone forking this repo needs to provide exactly four things: **a GitHub App** (the engine's
identity), **a place to run the pod** (EKS or any k8s), **the org ruleset** (the actual merge
gate), and **two org-level Actions credentials** (only if you want the optional fallback
workflow). Follow these steps in order — the order matters, because each step is fail-closed
against the next one being missing.

### 1. Fork and complete the stubs
Fork the repo, then complete the deploy-time stubs in `src/` (marked, see
[Build honesty](#build-honesty)): `loadConfig()`, blob materialization, and your model provider
wiring in `src/model/provider.ts` (Bedrock or Anthropic API). `npm i && npm test` must stay
green — the invariant tests are your regression harness, not optional.

### 2. Create the GitHub App (the engine's identity)
Create a new GitHub App in your org (`Settings → Developer settings → GitHub Apps`):
- **Permissions (least privilege — do not add more):** Checks: Read & write · Pull requests:
  Read & write · Contents: Read-only · Metadata: Read-only. Explicitly NOT: Administration,
  Actions, Workflows, Members, or any org permission. The App must be *unable* to merge, push,
  or edit rulesets even if its key leaks.
- **Webhook:** URL → your engine's ingress `/webhook`; generate a strong webhook secret.
  Subscribe to events: `pull_request`, `pull_request_review`, `push`.
- **Record two values:** the **App ID** (numeric, on the App settings page — this is also the
  `integration_id` for step 4) and the **private key** (generate and download once).
- **Install** the App on your org, scoped to **only the repos you will enroll** — never
  "all repositories".

### 3. Deploy the engine pod
Use `deploy/helm/`. Supply via your secrets path (ESO/Secrets Manager — never in Git):
App ID, App private key, webhook secret; set `MODEL_PROVIDER`/`MODEL_ID`. Start with
`DRY_RUN=true` (shadow mode: decisions are logged, nothing is written to GitHub) and watch the
audit log until you trust the decisions, then flip it off. Wire `src/audit/` output to your
log stack (e.g. Loki) — every decision, dismissal, and fresh-approval echo is a structured event.

Set the **required** `selfGovernedRepos` config field (`EngineConfig`, `src/config/schema.ts`) to
the list of repos that host this engine's control surface — typically
`["<your-org>/approval-freshness-engine"]` plus any fork/ops repos carrying it. This is what makes
the engine refuse to grade its own gates: a PR against one of these repos that touches the control
surface is categorically dismissed (`self_governance`) for human review, never preserved. The field
is required precisely so this is a conscious deploy-time decision, not a default someone forgets.

### 4. Apply the org ruleset (the actual merge gate)
This is the security-critical step. Follow `deploy/rulesets/README.md` exactly:
1. In `deploy/rulesets/enrolled-ruleset.json`, replace the two placeholders:
   - `integration_id: 0` → **your App ID from step 2.** The shipped `0` is a deliberately
     invalid sentinel: applied unmodified, the check can never be satisfied and merges block
     (fail-closed), rather than silently accepting a spoofable unpinned check.
   - `repository_name.include` → your enrolled repos (explicit names/patterns, or switch to a
     repository custom property — both documented in the rulesets README).
2. Apply it **org-level** (`POST /orgs/{org}/rulesets`), enforcement `active`. Org-level means
   repo admins structurally cannot weaken it.
3. Make sure no *other* ruleset or classic branch protection on those repos still has native
   "Dismiss stale pull request approvals" or "Require approval of the most recent reviewable
   push" enabled — this ruleset owns staleness now (both are correctly `false` inside it).
4. Optional hardening (recommended): "restrict who can dismiss reviews" → {your App, a
   break-glass team}. The exact API field must be confirmed live first — the rulesets README
   has the verification commands.
5. Replace the CODEOWNERS placeholder team. `.github/CODEOWNERS` ships with the placeholder owner
   `@YOUR-ORG/security-review` over the engine's control surface (workflows, ruleset, helm, config,
   prompt, gates, the echo, the actuator, the invariant tests). Replace it with a **real** security
   team and make sure the ruleset's `require_code_owner_review: true` (already in
   `enrolled-ruleset.json`) is active on your engine repo — otherwise the control surface has no
   enforced reviewer. This pairs with `selfGovernedRepos` (step 3): the engine withholds its
   opinion on control-surface PRs, and CODEOWNERS makes sure a human security reviewer is required.

### 5. Enable the fresh-approval fallback (optional but recommended)
This is the unblock path that works while the pod is down. It must exist **in each enrolled
repo** (copy `.github/workflows/fresh-approval-fallback.yaml` in via your enrollment
automation or a template repo), and it needs two org-level Actions credentials, both scoped to
enrolled repos only:
- org **variable** `AFE_APP_ID` = the App ID from step 2
- org **secret** `AFE_APP_PRIVATE_KEY` = the App private key

Read the workflow's header comment first — it documents the key-custody trade-off (a second
copy of the App key lives in Actions secrets). An org may deliberately skip this step and stay
fully fail-closed; the cost is that during an engine outage, blocked PRs wait for the engine
to return (or an org owner's audited break-glass) instead of being unblocked by a fresh review.

### 6. Verify with a live drill (do not skip)
On a throwaway enrolled repo:
1. Open a PR, get it approved, push a trivial commit → the PR must show **blocked** on
   `approval-freshness/evaluated` until the engine reports (proves the gate).
2. Push a whitespace-only change → engine should set `success` without dismissing (proves the ladder).
3. Kill the engine pod, push again → PR stays blocked indefinitely (proves fail-closed, no timer).
4. While the pod is still dead, have a peer re-approve on the current head → the fallback
   workflow must flip the check green within ~a minute (proves the unblock path).
5. From a plain Actions workflow with `checks: write`, try to create a check named
   `approval-freshness/evaluated` with `conclusion: success` → the merge box must show it as
   **not** satisfying the requirement ("not set by the expected GitHub App") — proves the
   `integration_id` pin. If this step fails, STOP: your ruleset is not pinned.
6. Restart the engine; confirm normal evaluation resumes on the next push.
7. On the engine repo itself (enrolled with `selfGovernedRepos` set), open a PR touching
   `src/model/prompt.ts` (or any control-surface path) → the engine must **dismiss** with reason
   `self_governance` (it never grades its own gates), and the PR must **demand a CODEOWNERS
   security review** before it can merge. Proves both control-surface governance halves.

### 7. Operate
Set up the drift-monitoring query from `deploy/rulesets/README.md` (alert on any ruleset
change — a monitoring aid, never an auto-repair), and read `docs/RUNBOOK.md`: the "engine
down" procedure is deliberately *"nothing is required for safety — fix the pod at leisure;
developers unblock themselves with a fresh review."*

## Build honesty
Scaffold written for review clarity; `loadConfig()`, blob materialization, and the model
provider wiring are marked stubs to be completed at deploy time. The decision logic, types,
tests, and control flow are complete and reviewable.
