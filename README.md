# Approval Freshness Engine

![Approval Freshness Engine Architecture](./docs/architecture.png)

Fail-closed, policy-based replacement for GitHub's blunt "dismiss stale approvals on any push."
Determines whether a human approval is still valid after new commits — **without ever approving anything itself.**

## The invariant
The engine's entire action space is `{dismiss, no-op}`. It cannot approve, merge, or push.
Worst-case malfunction ≡ today's behavior or a blocked merge. Enforced by `test/no_approve_path.test.ts`.

## The ladder
1. **Stage 0 — hard rules (deterministic):** privileged paths (`.tf`, prod, workflows, CODEOWNERS), force-push, non-author commits, injection canaries, size caps → categorical dismiss. No AI.
2. **Stage 1 — semantic diff (deterministic, difftastic):** AST-identical / trivial-class / merge-base-only → preserve. No AI.
3. **Stage 2 — AI classifier (advisory):** low-impact + all deterministic corroboration gates pass → preserve; anything else → dismiss.

## End-to-End Flow & Fail-Safe Mechanics

To make this engine work, **GitHub's native "Dismiss stale pull request approvals" setting must be turned OFF** in enrolled repositories. The engine takes over that responsibility. Here is how it operates securely:

1. **The Block:** A developer pushes a new commit to an approved PR. Because native dismissal is off, the approval remains. However, GitHub immediately requires a new `success` status for the `approval-freshness/evaluated` check. The PR is instantly blocked from merging.
2. **The Evaluation:** The engine analyzes the diff through the 3-stage ladder.
    - If the change is substantive or dangerous, the engine uses the API to manually dismiss the approval, sets the check to `failure`, and demands a re-review.
    - If the change is trivial (e.g., formatting), the engine leaves the approval untouched and sets the check to `success`, allowing the merge.
3. **Fail-Safe 1: Peer Override (Zero-Outage Escape Hatch)**
    If the engine completely crashes, the PR remains safely blocked in `pending` status. To prevent a developer outage, any peer engineer can review the code and comment `/override-freshness`. A highly-available GitHub Action verifies the commenter is authorized (and explicitly **not** the PR author) and forces the check to `success`.
4. **Fail-Safe 2: Dead-Man Switch & Safety Sweep**
    If the engine is dead for more than 6 minutes (checked via a 3-minute cron canary), a separate GitHub Action automatically takes over.
    - **Safety Sweep:** It queries for any PRs updated during the downtime that are stuck in `pending`, and manually dismisses their approvals via API.
    - **Revert to Native:** It then automatically patches the repository ruleset to turn the native "Dismiss stale approvals" setting back **ON** and removes the engine's required check. The organization seamlessly returns to today's native behavior without blocking developers.
## Layout
- `src/stages/` — the ladder (0/1/2) + orchestrator
- `src/github/` — App auth, PR/delta resolution, the sole actuator (no approve path)
- `src/model/` — provider-agnostic classifier + versioned control-logic prompt
- `src/audit/` — immutable decision events → Loki audit tenant
- `scripts/p0_backfill.ts` — **read-only** evidence spike → "the number"
- `eval/` — golden-set harness (the security evidence)
- `docs/` — See [Documentation](#documentation) below
- `deploy/` — Helm + Terraform

## Documentation
The `docs/` directory contains all the necessary documents to understand how the engine works and what it does:
- [EPIC.md](docs/EPIC.md) — The high-level product epic and feature breakdown.
- [SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) — The security one-pager detailing the fail-closed invariant.
- [IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) — The full build and implementation details.
- [RUNBOOK.md](docs/RUNBOOK.md) — The operational runbook for on-call and maintenance.

## Start here
1. Read the [SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) and [IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) to understand the architecture.
2. `npm i && npm test` — see the invariant + Stage 0 + adversarial gates pass.
3. `npm run p0 -- --days 90 --repos org/a,org/b` — produce the % number (read-only).

## How to Implement Your Own Instance
To deploy and use the Approval Freshness Engine for your own projects:
1. **Fork this repository:** Fork the repo to your own GitHub organization or user account.
2. **Implement the Stubs:** In `src/`, complete the stubs for `loadConfig()`, blob materialization, and your specific model provider wiring (e.g., OpenAI, Anthropic, GCP).
3. **Configure a GitHub App:** Create a new GitHub App with PR read/write (or relevant) permissions in your organization. Supply these credentials to the engine.
4. **Deploy:** Use the provided `deploy/` directory to deploy the engine via Helm or Terraform to your infrastructure.
5. **Monitor:** Connect the `src/audit/` output to your observability stack (e.g., Loki) to monitor decisions and fallback rates.

## Build honesty
Scaffold written for review clarity; `loadConfig()`, blob materialization, and the model
provider wiring are marked stubs to be completed at deploy time. The decision logic, types,
tests, and control flow are complete and reviewable.
