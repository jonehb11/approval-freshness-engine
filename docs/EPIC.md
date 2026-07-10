# EPIC: Approval Freshness Engine (v2)
### Policy-based staleness determination for PR approvals — deterministic-first, AI-advised, fail-closed, and no machine ever approves anything

**Status:** v2 for security review · supersedes v1 · **Origin:** denial of "disable global dismissal" + Option-3 follow-up, revised per security feedback ("AI may prevent a dismissal; AI may never approve")
**Ask:** approve the P0 evidence spike (read-only, 2 weeks) and the phased rollout gates in §10.

---

## 0. Executive summary

Today, any commit pushed to an approved PR voids the human approval — including semantically null pushes (typo in a comment, formatting, a merge-base change caused by an *unrelated* PR landing first). The result is a re-review tax paid in reviewer fatigue and rubber-stamp second looks that audit well and verify nothing.

This epic replaces the *staleness test*, not the review requirement. A fail-closed engine evaluates every post-approval push through a three-stage ladder: **deterministic hard gates** (privileged paths → always dismiss), **deterministic semantic diffing** (provably-null deltas → preserve the human's approval), and only then an **AI impact classifier whose verdict is advisory** and honored solely when independent deterministic gates corroborate it. The engine's entire action space is {dismiss, do nothing}. It cannot approve. Every merged PR still carries a human approval; privileged surfaces get *more* guaranteed human attention than today, not less.

This is not a novel bet. It is the assembly of controls already standard at the largest and most security-sensitive engineering organizations (§1), applied to GitHub, which uniquely lacks the primitive.

---

## 1. Precedent & evidence (the "big companies already do this" section)

**1.1 Google / Android / Chromium — deterministic approval preservation is a decade-old default.**
Gerrit — the review system of the Android Open Source Project, Chromium, and much of the largest-codebase world — has native "sticky approvals": label copy conditions that carry review votes forward to a new patchset when the change kind is `TRIVIAL_REBASE`, `NO_CODE_CHANGE`, or `NO_CHANGE`. Per the official docs, trivial-rebase copying "can be used to enable sticky approvals, reducing turn-around for trivial rebases prior to submitting a change. **For the pre-installed Code-Review label this predicate is used by default.**"
→ https://gerrit-review.googlesource.com/Documentation/config-labels.html
**Implication for our meeting:** the *deterministic tier of this epic is Google's default behavior*. GitHub is the outlier for lacking it; the community has asked GitHub for an "intelligent dismiss stale approvals" for years (github.com/orgs/community/discussions/12876), and marketplace half-solutions exist (e.g., the "Dismiss stale approvals" Action that dismisses only when the diff changed).

**1.2 Meta — ML risk scoring already modulates review and ship decisions at hyperscale.**
Meta's published work (RADAR / Diff Risk Score, arXiv:2605.30208, 2026) describes an ML model that "predicts how likely a diff is to cause a negative outcome, primarily a production incident," originally built "to allow low-risk diffs to land during code freezes," now "a broader risk platform that powers approximately 20 risk-aware features across Meta, including accept-to-ship workflows, cherry-pick risk assessment… and reviewer recommendations for high-risk diffs."
→ https://arxiv.org/abs/2605.30208
**Implication:** machine-scored change risk gating human process — including *letting low-risk changes proceed under reduced ceremony* — is production reality at one of the most attacked companies on earth. Our Stage 2 is a conservative, corroborated version of the same idea.

**1.3 Google — ML already acts inside the review loop itself.**
Google's deployed comment-resolution system applies ML-suggested edits for ~7.5% of all reviewer comments, "reduc[ing] time spent on code reviews by hundreds of thousands of hours annually at Google scale."
→ https://research.google/blog/resolving-code-review-comments-with-ml/
**Implication:** ML participating in the review pipeline (with human accept/reject) is normalized at the highest tier of engineering rigor.

**1.4 Industry norm on scoped machine merges — stronger precedent than we're asking for.**
Thousands of organizations — including regulated ones — run Renovate/Dependabot **automerge** for scoped dependency classes (e.g., dev-dependency patch bumps with green CI): changes that merge with *no human review at all*, justified by class-scoping + test gates (see Renovate's automerge docs: docs.renovatebot.com/key-concepts/automerge/). We are asking for strictly less: our engine never merges anything and never approves anything; a human approval must already exist on the PR.

**1.5 The AI line we keep is the industry's line.**
Every major AI code-review deployment today (GitHub Copilot code review, CodeRabbit, Greptile, etc.) is advisory: none satisfies a required-approval gate. Our invariant #1 (AI never approves) conforms to — not fights — current industry practice.

**1.6 GitHub is actively building governance in this exact area — this month.**
GitHub's July 7, 2026 changelog GA'd a ruleset option to "Restrict who can dismiss reviews" to named users, teams, and GitHub Apps. We use it as a hardening brick (§6.4): on enrolled repos, dismissal authority is restricted to the engine's App + admins, closing the "any write-access user dismisses/games reviews" hole — a control we could not have written ourselves.

**1.7 One precision from GitHub's own docs that strengthens the business case.**
Dismissal is diff-state-based: GitHub "records the state of the diff at the point when a pull request is approved" and dismisses when that diff changes — **including when the merge base changes because an unrelated PR merged first** (docs.github.com, About protected branches). A meaningful share of our dismissals are therefore triggered by *other people's merges*, invalidating reviews of PRs whose own content never changed. Stage 1 resolves that class perfectly and deterministically.

---

## 2. Security invariants (non-negotiable, chartered)

1. **No machine approvals, ever.** No bot, App, workflow, or model submits an approving review. (v1's "agent re-approves" design is withdrawn.)
2. **Conservative action space.** Engine outputs ∈ {dismiss human approval, take no action}. There is no output that grants access. Worst-case malfunction ≡ today's behavior (a stale approval dismissed → human re-review), never code merged without review.
3. **Fail safe to the status quo.** Any failure — engine error, timeout, model outage, full crash — degrades to GitHub's *native* dismiss-stale behavior (the org's current control), automatically. A per-PR reaper resolves lost jobs to dismiss; a circuit breaker keeps deterministic preservation alive during model outages; and an independent dead-man switch on GitHub's own infrastructure auto-reverts the ruleset to native if the engine dies. No failure path blocks merges on engine uptime, and none fails open.
4. **Deterministic gates outrank the model.** The privileged-path denylist (`*.tf`, `**/prod/**`, `.github/workflows/**`, CODEOWNERS-protected paths, IAM/policy files, dependency manifests, CI config) is evaluated in plain code before any model call; a denied path can never be preserved regardless of model output.
5. **Model output is data, not action.** Stage 2 returns a structured verdict consumed by the rules engine; the model holds no credentials, no tools, no write access.
6. **Immutable, complete audit trail.** Every synchronize event logs delta, stage verdicts, model prompt+response when invoked, final decision, actors, timestamps → Loki `audit` tenant (6-year class).
7. **Kill switch + automatic dead-man.** One ruleset flip restores native blanket dismissal org-wide in minutes; the dead-man switch performs exactly this flip automatically when the engine is unhealthy. The engine is additive and removable.
8. **First approval is always human, on the PR being merged.** The engine only ever concludes "the thing the human approved is, in substance, still the thing being merged."

---

## 3. Why this control is *stronger* than the human re-review it replaces

Claiming automation "beats human review" in general would be dishonest. The claim we can defend — and should make loudly — is narrower and true: **this control outperforms the specific human activity it replaces: the fatigued second-pass re-approval of an already-reviewed PR.** Dimension by dimension:

| Dimension | Status-quo re-review | Approval Freshness Engine |
|---|---|---|
| **Coverage** | Reviewer *may* re-read; in practice skims or rubber-stamps (measure it: P0 reports the org's median dismissal→re-approval interval; if it's minutes, the current control is already ceremony) | 100% of post-approval pushes get a byte-exact semantic comparison, every time, including 3am Friday |
| **Consistency** | Varies with fatigue, deadline pressure, seniority, social dynamics | Same ladder, same gates, same thresholds, every event; drift impossible without a Git change |
| **Blind spots** | Merge-base dismissals routinely re-approved without examining what the base change *did* | Stage 1 computes exactly what changed vs. the approved state — including the merge-base case — and shows its work |
| **Evidence** | An "LGTM" with no record of what was examined | Machine-checkable rationale per decision: difftastic report or model verdict + corroborating gate results, immutably logged |
| **Latency** | Hours–days of queue time; context-switch cost on the reviewer | Seconds; reviewers interrupted only when substance changed |
| **Privileged surfaces** | Same fatigued process as everything else | *Categorically* human — and reviewed by humans with more attention available, because the null re-reviews stopped consuming it |
| **Adversarial pressure** | Social engineering works on tired humans ("it's just a typo fix, can you re-approve?") | Gates don't take Slack messages; the "just a typo" claim is verified, not trusted |
| **Auditability of the control itself** | Unmeasurable | Preserve/dismiss rates, false-preserve audit findings, and every threshold are dashboards |

Where humans remain irreplaceable — judgment about *intent, design, and fitness* — is exactly where the engine routes work: the first review (untouched) and every substantive or privileged delta (guaranteed). The engine doesn't reduce human review; it **reallocates it from ceremony to substance.** That's the sentence for the security meeting.

---

## 4. Architecture — the decision ladder

Trigger: `pull_request.synchronize` on a PR that currently has ≥1 non-stale human approval. Runs as a **GitHub App** (fine-grained perms: `pull_requests: write` for the dismiss API + comments only; `checks: write`; `contents: read`). No PATs, no org-admin token.

```
Push to an approved PR ──► emit `approval-freshness/evaluated` = pending (blocks merge)
        │
        ▼
┌─ STAGE 0 · HARD RULES (deterministic, no model) ───────────────────────────┐
│ Dismiss immediately if ANY:                                                │
│  • changed files ∩ denylist ≠ ∅  (*.tf, **/prod/**, .github/workflows/**,  │
│      CODEOWNERS-protected, IAM/*.json, **/secrets/**, dependency manifests)│
│  • force-push / history rewrite / base branch changed                      │
│  • new commits authored by someone other than the PR author                │
│  • diff contains injection-shaped strings targeting the classifier         │
│      (belt-and-suspenders; Stage 2 never sees these)                       │
└────────────────────────────────────────────────────────────────────────────┘
        │ not dismissed
        ▼
┌─ STAGE 1 · DETERMINISTIC SEMANTIC DIFF (difftastic; no model) ─────────────┐
│ Compare last-approved SHA … new HEAD (AST-aware, 30+ languages).           │
│ PRESERVE (no action) if:                                                   │
│  • AST-identical (whitespace / formatting / comment-only), OR              │
│  • only files in allowlisted trivial classes (*.md, lockfile-only from a   │
│      bot commit, generated files matching a hash rule), OR                 │
│  • merge-base-only change: the PR's own delta vs approved state is empty   │
│ Post evidence comment: "0 semantic changes since @reviewer's approval      │
│  [difftastic report]".  ← handles the majority + the merge-base class      │
│ Unsupported language / any ambiguity ⇒ fall through (fail-closed)          │
└────────────────────────────────────────────────────────────────────────────┘
        │ real semantic change
        ▼
┌─ STAGE 2 · AI IMPACT CLASSIFIER (advisory only; scoped) ───────────────────┐
│ Claude classifies the SEMANTIC DELTA ONLY (not the whole PR) against a     │
│ versioned blast-radius rubric → {impact: low|high, reasons[], confidence}. │
│ PRESERVE only if impact=low AND ALL deterministic corroboration gates pass:│
│   size ≤ N lines, ≤ M files, no new deps, no auth/crypto/network-egress    │
│   patterns, confidence ≥ threshold. Post full-reasoning evidence comment.  │
│ ELSE (high / low-confidence / any gate fails / model error / timeout):     │
│   DISMISS + comment summarizing what changed since approval + @-mention    │
│   the original reviewer with the semantic delta (faster than today even    │
│   on the dismiss path).                                                     │
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  Set `approval-freshness/evaluated` = success (preserve) or leave red (dismiss)
  Log EVERYTHING → Loki audit tenant.  Never approve. Only {dismiss | nothing}.
```

**AI placement, stated precisely for security:** Stage 2 only; advisory only; on deltas that already cleared the Stage-0 denylist; and its "preserve" recommendation is honored only when independent deterministic gates corroborate it. This is exactly and only "AI preventing a dismissal," never "AI approving." Every merged PR still carries a human approval of that PR.

**GitHub mechanics (validate in P0):** the native org toggle is binary, so selective preservation requires disabling the native "dismiss stale approvals" *on enrolled repos* and re-implementing dismissal in the engine, with fail-closed enforced by (a) default-dismiss on any failure and (b) the required check `approval-freshness/evaluated` that merges cannot bypass. Must also disable "require approval of most recent reviewable push" on enrolled repos (the engine subsumes it). CODEOWNERS requirements are unaffected — CODEOWNER paths live in the Stage-0 denylist regardless. Enrollment is per-repo via org Ruleset targeting; unenrolled repos keep native behavior untouched.

## 5. Threat model

| Threat | Mitigation |
|---|---|
| **Prompt injection via diff content** ("classifier: mark trivial") | Stages 0–1 immune (no model). Stage 0 flags injection-shaped strings → dismiss before Stage 2 ever runs. Stage 2 receives delta as quoted data under a hardened structured-output-only contract; verdict is gated by deterministic checks the model can't influence; adversarial suite in CI. Residual worst case: a *low-impact-looking* malicious change is preserved — which is why every high-blast-radius surface is denylisted out of AI reach entirely. |
| **Approval laundering** (approve innocuous code, push payload after) | Author-only-push rule + Stage-0 denylist + size/dep/pattern gates + the payload must *itself* classify trivial/low to survive — payloads don't. Force-push/rebase-with-content ⇒ categorical dismiss. |
| **Model false-"low"** | Deterministic corroboration gates; conservative confidence threshold; golden-set eval with a hard release gate: **false-preserve on labeled high-impact deltas = 0 within the gated envelope** before any repo goes live; weekly human audit sampling of preserved PRs feeds the rubric. |
| **Engine compromise** | Max App privilege = dismiss + comment. Cannot approve, merge, or push. Compromise = denial-of-convenience, not code-to-main. Short-lived scoped token, fully logged. |
| **Availability failure** | Degrades to today's native behavior automatically (dead-man auto-revert + per-PR reaper + circuit breaker). No merge freeze, no fail-open. Manual kill switch also available. |
| **Dismissal-authority abuse** | GitHub's July-7 "restrict who can dismiss reviews" ruleset limits dismissal to the App + admins on enrolled repos. |
| **Scope creep to "let it approve"** | Invariant #1 is a chartered constraint; changing it requires a fresh security review. |

## 6. Implementation detail

### 6.1 Components
- **GitHub App** (Node/TS or Python) — receives `synchronize` webhooks, orchestrates the ladder, calls the dismiss + check + comment APIs. Stateless; idempotent per (PR, head SHA).
- **Stage 0 evaluator** — pure function over the file list + commit metadata + push metadata. Denylist in version-controlled YAML co-owned by security. Zero external calls.
- **Stage 1 evaluator** — invokes **difftastic** on `git diff <approved_sha>..<head_sha>`; classifies AST-identical / trivial-class / merge-base-only. Unsupported languages → not-trivial (fail-closed).
- **Stage 2 classifier** — single Claude API call, structured output (JSON schema, no tools, no loop — a *workflow*, not an agent). Rubric-in-prompt versioned in Git; **prompt changes go through PR review like code, because the prompt is control logic.** System prompt cacheable; data (the delta) passed as clearly delimited untrusted content.
- **Corroboration gate** — pure function over (model verdict, delta stats): size/file caps, new-dependency detection, auth/crypto/egress pattern scan, confidence threshold. Deterministic; overrides the model.
- **Audit logger** — structured event → Loki audit tenant; metrics → Mimir; dashboard in Grafana from day one.

### 6.2 The required status check (the fail-closed hinge)
Enrolled-repo ruleset requires `approval-freshness/evaluated`. Engine sets it `pending` on every synchronize, then `success` only on a preserve decision. Dismiss decisions leave it non-green (merge blocked pending fresh human approval — identical to today's outcome). If the engine is briefly down, a fresh push waits on the pending check for minutes; if it's *sustained* down, the dead-man switch auto-reverts the ruleset to native (removing the required check) so merges flow under today's rules. The required check gates *individual freshly-pushed PRs* momentarily — it never freezes the org on engine health. This is what makes the fallback the status quo, not an outage.

### 6.3 Data-boundary handling (Stage 2)
Diffs leave the repo boundary to the model API. Options in preference order: (a) **Amazon Bedrock in-VPC / in-boundary endpoint** if data policy requires no third-party transit — recommended default given the gov/HIPAA-adjacent posture; (b) Anthropic API with zero-retention terms. Confirm the acceptable tier with security/compliance in P0. Denylisted paths never reach Stage 2, so the most sensitive files never transit regardless.

### 6.4 Dismissal-authority hardening
On enrolled repos, apply GitHub's ruleset "restrict who can dismiss reviews" → {engine App, repo admins} only. Audit trio quarterly: who can approve, who can dismiss, who can bypass the ruleset.

## 7. Observability (it watches itself)
Every decision is a structured log line → Loki audit tenant. Metrics → Mimir: `af_decisions_total{stage,action}`, preserve-rate, false-preserve-audit-findings, stage-2 invocation rate, model latency, model cost/PR, engine availability. Grafana dashboard + alerts (engine error rate, fail-closed activations, anomalous preserve-rate swing) ship with P2. This reuses the observability platform you're already building — the engine is just another instrumented workload, and its audit log is the artifact the security auditor actually wants.

## 8. The audit narrative (hand this verbatim to security/compliance)

> "Every change merged to a protected branch carries an approving review from an authorized human — unchanged. What changes is the *staleness test* applied to that review. The legacy test is temporal: any subsequent commit voids the review regardless of content, and it is simultaneously too strict (voiding reviews of unchanged content when an unrelated PR moves the merge base) and unverifiable (a fatigued re-approval satisfies it). The new test is evidential and fail-closed: an automated control compares the approved revision to the current revision; the review is voided unless the difference is proven semantically null by deterministic AST comparison, or assessed low-impact on non-privileged paths by a model whose recommendation is deterministically corroborated and fully logged. No automated component can create or restore an approval. All privileged paths — infrastructure-as-code, production configuration, CI/CD, access control — categorically require fresh human review. Every determination is logged immutably with its full evidence chain and is subject to weekly human audit sampling. In every branch, the control's failure mode is to require additional human review, never less. This mirrors deterministic approval-preservation shipped by default in Gerrit (Android/Chromium) and machine change-risk gating deployed in production at Meta."

Framing for the auditor's ear: this is **automated change-impact analysis feeding a review-validity control** — an established concept (see Meta DRS, Gerrit sticky approvals) — not "AI approving code."

## 9. Compliance mapping (fill in your frameworks)
- **SOC 2 CC8.1 (change management):** control operates on every change; evidence is the immutable decision log; privileged changes retain mandatory human authorization. The *automated* determination + human-sampling audit is a stronger, more consistently-applied control than discretionary re-review.
- **FedRAMP / NIST 800-53 CM-3 (change control) & CM-4 (impact analysis):** the engine *is* documented, repeatable impact analysis on every change — arguably closer to CM-4's intent than ad-hoc human judgment.
- **HIPAA §164.312(b) (audit controls):** complete, immutable, queryable decision log in the 6-year audit tenant.
- Confirm which apply to *our* auditors so the ADR speaks their dialect (open question §11).

## 10. Delivery plan & gates

| Phase | Scope | Exit gate |
|---|---|---|
| **P0 — Evidence + mechanics (2 wk, READ-ONLY)** | GitHub App skeleton; run difftastic + Stage-0 classification over **last 90 days of synchronize events org-wide, taking no action**. Produce THE NUMBER: "X% of last quarter's dismissals were semantically null (incl. Y% merge-base-only)." Validate dismiss API, required-check, ruleset targeting, dismissal-restriction interplay. Confirm Stage-2 data boundary with compliance. | Number + mechanics memo in hand; security reviews approach before any write access |
| **P1 — Shadow (2–3 wk)** | Full ladder incl. Stage 2 running on live events, **logging decisions only, taking no action.** Build golden eval set from labeled historical deltas. | Stage-1 precision ≥95% vs hand labels; Stage-2 false-preserve = 0 on high-impact labels within gates; security reviews shadow logs |
| **P2 — Deterministic-only LIVE, pilot repos (2 wk)** | Stages 0–1 active on 3–5 volunteer repos; Stage 2 still shadow. Dashboards + alerts live. | Zero incidents; re-review-request metric drops; security sign-off to proceed |
| **P3 — Stage-2 LIVE on pilots (3–4 wk)** | AI-advised preservation within gates; weekly audit-sampling ritual begins (security-owned queue). | Audit samples clean; metrics healthy (preserve-rate, time-to-merge delta, cost/PR) |
| **P4 — Org rollout + ADR** | Ruleset-driven enrollment; runbook; **perform the kill-switch drill on purpose once.** | ADR merged incl. invariants + precedent + compliance mapping; security owns audit cadence |

**KPIs:** % post-approval pushes auto-resolved (target: majority via Stage 1 alone), re-review latency, reviewer interruptions/week, false-preserve audit findings (hard target 0), engine availability, $/decision.

## 11. Open questions for the security working session
1. Ratify the invariant set (§2) as chartering constraints.
2. Denylist contents — security co-owns; propose starting maximal and relaxing with evidence.
3. Audit-sampling rate + owner (propose 10% of preserved PRs weekly, security-owned, engine-provided queue).
4. Which compliance frameworks bind us (SOC 2 / FedRAMP / HITRUST / HIPAA) so the ADR + §9 speak their dialect.
5. Stage-2 data boundary: Bedrock in-boundary vs. zero-retention API — decide before P1.
6. Bypass-actor policy on enrolled repos (admins, ruleset bypass list) — who can defeat the required check, and is that acceptable.

---
*Precedent sources: Gerrit config-labels docs (sticky approvals, default-on); Meta RADAR/Diff Risk Score (arXiv:2605.30208); Google ML comment resolution (research.google); Renovate automerge docs; GitHub rulesets + protected-branches docs incl. the 2026-07-07 dismissal-restriction changelog. Retrieved July 2026.*
