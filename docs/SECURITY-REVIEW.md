# Security Review One-Pager — Approval Freshness Engine
*(Bring this single page to the meeting. Full detail: epic + IMPLEMENTATION-PLAN.md)*

## The ask
Approve a read-only 2-week evidence spike (P0), then a gated, reversible rollout that replaces
GitHub's blunt "dismiss on any push" with a policy-based, fail-closed staleness engine.

## The merge equation (the actual gate — GitHub enforces it, not the engine)
```
merge allowed  ⇔  approving reviews ≥ 1                              (ruleset pull_request rule)
               AND check `approval-freshness/evaluated` == success
                   on the CURRENT head SHA, from the engine's App ONLY
                   (required_status_checks[].integration_id pinned)
```
Only two things can ever produce that `success`: **(a)** the engine evaluates the delta and decides
PRESERVE, or **(b)** a platform-verified fresh human approval on the exact current head SHA
(`review.commit_id == pr.head.sha`, GitHub already blocks self-approval) is echoed to the check —
mechanically, no AI, no judgment. Every other outcome — engine down, model down, substantive
change, ambiguous state — leaves no `success` on the head SHA, which GitHub natively blocks.
There is no third way to turn this check green.

## The one thing to internalize
**The engine's entire action space is {dismiss a human approval, set the check success/failure,
do nothing}. It cannot approve, merge, or push.** Its worst possible malfunction equals today's
behavior or a blocked merge — never code reaching main without human review, and check `success`
is gated on either the engine's own deterministic+corroborated evaluation or a platform-verified
human approval event, never on the engine's say-so alone. This is proven by an executable test
that fails the build if any approve path exists in the code.

## Invariants (chartered — changing any requires a new security review)
1. No machine approvals, ever. First and only approval authority is a human.
2. Action space ⊆ {dismiss, set-check success|failure, no-op}. No output grants access.
3. Fail closed to a blocked merge that any fresh human approval on the current head can lift — never fail-open, and never a ruleset flip. Engine downtime degrades UX (re-review needed for trivial pushes), never security and never a hard freeze.
4. Deterministic gates outrank the model; denylisted paths never reach the AI.
5. Model output is data, not action — no tools, no credentials, no write access.
6. Immutable 6-year audit trail of every decision.
7. Static, org-owned ruleset with `integration_id` pinning; no runtime credential can alter enforcement. Manual kill switch = human GitOps un-enrollment.

## Why it's *stronger* than the status quo (the fatigued re-approval it replaces)
| | Today | Engine |
|---|---|---|
| Coverage | reviewer may skim/rubber-stamp | 100% byte-exact semantic comparison, every push |
| Consistency | varies with fatigue/pressure | identical gates every time |
| Evidence | "LGTM", no record | machine-checkable rationale, logged immutably |
| Privileged paths | same tired process | categorically human, always |
| Adversary | social-engineerable | gates don't take Slack messages |

## Precedent (this is assembly of proven controls, not a novel bet)
- **Gerrit** (Android/Chromium): deterministic approval preservation is the DEFAULT for trivial rebase / no-code-change. Our Stage 1 = Google's default on GitHub.
- **Meta** (Diff Risk Score, arXiv:2605.30208): ML change-risk gating ~20 production workflows incl. accept-to-ship.
- **Google**: ML acts inside the review loop (comment resolution) at hundreds-of-thousands-of-hours scale.
- **Renovate/Dependabot automerge**: thousands of orgs auto-MERGE scoped classes with no human review — we ask for strictly less (never merge, never approve).
- **GitHub, 2026-07-07**: shipped "restrict who can dismiss reviews" — we use it to lock dismissal to {our App, admins}.
- **Palantir's `policy-bot`**: the established prior art for pinning a required check to a single GitHub App identity via `integration_id`, precisely to stop any other workflow or App from spoofing a same-named check — the exact control this design relies on to keep the fresh-approval echo from being forgeable by anything but the engine's own App.

## Where the AI sits (precisely)
Stage 2 only. Advisory only. On deltas that already cleared the deterministic denylist. Its
"preserve" recommendation is honored ONLY when independent deterministic gates (size, patterns,
confidence) corroborate it. This is exactly "AI preventing a dismissal," never "AI approving."

## Rollout is a trajectory you approve incrementally
P0 read-only (the % number) → P1 shadow (log only) → P2 deterministic-only live on pilots →
P3 AI tier live on pilots + weekly audit sampling → P4 org rollout. Any gate can halt it.

## What we need from security today
1. Ratify the invariants. 2. Co-own the denylist (start maximal). 3. Set audit-sampling rate/owner.
4. Name binding frameworks (SOC2/FedRAMP/HIPAA). 5. Approve Stage-2 data boundary (Bedrock in-boundary vs zero-retention). 6. Approve the P0 read-only spike.
