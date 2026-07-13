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
`pull_request` (actions: `synchronize`, `ready_for_review`, `reopened`), `pull_request_review` (to recompute on new approvals), `push` (defense-in-depth for edge cases). Webhook secret verified on every request (§4.1).

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

### 4.3 Fail-safe design — degrade to the status quo, never to a merge freeze

**Design principle (corrected):** "fail-closed" here means **fall back to GitHub's native behavior (blanket dismiss-stale)** — the org's *current* control — NOT "block every merge until an engineer fixes the bot." A design where merges are hostage to the engine's uptime is a worse failure mode than the status quo and is explicitly rejected. The safe fallback is *today's behavior*, reached automatically, with no human in the loop.

This is enforced by a **three-tier degradation ladder**, each tier independent of the one above it so a failure can't take its own fallback down with it:

**Tier 1 — Healthy.** Full ladder (Stage 0/1/2). Trivial/null pushes preserved; substantive/privileged pushes dismissed. Normal operation.

**Tier 2 — Model degraded, engine up (circuit breaker).** If the model provider errors/times out repeatedly, the engine trips a circuit breaker into **deterministic-only mode**: Stage 0 and Stage 1 still run, so the largest and safest buckets (whitespace/formatting/comment-only, merge-base-only, trivial-class) are *still preserved* with zero re-review noise. Anything that would have needed Stage 2 falls back to **dismiss** (native-equivalent: stale approval dismissed → human re-review). Most of the value survives a model outage.

**Tier 3 — Engine down (dead-man auto-revert).** If the engine is genuinely down (not a blip), an **independent dead-man switch running on GitHub's own infrastructure** — not on our cluster — automatically reverts the enrollment ruleset back to the **native configuration**: native dismiss-stale ON, the required check REMOVED. The org is instantly back to exactly today's behavior, org-wide, with nobody paged to unblock developers. See §7.2 for the mechanism.

**Why the required check does NOT cause a freeze:** the required check `approval-freshness/evaluated` blocks a *freshly-pushed* PR only for the brief window between the push and either (a) the engine's verdict, or (b) the dead-man reverting the ruleset (which removes the required check entirely). The exposure window is bounded by the dead-man threshold (§6.5 `deadmanRevertMinutes`, ~20–25m worst case including GitHub cron drift), after which the check requirement is gone and merges flow under native rules. There is **no state in which merges are blocked indefinitely on the engine's health.**

**The pending marker + reaper still exist, but their job changed.** The engine still writes `approval-freshness/evaluated = pending` on receipt (so a new SHA never inherits an old SHA's green check). A per-PR reaper still catches individually lost jobs — but its action for a stuck-pending PR is now to **dismiss the stale review AND resolve the check** (i.e., reproduce native behavior for that one PR: stale → re-review required), never to leave it wedged in `pending`. Silence resolves to *today's outcome*, not to a hang.

**Direction of every failure, stated for the security review:** every degradation path lands on **dismiss-and-require-human-re-review (= the current control)** or on **native blanket dismissal (= the current control)**. No path lands on "merge without re-review" (fail-open) and no path lands on "merge frozen on bot health" (self-inflicted outage). The failure mode of this system is *the status quo returns.*

### 4.4 Peer Override (Zero-Outage Escape Hatch)
If the engine crashes, the required check `approval-freshness/evaluated` remains `pending`, keeping the repo safe but blocking merges. To prevent developer outages without requiring admin intervention, the system provides a decentralized, peer-driven escape hatch via a reusable GitHub Action.
- **The Mechanism:** A developer blocked by an outage pings a peer. The peer reviews the code and comments `/override-freshness` on the PR.
- **The Validation:** A GitHub Action (running on GitHub's highly-available infra) intercepts the comment. It verifies the commenter is an authorized engineer and explicitly **rejects the override if the commenter is the PR author**.
- **The Resolution:** If valid, the Action API-forces the `approval-freshness/evaluated` check to `success`.
- **Security Posture:** Mathematically guarantees a second human review during an outage, preventing self-bypass while eliminating the need for 2AM pages to admins. Enrolled repos inherit this by invoking the central `peer-override-reusable.yaml`.

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
│   │   └── actuator.ts          # check-run + dismiss + comment (the ONLY writer)
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
│   └── terraform/              # App secret, SQS (HA), IAM/Pod-Identity
├── docs/
│   ├── IMPLEMENTATION-PLAN.md   # this file
│   ├── RUNBOOK.md
│   └── SECURITY-REVIEW.md       # one-pager for the meeting
└── .github/workflows/ci.yaml
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
stale_pending_timeout   = 15m     # per-PR reaper: lost job → dismiss + resolve check (native-equiv)
circuit_break_after     = 5       # consecutive model failures → Tier 2 deterministic-only mode
circuit_reset_after     = 5m      # cooldown before re-testing the model provider
deadman_canary_sla_min  = 10      # canary must be evaluated within this window
deadman_fail_count      = 2       # consecutive canary misses before auto-revert (hysteresis)
deadman_revert_minutes  = 25      # worst-case detect+revert budget incl. GitHub cron drift
```

**Two distinct timeouts — do not conflate:** `model_timeout_ms` (~8s) bounds a *single* Stage-2 API call and fires constantly/harmlessly (that PR dismisses). `stale_pending_timeout` (~15m) and the dead-man thresholds (~25m) answer "how long before we conclude the engine itself is unhealthy and fall back to native," and fire rarely. The first handles a slow model; the second handles a dead engine.

---
## 7. GitHub enrollment (per-repo, via Ruleset)

Enrollment is deliberately explicit and reversible (kill switch = un-enroll).

### 7.1 The two ruleset configurations (defined in Git, applied per repo)

There are exactly two states an enrolled repo's default-branch ruleset can be in. The dead-man switch (§7.2) swaps between them automatically.

**"Enrolled" configuration (engine active):**
1. Require a pull request before merging; require ≥1 approving review (unchanged).
2. **Disable** native "Dismiss stale pull request approvals when new commits are pushed" — the engine now owns staleness (this is what lets the engine *preserve*; it's also why we can't just leave native dismissal on as a backstop — native dismissal firing on every push would leave the engine no way to say "keep it," and the engine can't re-approve).
3. **Disable** "Require approval of the most recent reviewable push" — subsumed by the engine.
4. **Require status check** `approval-freshness/evaluated`.
5. **Restrict who can dismiss reviews** → {engine App, repo admins} (the July-2026 ruleset control).
6. Keep CODEOWNERS requirements as-is (independent; also denylisted).
7. Bypass list: empty or admins-only, documented (§security open Q6).

**"Native" configuration (fallback = today's behavior):**
- **Enable** native "Dismiss stale pull request approvals when new commits are pushed."
- **Remove** the required check `approval-freshness/evaluated`.
- Everything else unchanged.

**Both changes must be applied atomically in one ruleset-update API call.** Re-enabling native dismissal without removing the required check would leave the dead bot's never-green check still blocking merges — reinventing the freeze. Removing the check without re-enabling native dismissal would fail *open*. The pair must move together.

**Unenrolled repos:** never touched — permanently on the native configuration. Rollout is repo-by-repo.

### 7.2 The dead-man switch — automatic revert to native when the engine dies

The mechanism that guarantees "if anything fails, the org's original control comes back automatically, with no merge freeze and no human paged." **It runs on GitHub's own infrastructure (a scheduled Actions workflow in a locked-down ops repo), so it cannot die with the engine.**

**Health detection = synthetic canary (not a heartbeat).** A scheduled workflow (~every 10 min) pushes a trivial commit to a standing PR in a dedicated **canary repo** enrolled exactly like a real one, then verifies the engine set `approval-freshness/evaluated` on the new head SHA within the SLA. This proves the *entire path* works — webhook delivery → queue → evaluation → actuation — which a `/healthz` ping cannot. (The canary's own pushes double as keep-alive so GitHub doesn't auto-disable the scheduled workflow after 60 days of inactivity.)

**Revert behavior (with hysteresis, one-directional):**
- Canary unmet **twice consecutively** (state persisted in a repo variable — one 30-second pod restart must not trip it) → the workflow PATCHes the org ruleset to apply the **"native" configuration** to all enrolled repos, pages on-call (PagerDuty), and opens an incident issue with the canary evidence.
- **Revert is automatic; re-enrollment is always a human action** — a `workflow_dispatch` behind an environment-protection approval, run only after the engine is verified healthy. Auto-revert + auto-re-enroll would flap the org's branch protection on every blip. Never automate the re-enroll direction.

**Credential note (for security):** ruleset updates need an org-ruleset-write credential — the most powerful secret in the system. It lives only in the ops repo's environment secrets, and its *only* automated action is to restore the **stricter** native control. It is a fail-safe credential, not an escalation credential: a thief's maximum power is turning strict dismissal *back on*. Every ruleset change also lands in GitHub's org audit log. (Verify exact API scope — org vs repo ruleset endpoints — in the P0 mechanics memo.)

**Residual exposure:** GitHub cron drifts under load, so worst-case detect-and-revert is ~20–25 min (`deadmanRevertMinutes`, §6.5). During that window, enrolled PRs with a *fresh post-approval push* wait on the pending required check; already-green PRs are unaffected. After revert, everything flows under native rules. If GitHub Actions itself is down, the dead-man can't fire — but then GitHub is broadly degraded and nobody's merging anyway; the manual kill switch (below) covers truly bizarre cases.

**Manual kill switch:** the same ruleset swap, run on demand by a human — instant return to native, org-wide, no deploy. The dead-man is just this, automated.

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
- **SLOs:** decision latency p95 < 30s; availability target 99.9% — but note availability is *not* safety-critical here: sustained downtime auto-reverts to native behavior (§7.2), so an outage costs the *feature* (trivial-push preservation), never safety and never developer throughput. false-preserve findings = 0 (hard).
- **Dead-man metrics:** `afe_canary_success`, `afe_deadman_reverts_total`, `afe_circuit_breaker_state`, `afe_current_mode{tier}` — the org must be able to see at a glance which tier it's operating in.

---

## 11. Runbook (summary — full in RUNBOOK.md)
- **Engine down (brief blip, < ~15m):** freshly-pushed enrolled PRs wait briefly on the pending check; already-green PRs unaffected. Engine recovers, evaluates the backlog. No action needed.
- **Engine down (sustained):** the dead-man switch (§7.2) auto-reverts the ruleset to **native** after two consecutive canary misses (~20–25m worst case). Org returns to today's behavior automatically; on-call is paged to fix the engine *at leisure* — developers are NOT blocked and NOBODY is paged to unblock them. After the engine is healthy, a human re-enrolls via the approval-gated `workflow_dispatch`. **Merges never freeze on engine health.**
- **Model provider outage (engine still up):** circuit breaker trips to **Tier 2 deterministic-only** — Stage 0/1 keep preserving the safe buckets; everything else dismisses (native-equivalent). Auto-recovers when the provider returns.
- **False dismiss (engine too strict):** human just re-approves — same as today. Log a tuning ticket.
- **Suspected false preserve:** audit sampling or a report → pull the audit event (delta + verdict + gates) → if real, dismiss the class in the denylist immediately + add to adversarial corpus + post-mortem.
- **Prompt/threshold change:** PR → eval + adversarial suite must pass in CI → shadow one cycle if material → ship. Prompt version auto-stamped in audit.
- **Manual kill switch (any doubt):** run the ruleset swap to native on demand — instant return to today's behavior, org-wide, no deploy.

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
- [ ] Dead-man verified by chaos test (take the engine fully down → canary fails twice → ruleset auto-reverts to native within budget → merges flow under native rules; re-enroll requires human approval).
- [ ] Kill-switch drill executed and documented.
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
