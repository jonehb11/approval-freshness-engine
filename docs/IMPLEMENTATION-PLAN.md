# Approval Freshness Engine — Complete Implementation Plan

**Companion to:** `approval-freshness-engine-epic.md` (the why + security case). This document is the **how**: architecture, code, config, tests, evals, deployment, rollout, runbooks, and acceptance criteria. An engineer should be able to execute this end to end.

**Invariant restated (governs every line below):** the engine's only actions are `dismiss` or `no-op`. It never approves, never merges, never pushes. Fail-closed everywhere.

---

## 1. System overview

```
GitHub (enrolled repos)
  │  webhook: pull_request.synchronize / .review_requested / push
  ▼
[Ingress] signature-verified webhook receiver (HTTPS)
  │  enqueue {repo, pr, head_sha, installation_id}
  ▼
[Worker] idempotent job per (pr, head_sha)
  │  1. resolve last-approved SHA + approvers (GitHub API)
  │  2. compute changed files + commit/push metadata
  ▼
[Decision ladder]
  Stage 0  hard rules (pure fn)         → dismiss | continue
  Stage 1  difftastic semantic diff     → preserve | continue
  Stage 2  AI classifier (advisory)     → preserve | dismiss
  │  (corroboration gate overrides model)
  ▼
[Actuator] GitHub API
  · set check-run `approval-freshness/evaluated` = success|failure
  · on dismiss: dismiss review(s) + comment + request re-review
  · on preserve: comment with evidence, leave approval intact
  ▼
[Audit] structured event → Loki (audit tenant) + metrics → Mimir
```

**Runtime shape:** stateless Docker container (Node 20 / TypeScript) deployed to an EKS shared cluster. We explicitly avoid AWS Lambda to eliminate cold starts (which are particularly painful when booting the difftastic Rust binary) and to allow persistent in-memory rate limiting and caching. Horizontal scale by replica. Queue = in-memory per-instance for P0, then SQS/Redis for HA (§9). No database required — GitHub is the state store; the engine is a pure function of PR state at a head SHA. Optional short-TTL cache (idempotency + rate-limit friendliness).

**Why TypeScript:** Probot/Octokit are first-class in TS; the webhook + App-auth + check-run surface is best-documented there; and the whole thing is I/O-bound glue, not compute. (Go is a fine alternative if the org standardizes there; the design is language-neutral.)

---

## 2. GitHub App definition

### 2.1 Permissions (least privilege — put this in the security review)
| Scope | Level | Why |
|---|---|---|
| Pull requests | Read & write | Read PR state; **dismiss reviews**, comment, request re-review. Write is required ONLY for dismiss/comment — never approve (no API scope grants "approve as app" here; reviews are dismissed, not created). |
| Checks | Read & write | Create/update the `approval-freshness/evaluated` check-run (the fail-closed gate). |
| Contents | Read | Fetch diffs / file lists / blobs for difftastic. |
| Metadata | Read | Mandatory baseline. |

**Explicitly NOT requested:** Administration, Actions write, Workflows, Secrets, Members, org-admin. The App cannot merge, cannot push, cannot alter rulesets, cannot approve.

### 2.2 Webhook events
`pull_request` (actions: `synchronize`, `ready_for_review`, `reopened`), `pull_request_review` (action: `submitted` — routes to the fresh-approval echo, §4.4), `push` (defense-in-depth for edge cases). Webhook secret verified on every request (§4.1).

### 2.3 Installation
Org-level install, **repository-scoped to enrolled repos only** (never "all repos"). Enrollment = add repo to the App installation + apply the enrollment ruleset (§7).

---

## 3. The decision ladder — precise semantics

### 3.1 Resolving "the approved state"
The pivotal input. For a PR with a current approving review R submitted at commit C_approved, and current head C_head:
- `approved_sha` = the commit SHA the approval was submitted against. Obtained from the review's `commit_id` (GitHub records it).
- If multiple current approvals exist, use the **earliest** approved_sha among still-current approvals (most conservative: the delta is measured from the oldest approval we're preserving).
- `delta = diff(approved_sha .. head_sha)`.
- If `approved_sha` is unavailable/ambiguous → **fail closed (dismiss)**.

### 3.2 Stage 0 — hard rules (deterministic, no model)
Dismiss immediately if ANY predicate is true:
1. `changed_files ∩ denylist ≠ ∅` — glob denylist (§6.1), evaluated on the union of files changed across the whole delta.
2. Force-push / history rewrite detected (`before`/`after` non-fast-forward, or base changed).
3. Any commit in the delta authored by a login ≠ the PR author's login (covers the "someone else pushed onto my approved branch" hijack).
4. The delta touches CODEOWNERS-governed paths (belt to the denylist's suspenders).
5. Injection-canary: delta text contains classifier-targeting patterns (§6.3) — dismiss AND flag (never let Stage 2 see it).
6. Delta size exceeds `hard_max_lines`/`hard_max_files` (a "trivial fix" that's 2,000 lines isn't trivial; force human review).

Any hit → `DISMISS` with reason code. No model call.

### 3.3 Stage 1 — deterministic semantic diff (difftastic)
Run difftastic structurally over the delta. `PRESERVE` iff one of:
- **AST-identical**: difftastic reports zero structural changes (whitespace/formatting/comment-only). This is the big bucket.
- **Trivial-class-only**: every changed file matches an allowlisted trivial class (`*.md` docs, lockfile-only changes authored by a known bot, generated files whose regeneration is deterministic).
- **Merge-base-only**: the PR's own tree delta vs `approved_sha` is empty; the "change" is entirely an updated merge base from an unrelated PR landing. (This is the class GitHub dismisses today for no reason — §epic 1.7.)

Any file in a language difftastic can't parse, or any structural change → **fall through** to Stage 2 (never preserve on uncertainty). Emit the difftastic report into the audit record and the PR comment.

### 3.4 Stage 2 — AI impact classifier (advisory, gated)
Only reached for real semantic changes on non-privileged paths.
- Input to model: the **semantic delta only** (not the whole PR), plus minimal structured metadata (file paths, languages, size). Delivered as clearly-delimited untrusted data under a hardened system prompt (§src/model).
- Model returns strict JSON: `{ impact: "low"|"high", confidence: 0..1, reasons: string[], signals: {...} }`. No prose, no tools, no loop.
- **Corroboration gate (deterministic, overrides model):** `PRESERVE` iff ALL hold:
  - `impact == "low"` AND `confidence >= conf_threshold` (default 0.85)
  - `delta_lines <= soft_max_lines` (default 40) AND `delta_files <= soft_max_files` (default 5)
  - no new dependencies added (manifest/lockfile scan — though those are denylisted anyway)
  - no auth/crypto/network-egress/deserialization patterns present (regex signal set §6.4)
- Anything else (`high`, low confidence, any gate fails, model error, timeout, malformed JSON) → **DISMISS**.

### 3.5 Terminal actions
- `PRESERVE`: set check `success`; post evidence comment; **take no action on the review** (the human approval stands untouched).
- `DISMISS`: dismiss the stale review(s) via API with a reason; post comment summarizing the delta; request re-review from original approver(s); leave check `failure` (merge blocked until fresh human approval re-greens it natively).
- Every path writes a complete audit event first, then acts (write-ahead: if the actuator fails, we retry, and the audit shows intent).

---

## 4. Security controls (implementation-level)

### 4.1 Webhook authenticity
HMAC-SHA256 verify `X-Hub-Signature-256` against the webhook secret on every request, constant-time compare, before any parsing. Reject unsigned/mismatched with 401. (Blocks spoofed events that could trigger dismissals or waste model spend.)

### 4.2 App auth
JWT signed with the App private key → installation access token (1h TTL, auto-refreshed), scoped to the installation. Private key in AWS Secrets Manager, pulled via the platform's existing ESO/Pod-Identity path — never in Git, never in env files committed anywhere.

### 4.3 Fail-safe design — the ruleset IS the fail-safe

**Design principle (corrected, and corrected again):** there is no separate "fail-safe mechanism" distinct from normal operation. The merge gate is GitHub's own ruleset enforcement — static, org-owned, never edited at runtime by any automation (§7.1) — and it fails closed *by construction*: required status checks are matched strictly per head SHA (a success on a previous commit never carries over), so a missing/pending/failed check on the current head blocks merge unconditionally, with no engine involvement required to produce that blocking. The engine's only job is to try to make the check say `success`. When it can't — because it's down, because the model is degraded, because the change is genuinely substantive — the ruleset does exactly what it would do for a dead CI job: block. That is not a special failure mode; it is the default state every push starts in.

This is enforced by a **three-tier degradation ladder**, each tier independent of the one above it so a failure can't take its own fallback down with it:

**Tier 1 — Healthy.** Full ladder (Stage 0/1/2). Trivial/null pushes preserved; substantive/privileged pushes dismissed. Normal operation.

**Tier 2 — Model degraded, engine up (circuit breaker).** If the model provider errors/times out repeatedly, the engine trips a circuit breaker into **deterministic-only mode**: Stage 0 and Stage 1 still run, so the largest and safest buckets (whitespace/formatting/comment-only, merge-base-only, trivial-class) are *still preserved* with zero re-review noise. Anything that would have needed Stage 2 falls back to **dismiss** (native-equivalent: stale approval dismissed → human re-review). Most of the value survives a model outage.

**Tier 3 — Engine down (static-ruleset fail-closed, no auto-revert).** If the engine is genuinely down, nothing reverts, nothing is patched, and no automation touches the ruleset. Every freshly-pushed enrolled PR simply sits on a missing/pending required check — natively blocked, exactly as GitHub would block on any other required check that stopped reporting. Recovery does not depend on the engine coming back: a **fresh human approval submitted on the exact current head SHA** is a platform-verified fact (`review.commit_id == head.sha`, self-approval already blocked by GitHub) that gets echoed to check `success` by a **redundant path that runs on GitHub's own infrastructure**, independent of the engine's uptime — `.github/workflows/fresh-approval-fallback.yaml` (§7.2, §4.4). The org never "returns to native behavior" because it never left the one ruleset it has; it just waits on the same check-required gate a dead CI job would leave in place, with a working, always-available way to satisfy that gate.

**Why the required check does NOT cause a freeze:** the required check `approval-freshness/evaluated` blocks a *freshly-pushed* PR only until something makes it `success` on that exact head SHA — either the engine's verdict, or a fresh human approval on that head being echoed by the fallback workflow. Because the fallback workflow authenticates as the engine's GitHub App and runs on GitHub Actions infra (not our cluster), that path stays available even if the engine's pod is completely dead. There is **no state in which merges are blocked indefinitely on the engine's health** — the exposure is bounded by "how long until a human re-reviews," which is exactly today's re-review latency, not a new failure mode.

**The pending marker + reaper still exist, but their job is about liveness, not safety.** The engine still writes `approval-freshness/evaluated = pending`/`in_progress` on receipt (so a new SHA never inherits an old SHA's green check — required by GitHub's per-head-SHA check matching, not by anything the engine does). A per-PR reaper still catches individually lost jobs — its action for a stuck-pending PR is to **dismiss the stale review AND resolve the check to failure** (i.e., reproduce native behavior for that one PR: stale → re-review required), never to leave it wedged in `pending`. This closes a slow-webhook edge case; it is not load-bearing for security, since a check that never resolves at all *also* blocks merge — silence is already safe, the reaper just keeps it from being silently slow.

**Direction of every failure, stated for the security review:** every degradation path lands on **dismiss-and-require-human-re-review (= the current control)** or on **no success on the current head SHA (= natively blocked, requiring the identical re-review to clear)**. No path lands on "merge without re-review" (fail-open) and no path lands on "merge frozen forever" (there is always a human re-review escape valve). The failure mode of this system is *the same block a missing required check has always produced* — and the same fix: re-review.

### 4.4 Fresh-approval echo (replaces peer override)
There is no comment-triggered override and no code path that spoofs the check from a different identity — that was the exact hole `integration_id` pinning (F2, §7.1) closes, and the old peer-override Action ran as the `github-actions` identity, which a correctly-pinned ruleset now rejects outright. The escape hatch is instead a **platform-verified fresh human approval**, echoed to a check success by code that makes no judgment calls:
- **The mechanism:** a developer blocked by an outage (or by a legitimate re-review need) asks a peer — or, if the PR already required a second approver, simply waits for the next reviewer — to review the current head and click **Approve** in GitHub's native UI. Nothing bespoke; this is the same action native GitHub already asks for after a dismissal.
- **The validation (`src/github/freshApproval.ts`, and identically in `.github/workflows/fresh-approval-fallback.yaml`):** a `pull_request_review` webhook with `action == submitted` qualifies only if **all** hold: `review.state == "approved"` (case-insensitively); `review.commit_id == pull_request.head.sha` (exact string equality — a stale approval on an old SHA does not qualify); `review.user.login != pull_request.user.login` (defense in depth — GitHub already platform-blocks self-approval); `review.user.type != "Bot"`; the PR is open and not a draft. Any failed precondition is a **no-op** — never a `failure` write, since a non-qualifying review isn't evidence the check should flip red.
- **The resolution:** on qualification, the actuator sets `approval-freshness/evaluated = success` on `review.commit_id`, with an output summary crediting the reviewer and stating this came via a fresh-approval echo, not the ladder.
- **Why it's implemented twice:** the engine's own handler is the primary path (fastest, fully audited alongside every other decision). The GitHub Actions copy exists purely for the case the engine itself is down — it authenticates as the *same* GitHub App (`actions/create-github-app-token@v2`, app credentials from org secrets) because `integration_id` pinning means only that one identity can ever satisfy the required check. It re-fetches the PR before writing to guard the race where the head moved between the event and the run, and exits without writing if so.
- **Security posture:** this is not a machine approval — the check is a mechanical restatement of a human act GitHub itself already verified (exact-commit review, non-self, non-bot). No AI, no judgment, no new trust placed anywhere. The trade-off it *does* introduce — a second custody point for the App's private key, in org Actions secrets, for the fallback workflow — is documented prominently in that workflow's header and in SECURITY-REVIEW.md; an org that doesn't want that trade-off can omit the fallback workflow and accept "engine down ⇒ wait for the pod" as still fail-closed.

### 4.5 Model isolation
The model has: no tools, no function calling, no network, no credentials, no memory across calls. It receives text, returns JSON. Its output cannot act — it's consumed by deterministic gate code. Prompt-injection in the diff can at most produce a `low` verdict, which the corroboration gate can veto and which can only ever *preserve* an already-human-approved, denylist-cleared, size-limited, pattern-clean change.

### 4.6 Dismissal-authority hardening
On enrolled repos, GitHub's ruleset "restrict who can dismiss reviews" → {this App, repo admins}. Prevents a random write-access user from dismissing/gaming reviews outside the engine.

### 4.7 Audit integrity
Every decision emits an immutable structured event to the Loki audit tenant (6-year retention, WORM-backed per the observability design). Events are append-only; the engine has no delete path. Fields in §src/audit.

---

## 5. Repository map

```
approval-freshness-engine/
├── src/
│   ├── index.ts                 # webhook server + worker bootstrap
│   ├── config/
│   │   ├── schema.ts            # zod-validated config
│   │   └── defaults.ts          # thresholds, timeouts
│   ├── github/
│   │   ├── auth.ts              # App JWT → installation token
│   │   ├── client.ts            # Octokit wrapper
│   │   ├── pr.ts                # resolve approved_sha, approvers, files, delta
│   │   ├── actuator.ts          # check-run + dismiss + comment (the ONLY writer)
│   │   └── freshApproval.ts     # pure decision fn + handler for the fresh-approval echo (§4.4)
│   ├── stages/
│   │   ├── ladder.ts            # orchestrates 0→1→2, short-circuits
│   │   ├── stage0_hardrules.ts  # pure fn, denylist + hijack + canary
│   │   ├── stage1_difftastic.ts # semantic diff wrapper + classification
│   │   ├── stage2_classifier.ts # model call + corroboration gate
│   │   └── types.ts             # Decision, Verdict, ReasonCode
│   ├── model/
│   │   ├── provider.ts          # Bedrock | Anthropic API, structured output
│   │   └── prompt.ts            # versioned system prompt (the control logic)
│   └── audit/
│       ├── logger.ts           # structured event → stdout/Loki
│       └── metrics.ts          # prom-client counters/histograms
├── test/                        # unit + integration (fixtures = real-ish deltas)
├── eval/                        # golden-set harness (the security evidence)
├── scripts/
│   └── p0_backfill.ts          # READ-ONLY historical analysis → "the number"
├── deploy/
│   ├── helm/                    # k8s chart (fits the GitOps component model)
│   ├── terraform/               # App secret, SQS (HA), IAM/Pod-Identity
│   └── rulesets/                # the canonical, static, org-owned ruleset (§7.1) — the actual
│                                 # merge gate; applied via GitOps, never by runtime automation
├── docs/
│   ├── IMPLEMENTATION-PLAN.md   # this file
│   ├── RUNBOOK.md
│   └── SECURITY-REVIEW.md       # one-pager for the meeting
└── .github/workflows/
    ├── ci.yaml
    └── fresh-approval-fallback.yaml  # redundant, GitHub-infra-hosted fresh-approval echo (§4.4)
```

---

## 6. Configuration (version-controlled; security co-owns)

### 6.1 Denylist (glob, `config/denylist.yaml`)
```yaml
# ANY match → categorical dismiss, no AI. Start maximal; relax with evidence.
paths:
  - "**/*.tf"
  - "**/*.tfvars"
  - "**/prod/**"
  - "**/production/**"
  - ".github/workflows/**"
  - ".github/actions/**"
  - "**/CODEOWNERS"
  - "**/Dockerfile"
  - "**/*.hcl"
  - "**/iam/**"
  - "**/*policy*.json"
  - "**/secrets/**"
  - "**/*.pem"
  - "**/kustomization.yaml"
  - "**/values*.yaml"          # helm values = deploy config
  - "**/package.json"          # dep manifests
  - "**/requirements*.txt"
  - "**/go.mod"
  - "**/Cargo.toml"
  - "**/pom.xml"
  - "**/*.sql"                 # schema/migration
  - "**/migrations/**"
```

### 6.2 Trivial-class allowlist (Stage 1 preserve-eligible)
```yaml
trivial_classes:
  docs: ["**/*.md", "**/*.mdx", "**/*.rst", "docs/**"]
  lockfiles_bot_only:          # preserve only if the ONLY change AND authored by a bot
    files: ["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml"]
    require_bot_author: ["dependabot[bot]", "renovate[bot]"]
  generated:
    files: ["**/*.pb.go", "**/*_generated.ts"]
    require_deterministic_regen: true
```

### 6.3 Injection canaries (Stage 0 → dismiss + flag)
Regexes matching classifier-manipulation attempts inside diff content, e.g. imperative strings addressed to a model, role-play framings, "ignore previous", "mark this as", "impact: low", JSON-injection-shaped fragments. Match → dismiss (never reaches Stage 2).

### 6.4 Sensitive-pattern signals (Stage 2 corroboration veto)
Regex/AST signals whose presence forces DISMISS even on a model "low": auth (`jwt`, `password`, `authenticate`, `authorize`, `session`), crypto (`crypto`, `cipher`, `sign`, `hmac`, `random`), network egress (`fetch`, `http`, `axios`, `net.`, `socket`, new URLs/hosts), deserialization (`eval`, `exec`, `pickle`, `deserialize`, `yaml.load`), and IaC/keys leaking into non-denylisted files.

### 6.5 Thresholds (`config/defaults.ts`)
```
conf_threshold          = 0.85
soft_max_lines          = 40
soft_max_files          = 5
hard_max_lines          = 400     # Stage 0 categorical
hard_max_files          = 20
model_timeout_ms        = 8000    # single Stage-2 call → dismiss on hang (Tier 1)
stale_pending_timeout   = 15m     # per-PR reaper: lost job → dismiss + resolve check (liveness, not safety)
circuit_break_after     = 5       # consecutive model failures → Tier 2 deterministic-only mode
circuit_reset_after     = 5m      # cooldown before re-testing the model provider
```

**`stale_pending_timeout` is a liveness knob, not a safety mechanism.** A stuck-pending check already blocks merge on its own — GitHub's per-head-SHA matching means an unresolved check is exactly as safe as a `failure` one. The reaper's only job is to turn "safe but silent" into "safe and informative" for the one PR that lost its job (dismiss the stale review, resolve the check to `failure`, so the developer sees a reason instead of a wedge). There is no dead-man threshold here and nothing analogous to it: the ruleset never changes, so there's nothing to countdown toward reverting. `model_timeout_ms` (~8s) is the only timeout that fires constantly/harmlessly (that PR dismisses); `stale_pending_timeout` (~15m) fires rarely, on genuinely lost jobs, and its output is still just "dismiss and ask for re-review" — never a ruleset mutation.

**Liveness beyond the reaper (documented, may remain a stub per §"Build honesty"):** a reconciliation poller concept — the engine periodically lists open enrolled PRs and re-evaluates any head SHA lacking a completed check — covers lost webhooks (GitHub does not auto-redeliver them; a lost webhook just leaves the check missing, which is already safe, merely slow). Its failure mode is slower merges, never a merge without evaluation.

---
## 7. GitHub enrollment (per-repo, via Ruleset)

Enrollment is deliberately explicit and reversible (kill switch = human un-enrollment via GitOps).

### 7.1 The one permanent ruleset configuration (defined in Git, applied per repo)

There is exactly **one** state an enrolled repo's default-branch ruleset can be in (`deploy/rulesets/enrolled-ruleset.json`). It is static — nothing at runtime holds a credential capable of writing to it, and there is no second "native configuration" it swaps into. Enrolling or un-enrolling a repo is a human, Git-reviewed change to the ruleset's target list, applied via the update-ruleset REST endpoint, which is **`PUT`, not `PATCH`**.

1. Require a pull request before merging; require ≥1 approving review (unchanged).
2. **Disable** native "Dismiss stale pull request approvals when new commits are pushed" — the engine now owns staleness (this is what lets the engine *preserve*; it's also why we can't just leave native dismissal on as a backstop — native dismissal firing on every push would leave the engine no way to say "keep it," and the engine can't re-approve).
3. **Disable** "Require approval of the most recent reviewable push" — subsumed by the engine and by the fresh-approval echo (§4.4), which is itself a check-shaped restatement of "approve the latest push."
4. **Require status check** `approval-freshness/evaluated`, **with `required_status_checks[].integration_id` pinned to the engine's GitHub App.** This is the single most load-bearing line in the ruleset: without it, a check with the same name from any other identity — including a plain `github-actions` workflow — would satisfy the requirement. This is exactly the hole the old peer-override Action exploited by design; pinning closes it permanently.
5. **Restrict who can dismiss reviews** → {engine App, break-glass team} (the July-2026 ruleset control; exact field name to be verified against the live OpenAPI schema at rollout — §"deploy/rulesets/README.md" has the `gh api` command).
6. `non_fast_forward` rule: block force pushes (closes a SHA-replay nuance Stage 0's force-push detection alone doesn't fully cover at the ruleset layer).
7. Keep CODEOWNERS requirements as-is (independent; also denylisted).
8. Bypass list: **empty.** Break-glass is org owners editing the ruleset itself — a deliberate, audited (`repository_ruleset.*` org audit-log events), Git-reviewed act, never a standing bypass actor.

**Because org-level rulesets combine as pure AND with repo-level ones and repo admins cannot weaken an org ruleset, this single configuration cannot be quietly loosened by anyone without going through the ruleset's own Git-reviewed change process.**

**Unenrolled repos:** never touched — permanently on native GitHub behavior. Rollout is repo-by-repo.

**Manual kill switch:** un-enrollment. An org owner removes a repo from the ruleset's target list (or disables the ruleset for that repo) via the same `PUT`-based, Git-reviewed GitOps process used to enroll it — no automation, no `workflow_dispatch`, no environment-protection approval flow, because there is no automated direction to protect against. This instantly and fully restores native branch protection for that repo. It is the *only* kill switch; there is no automatic equivalent, because there is nothing for automation to revert.

### 7.2 Recovery when the engine is down (no auto-revert — see §4.3)

There is no dead-man switch, no canary, and no scheduled workflow that mutates the ruleset. The ruleset is the fail-safe (§4.3), and it does not need to be reverted to anything — it already fails closed by sitting there, unchanged, requiring a check that simply won't be green until something legitimate makes it so.

**What actually happens if the engine is down:**
- A freshly-pushed enrolled PR's `approval-freshness/evaluated` check stays missing or `in_progress`. Merge is blocked — the same outcome as any other required check that stopped reporting. This is expected and safe, not an incident from the ruleset's point of view.
- A developer who wants to proceed gets the PR **freshly re-reviewed on the current head** — exactly the native GitHub UX a dismissal already produces. That approval, submitted with `commit_id == head.sha`, is picked up by `pull_request_review` webhook delivery and echoed to check `success` by whichever of the two implementations is reachable: the engine itself (`freshApproval.ts`, if the pod is up) or, if it isn't, `.github/workflows/fresh-approval-fallback.yaml` — running entirely on GitHub Actions infra, so it does not share fate with the engine's cluster.
- The fallback workflow authenticates as the **same GitHub App** (via `actions/create-github-app-token@v2`, app-id/private-key from org Actions secrets), because `integration_id` pinning (§7.1) means only that one identity can ever satisfy the required check — a workflow authenticating any other way would write a check the ruleset simply rejects. This is a genuine trade-off (a second custody point for the App's private key) and is documented prominently in the workflow's own header and in SECURITY-REVIEW.md; an org may choose to omit the fallback workflow entirely and accept "engine down ⇒ wait for the pod, or org-owner break-glass" as still fail-closed.
- **On-call is paged to fix the engine at its own pace — never to unblock developers.** Developers already have a working unblock path (re-review) that does not depend on anyone getting paged.

**There is no re-enrollment workflow, because there was never a de-enrollment to reverse.** The ruleset never changed. The only thing that changes across an outage is how many PRs are waiting on a fresh review instead of an automatic preserve — a UX cost, not a security one.

---

## 8. Testing strategy

### 8.1 Unit (pure functions — the safety-critical core)
- `stage0`: table-driven — every denylist glob, hijack (foreign-author commit), force-push, canary, size cap. **100% branch coverage required** (this is the categorical-safety gate).
- `stage1`: fixtures of real-ish deltas → assert AST-identical, trivial-class, merge-base-only, and fall-through classification. Unsupported-language input MUST fall through (never preserve).
- corroboration gate: property test — for all model outputs, a `high` or any failed gate ⇒ never PRESERVE. This is the "AI can't do damage" proof, as executable code.

### 8.2 Integration (recorded GitHub fixtures)
Replay recorded webhook payloads + API responses (nock/msw). Assert the actuator makes exactly the right calls (dismiss vs. check-only) and NEVER calls an approve endpoint (there's a test that greps the actuator for any create-review-with-APPROVE and fails if present).

### 8.3 Adversarial suite (security regression)
A corpus of malicious deltas: prompt injection in comments, payload-after-approval, sensitive pattern smuggling, oversized "trivial" changes, unicode/homoglyph tricks. Release gate: **zero false-preserve** across the corpus. Runs in CI on every prompt or gate change.

### 8.4 Prompt-as-code
`model/prompt.ts` is control logic. Any change triggers the full eval + adversarial suite in CI and requires review. Prompt version is stamped into every audit event.

---

## 9. Deployment

### 9.1 Topology
Fits the existing GitOps component model (deploy as a `components/approval-freshness-engine/` opt-in on the shared-services hub, or the platform cluster that already terminates GitHub webhooks).
- Webhook receiver: 2+ replicas behind the platform's internal/External ingress (public path required for GitHub → receiver; terminate TLS at the edge, verify HMAC at the app).
- Worker: same process for P0 (in-proc queue); split to SQS-backed workers for HA.
- Secrets: App private key + webhook secret via ESO → Secrets Manager (Pod Identity), never in Git.
- Model access: Bedrock via Pod-Identity IAM role (in-boundary, preferred) OR Anthropic API key via ESO (zero-retention tier). Chosen in P0 per data policy.

### 9.2 Helm values (sketch)
```yaml
replicaCount: 2
image: { repository: ghcr.io/<org>/approval-freshness-engine, tag: <pinned> }
serviceAccount: { name: afe }   # Pod Identity → afe-role (Bedrock + Secrets)
ingress: { enabled: true, host: afe.internal.<domain>, path: /webhook }
env:
  MODEL_PROVIDER: bedrock          # or anthropic
  MODEL_ID: <model>
externalSecrets:
  - name: afe-github-app           # app_id, private_key, webhook_secret
config:                            # denylist/thresholds mounted from ConfigMap (Git)
  denylistConfigMap: afe-denylist
observability:
  logsTenant: audit                # Loki audit tenant
  metricsEnabled: true
```

### 9.3 Rollout gates (from the epic, restated as ship criteria)
- **P0** read-only backfill → the % number. No write scopes granted yet.
- **P1** shadow: full ladder, decisions logged, **actuator disabled** (`DRY_RUN=true`). Build golden set. Gate: Stage-1 precision ≥95% vs labels; Stage-2 false-preserve = 0 within gates.
- **P2** deterministic-only live on 3–5 pilot repos (Stage 2 still shadow). Gate: zero incidents; re-review requests drop.
- **P3** Stage 2 live on pilots; weekly audit sampling begins. Gate: clean samples; healthy metrics.
- **P4** org rollout via ruleset; ADR merged; kill-switch drill performed once on purpose.

---

## 10. Observability & SLOs
Reuses the platform LGTM stack.
- **Metrics (Mimir):** `afe_decisions_total{stage,action,reason}`, `afe_stage2_invocations_total`, `afe_preserve_rate`, `afe_false_preserve_findings_total` (from audit sampling), `afe_model_latency_seconds`, `afe_model_cost_usd_total`, `afe_fail_closed_activations_total`, `afe_pending_reaped_total`, `afe_webhook_verify_failures_total`.
- **Logs (Loki audit tenant):** one structured event per decision (§src/audit fields).
- **Dashboard (Grafana):** decision funnel (how many resolved at each stage), preserve-rate trend, cost/PR, latency, fail-closed activations, audit-finding count.
- **Alerts:** engine error rate > X; fail-closed activation spike; anomalous preserve-rate swing (drift detector); webhook-verify failures (possible spoofing); model cost anomaly.
- **SLOs:** decision latency p95 < 30s; availability target 99.9% — but note availability is *not* safety-critical here: sustained downtime just means more PRs wait on a fresh human re-review via the fallback path (§7.2) instead of an automatic preserve, so an outage costs the *feature* (trivial-push preservation) and some throughput, never safety. false-preserve findings = 0 (hard).
- **Fail-safe & drift metrics:** `afe_fresh_approval_echo_total{source=engine|fallback_workflow}`, `afe_circuit_breaker_state`, `afe_current_mode{tier}`, `afe_ruleset_drift_alerts_total` (from the periodic `integration_id`/rule audit, §"deploy/rulesets/README.md" — a monitoring aid, not a safety mechanism, since the ruleset itself is what enforces) — the org must be able to see at a glance which tier it's operating in and whether the ruleset still matches what's in Git.

---

## 11. Runbook (summary — full in RUNBOOK.md)
- **Engine down (any duration):** nothing to do for safety — freshly-pushed enrolled PRs simply wait on the required check, exactly as they would for any other down check. Developers unblock themselves the same way native GitHub already asks: get a fresh approval on the current head SHA, which `fresh-approval-fallback.yaml` (running on GitHub's infra, independent of the engine) echoes to a green check. On-call is paged to fix the pod *at leisure* — never to unblock developers.
- **Model provider outage (engine still up):** circuit breaker trips to **Tier 2 deterministic-only** — Stage 0/1 keep preserving the safe buckets; everything else dismisses (native-equivalent). Auto-recovers when the provider returns.
- **False dismiss (engine too strict):** human just re-approves — same as today. Log a tuning ticket.
- **Suspected false preserve:** audit sampling or a report → pull the audit event (delta + verdict + gates) → if real, dismiss the class in the denylist immediately + add to adversarial corpus + post-mortem.
- **Prompt/threshold change:** PR → eval + adversarial suite must pass in CI → shadow one cycle if material → ship. Prompt version auto-stamped in audit.
- **Manual kill switch (any doubt):** a human un-enrolls the repo via the Git-reviewed ruleset `PUT` (§7.1) — instant return to fully native branch protection, org-wide or per-repo, no deploy, no automated equivalent.

---

## 12. Cost model (order-of-magnitude, validate in P1)
- Stage 0/1 are free (compute only). Stage 2 fires ONLY on real semantic changes on non-privileged paths — a minority of pushes.
- Per Stage-2 call: small input (semantic delta, not whole PR) + tiny JSON output + cached system prompt. Pennies per call at current pricing; batch/cache-friendly.
- Expected spend is dominated by how often real logic changes get re-pushed after approval — bounded and dashboarded (`afe_model_cost_usd_total`). If cost ever surprises, the size caps and prompt caching are the levers.

---

## 13. Acceptance criteria (definition of done)
- [ ] P0 number produced and socialized; security approved the approach.
- [ ] Unit coverage: Stage 0 100% branches; corroboration-gate property test green.
- [ ] Adversarial suite: zero false-preserve; wired into CI.
- [ ] Actuator proven (test) to have no approve path.
- [ ] Shadow-mode precision/false-preserve gates met (P1).
- [ ] Fail-safe verified by chaos test (kill the worker mid-decision → PR resolves to dismiss via reaper, never wedged in pending).
- [ ] Fail-closed fallback verified by chaos test: kill the engine entirely, confirm a freshly-pushed enrolled PR stays blocked (no `success` on the new head SHA), then confirm a fresh human approval submitted on that head unblocks it — with the engine still down — via `fresh-approval-fallback.yaml` alone.
- [ ] Kill-switch drill executed and documented (un-enroll a repo via the ruleset `PUT`; confirm native branch protection returns immediately; no automated re-enroll path exists to also verify).
- [ ] `integration_id` drift audit item: a scheduled check (`gh api /orgs/{org}/rulesets/{id}`) confirms the required check's `integration_id` still matches the engine's App and the rule set hasn't drifted from Git; alerting wired to `afe_ruleset_drift_alerts_total`.
- [ ] Dashboards + alerts live; audit events flowing to the 6-year tenant.
- [ ] ADR merged with invariants, precedent, compliance mapping, and the reversal conditions.

---

## 14. What could go wrong (pre-mortem, honest)
1. **`approved_sha` resolution edge cases** (squash/rebase histories, review on a since-rewritten commit). Mitigation: fail-closed on any ambiguity; extensive fixtures; this is the #1 correctness risk and gets the most test attention.
2. **Difftastic language coverage gaps** → more fall-through to Stage 2 than expected (cost/latency, not safety). Mitigation: measure coverage on your actual language mix in P0; treat unsupported as non-trivial.
3. **GitHub API rate limits** on busy orgs. Mitigation: installation-token scoping, conditional requests/ETags, per-repo concurrency caps, backoff.
4. **Ruleset interaction surprises** (classic branch protection vs rulesets vs CODEOWNERS all fighting). Mitigation: P0 mechanics memo validates the exact interaction on one repo before rollout.
5. **Model drift / provider version change** silently shifting verdicts. Mitigation: pinned model version; eval suite re-runs on any version bump; verdict distribution is dashboarded (drift alert).
6. **Scope-creep pressure** ("just let it approve the easy ones"). Mitigation: invariant #1 is chartered; changing it requires a new security review. Say no.
