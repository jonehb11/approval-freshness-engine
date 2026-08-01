# Rollout Plan — Approval Freshness Engine

*The definitive migration plan: how this engine goes from "a repo full of code and a security*
*review" to "org-wide enrollment", in five gated phases, each with an explicit way out.*

*Companion documents: [EPIC.md](EPIC.md) §10 (delivery plan & gates — the source of the phase*
*definitions restated here), [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) §9.3 (the same gates*
*as ship criteria) and §7 (enrollment mechanics), [SECURITY-FOLLOWUPS.md](SECURITY-FOLLOWUPS.md)*
*(the P3 custody decision), [RUNBOOK.md](RUNBOOK.md) (operating it once live),*
*[../README.md](../README.md) (the merge equation, the deploy runbook, and the live drill).*

**This document adds detail to the phase gates already agreed in EPIC §10 and*
*IMPLEMENTATION-PLAN §9.3. It does not change them.** Where this plan states a number the epic
did not (the P0 kill threshold, the P1 agreement-rate target), it is proposed here for
ratification, and is flagged as such.

---

## 0. The one-page version

| Phase | What is live | Blast radius | Duration | Gate to exit |
|---|---|---|---|---|
| **P0 — Evidence** | Nothing. A read-only script runs against history. | Zero — no App writes, no ruleset, no repo changed. | 2 wk | **GO/KILL on the number** + mechanics memo + security approves the approach |
| **P1 — Shadow** | Engine pod receives live events, logs decisions, writes nothing (`DRY_RUN=true`). | Zero — still no ruleset, native GitHub behavior unchanged. | 2–3 wk | Agreement rate + zero shadow false-preserves; security reviews the shadow logs |
| **P2 — Deterministic live** | Stages 0–1 enforcing on 3–5 volunteer repos. Stage 2 still shadow. | 3–5 repos, opt-in, reversible in minutes. | 2 wk | Zero incidents; re-review burden measurably down; security sign-off |
| **P3 — Stage 2 live** | Full ladder on the same pilot repos. Weekly audit sampling begins. | Same 3–5 repos. | 3–4 wk | Clean audit samples; healthy metrics; **custody decision signed off** |
| **P4 — Org rollout** | Enrollment by ruleset targeting, repo by repo or by custom property. | Grows deliberately, never automatically. | Ongoing | ADR merged; kill-switch drill performed on purpose; security owns the audit cadence |

**The through-line:** every phase is reversible by a single human GitOps action, and the thing
being rolled out is *additive*. Nothing is installed into a repo that has to be uninstalled — the
only per-repo artifact in the entire system is one optional workflow file (see §1.2).

---

## 1. Rollback — read this before reading the phases

Rollback is not a phase-specific procedure. It is the same three moves at every phase, and it is
the reason the phased plan can move as fast as it does.

### 1.1 The three moves

| Move | Action | Effect | Time |
|---|---|---|---|
| **Un-enroll one repo** | Remove the repo from the org ruleset's target list (or drop its `afe-enrolled` custom property) and `PUT` the ruleset via the normal Git-reviewed process. | That repo instantly loses the engine's gate; pair with re-enabling native stale-dismissal (see the two-step caution below) to return to the pre-enrollment posture. | Minutes |
| **Delete / deactivate the ruleset** | Delete the org ruleset, or set `enforcement` to `disabled`, via the same GitOps path. | *Every* enrolled repo instantly loses the engine's gate; the same pairing applies to each (two-step caution below). | Minutes |
| **Stop the engine** | Scale the deployment to zero, or just let it stay down. | Enrolled repos stay **blocked** (fail-closed); individual PRs still clear with a fresh human approval on the current head **if** the fallback workflow is deployed (Option A, §6.3) — otherwise they wait for the pod or an org owner's break-glass. This is a safety-neutral move, not a rollback — see the caution below. | Seconds |

Un-enrollment mechanics, verbatim from the settled architecture: GitHub's ruleset update endpoint
is **`PUT`, not `PATCH`** — it replaces the whole ruleset object. See
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) §7.1, [RUNBOOK.md](RUNBOOK.md) "Manual kill
switch", and [../deploy/rulesets/README.md](../deploy/rulesets/README.md).

> **Caution — "back to native" is a two-step move, not one.** Enrollment required switching
> native "Dismiss stale pull request approvals" (and "Require approval of the most recent
> reviewable push") **off** on the repo (README step 4.3). Removing the repo from this ruleset
> does not switch them back on, so an un-enrollment that stops there leaves the repo with
> *neither* staleness control — strictly weaker than before enrollment
> ([FAILURE-MODES.md](FAILURE-MODES.md) §4.1). Every un-enrollment in this plan means: repo out
> of the ruleset **and** native stale-dismissal re-enabled wherever it previously lived, in the
> same change. The runbook's kill-switch procedure states the same pairing.

> **Caution — "stop the engine" is not a rollback.** Killing the pod does not restore native
> behavior; it leaves enrolled PRs blocked on a check that will not report. That is safe (it is
> the designed fail-closed state) but it is not a rollback, and on-call must not be told it is
> one. **The only true rollback is a ruleset change.** This distinction is the single most
> commonly misunderstood thing about this system; put it in the on-call handoff.

### 1.2 What has to be uninstalled from repos: almost nothing

This matters more than it sounds, because it is what makes enrollment cheap and un-enrollment
credible.

- **Almost no branch-protection surgery.** Enrollment is primarily a matter of whether the org
  ruleset's target condition matches the repo, plus one real per-repo settings change: native
  "dismiss stale approvals" / "require approval of most recent push" must be switched **off**
  wherever they were configured (README step 4.3) — and switched back on at un-enrollment (§1.1
  caution). Unenrolled repos are *never touched* — no settings written, no per-repo ruleset
  created.
- **No code, no config, no CI job** is added to an enrolled repo by the engine.
- **The single exception:** if the org chooses Option A at P3 (see §6.3), each enrolled repo
  carries one file, `.github/workflows/fresh-approval-fallback.yaml`. Removing it is one PR. A
  repo that still has it after un-enrollment is harmless — the workflow only ever writes a check
  that nothing is requiring any more.
- **Residue after full rollback:** a GitHub App installation (revocable in one click), an org
  Actions variable + secret (if Option A), and a Kubernetes deployment. None of these can affect
  a merge once the ruleset is gone, because the ruleset is the only thing that made the check
  required in the first place.

### 1.3 Rollback triggers (any one of these, any phase, no debate)

1. A confirmed **false PRESERVE** on a live repo — a substantive change merged with a carried-forward approval. (Hard target: zero. This is the only safety-relevant failure mode.)
2. `integration_id` pin verification fails or regresses (README §6 drill step 5) — the check is spoofable.
3. Ruleset drift detected that cannot be explained (`bypass_actors` non-empty, `enforcement != active`, `required_approving_review_count < 1`).
4. Any pilot repo owner asks to be removed. **Volunteers stay volunteers.** No negotiation, un-enroll same day.
5. Security withdraws sign-off for any reason.

---

## 2. Owner roles (used by every phase)

| Role | Who | Owns |
|---|---|---|
| **Engine owner** | Platform engineering | The code, the pod, the stubs, the metrics, the phase mechanics. Runs the drills. |
| **Security owner** | The org's security review function (and the CODEOWNERS team on this repo's control surface) | The denylist contents, the sign-off at each gate, the weekly audit-sampling queue from P3, the custody decision. Has an unconditional veto at every gate. |
| **Org owner / GitHub admin** | Whoever can `PUT` org rulesets and manage org Actions secrets | The ruleset (create, target, un-enroll, delete). The App installation scope. The only break-glass path. **Not** the engine owner — keep these separate. |
| **Pilot repo maintainers** | The volunteers | Consent to enrollment, report anything that feels wrong, can demand un-enrollment at any time. |
| **Compliance / audit liaison** | Whoever answers to the auditors | Ratifies the audit narrative (EPIC §8), the compliance mapping (EPIC §9), and the retention of the decision log. |
| **On-call** | The platform rota | Tier 1/2/3 response per [RUNBOOK.md](RUNBOOK.md). From P2 onward. |

**Separation that must hold:** the identity that can write the ruleset must never be an identity
the engine holds, and the engine's App must never gain Administration scope. This is invariant,
not a phase decision.

---

## 3. P0 — Evidence + mechanics (2 weeks, READ-ONLY)

**Purpose:** produce the org-specific number that decides whether this project should exist at
all, and confirm the GitHub platform mechanics behave the way the design assumes.

Nothing in P0 grants write access to anything. `scripts/p0_backfill.ts` is read-only by
construction — it takes no action and its header says so.

### 3.1 Entry criteria

- [ ] EPIC §2 invariants ratified as chartering constraints by the security owner (EPIC §11.1).
- [ ] A read-only token (PAT or read-only App installation token) scoped to the candidate repos.
- [ ] Candidate repo list agreed — pick repos representative of the org's real language mix and PR volume, not just the tidy ones.
- [ ] Stage-2 data-boundary question opened with compliance (EPIC §11.5) — it does not block P0, but it must be *decided before P1*.
- [ ] **Three known blockers in the script closed first.** These are marked stubs and the script will not produce a number until they are done:
  1. `loadConfig()` (`src/config/schema.ts`) throws — wire it, including the deploy-time denylist/thresholds the security owner co-owns.
  2. `materializeBlobs()` (`src/stages/stage1_difftastic.ts`) throws — and its throw is caught and mapped to `"unsupported"`, which makes the `ast_identical` bucket **structurally unreachable and silently reported as 0%**. Wire blob fetch before believing any output.
  3. `main()` has no per-PR error handling — a single API failure aborts the whole backfill. Wrap it.

### 3.2 Work

1. **Run the backfill.** `npm run p0 -- --days 90 --repos org/a,org/b`. Output shape and buckets are in the script; the three top-line buckets (`wouldDismissStage0`, `wouldPreserveStage1`, `fallThroughToStage2`) are mutually exclusive and sum to the total.
2. **Produce the mechanics memo** — validated live on one throwaway repo, not from documentation:
   - Ruleset repository targeting works as expected (both explicit-name and custom-property patterns).
   - The dismiss-review API behaves as assumed.
   - The `required_status_checks[].integration_id` pin rejects a same-named check from another identity. *This is the load-bearing platform fact of the whole design and it has never been verified empirically.* (It reappears as README §6 drill step 5 at P2; doing it early in P0 is strongly recommended, because a surprise here is a redesign, not a tuning ticket.)
   - Interaction between the org ruleset, any existing repo-level rulesets, classic branch protection, and CODEOWNERS on a candidate repo (this is pre-mortem risk #4).
   - The exact JSON field name for the "restrict who can dismiss reviews" ruleset control (GA 2026-07-07) — see [../deploy/rulesets/README.md](../deploy/rulesets/README.md) for the `gh api` command. Do not guess it into the file.
   - Difftastic language coverage against the org's actual language mix (pre-mortem risk #2).
3. **Confirm the Stage-2 data boundary** with compliance: Bedrock in-boundary vs. zero-retention API (EPIC §6.3).

### 3.3 How to read the number honestly

Three caveats must travel *with* the number, in the same slide, or it will be misread:

- **The denominator is not "all PRs."** It is post-approval pushes on already-approved PRs — the exact population native "dismiss stale approvals" punishes today. A PR opened, reviewed and merged with no post-approval push never enters the denominator at all.
- **The script counts PRs, not pushes**, and evaluates one *aggregate* delta from the first approval to the final head, rather than each push separately. An aggregated delta is strictly larger and strictly less likely to be trivial than any single push, so **the script's preserve rate understates the live per-push rate.** Fix it or footnote it; do not quote it unqualified.
- **A near-zero `ofWhichMergeBaseOnly` is a suspected measurement artifact, not a finding.** `baseChanged` is computed as "zero commits and zero files in the `approvedSha...headSha` compare," but in the ordinary "Update branch" case the approved SHA is an ancestor of head, so the three-dot compare returns the base branch's newly-merged commits and files — which then trip `foreign_author_commit` (merge) or `force_push` (rebase) at Stage 0. Expect `ofWhichMergeBaseOnly ≈ 0` alongside an inflated `wouldDismissStage0`, and **confirm this in the mechanics memo before drawing any conclusion about the merge-base class.** There is currently zero test coverage of Stage 1.

Also worth stating to the room: the half of the merge-base class where the base moves and *nobody
touches the PR branch* is delivered for free by the ruleset (native dismissal off, head SHA
unchanged, existing check stands) and never appears in this denominator at all.

### 3.4 Exit gate — GO / KILL (the real one)

The proposed thresholds below are **recommendations for ratification by the security owner and
the engineering sponsor**, not measurements. Agree them *before* the number is produced, in
writing. Agreeing a kill threshold after seeing the number is not a gate.

Let **S1%** = `wouldPreserveStage1` as a share of evaluated post-approval pushes.

| Outcome | Condition | Decision |
|---|---|---|
| **GO** | S1% ≥ 30% | Proceed to P1 with the full ladder in scope. |
| **CONDITIONAL GO** | 15% ≤ S1% < 30% | Proceed to P1, but scope the project to **deterministic-only** (Stages 0–1). Stage 2 — and its model spend, its data-boundary question, and its "a machine judged this" argument — must be re-justified separately at P3 on measured evidence, not carried along by momentum. |
| **KILL** | S1% < 15% | Stop. Write up the finding and close the epic. |
| **KILL (volume floor)** | Fewer than ~50 evaluated post-approval pushes/month across candidate repos, regardless of S1% | Stop. There is not enough ceremony here to be worth a webhook receiver, a GitHub App, a pinned org ruleset and a model spend line. |
| **KILL / redesign (mechanics)** | The `integration_id` pin does not reject a foreign same-named check, **or** ruleset targeting cannot express the enrollment model | Stop. The gate is not pinnable, which invalidates the security argument. This is a redesign, not a tuning problem. |

**Say the quiet part in the P0 write-up:** if the org does not produce many semantically null
post-approval pushes, there is little ceremony to eliminate and the honest answer is "don't deploy
this." P0 exists to kill the project cheaply, before anyone touches a ruleset. A KILL at P0 is a
successful P0.

### 3.5 Rollback

Nothing to roll back. Revoke the read-only token; delete the throwaway repo.

### 3.6 Comms to developers

None org-wide. P0 is invisible. Notify only the maintainers of the throwaway repo used for
mechanics validation, and the candidate repo owners as a courtesy that read-only history analysis
is running.

---

## 4. P1 — Shadow mode (2–3 weeks)

**Purpose:** watch the full ladder make real decisions on real live events, with the actuator
disabled, and compare its decisions against what humans actually did.

### 4.1 Entry criteria

- [ ] P0 GO recorded, with the number and the mechanics memo socialized.
- [ ] Security owner has **approved the approach** before any write access exists (EPIC §10, P0 exit).
- [ ] Stage-2 data boundary **decided** (Bedrock in-boundary vs. zero-retention API) — this was allowed to be open through P0; it is closed here.
- [ ] The remaining deploy-time stubs are wired: model provider (`src/model/provider.ts`), `loadConfig()`, blob materialization. `npm test` and `npx tsc --noEmit` green.
- [ ] `selfGovernedRepos` set (required field — a conscious deploy-time decision, per README step 3).
- [ ] `.github/CODEOWNERS` placeholder team replaced with a real security team.
- [ ] Pod deployed with **`DRY_RUN=true`**, audit output flowing to the Loki audit tenant.
- [ ] **No ruleset applied. No repo enrolled. Native GitHub behavior is unchanged throughout P1.**
- [ ] Golden eval set built from labeled historical deltas; adversarial suite wired into CI.

> **A boundary worth naming to security.** In shadow mode the only thing preventing writes is the
> `DRY_RUN` flag — a config value, not a permission boundary. **Recommended:** create the App for
> P1 with Checks and Pull requests at **Read-only**, and elevate to Read & write only at the P2
> gate. Then P1's "writes nothing" claim is enforced by GitHub's permission model rather than by
> a boolean, and the elevation becomes an auditable event at the right moment.

### 4.2 Work

1. Install the App (read-only, per the note above) on the pilot candidates; subscribe to `pull_request`, `pull_request_review`, `push`.
2. Let it run. Every `synchronize` produces a logged decision with its full evidence chain — stage, reason, delta, model verdict and every corroboration gate when Stage 2 was invoked, prompt version.
3. Build the **agreement-rate analysis** (below).
4. Security reviews the shadow logs directly — not a summary of them.

### 4.3 Agreement-rate analysis — the actual P1 deliverable

Because native dismissal is still on during P1, every post-approval push produces both a *shadow
decision* and an observable *human outcome*. Compare them.

For each shadow decision, classify the human outcome that followed:

| Shadow decision | Human outcome observed | Reading |
|---|---|---|
| PRESERVE | Re-approved with no further commits, no change requests, no review comments on the delta | **Agreement.** The re-review was ceremony; the engine would have saved it. |
| PRESERVE | Reviewer requested changes, left substantive comments on the delta, or new commits followed addressing the delta | **Suspected false preserve.** Investigate every single one, individually, by hand. |
| DISMISS | Any | Native-equivalent. Costs nothing versus today; not interesting except for tuning noise. |

**Proposed exit thresholds** (restating EPIC §10 P1 in these terms):

- **Stage-1 precision ≥ 95%** against hand labels — i.e. of everything Stage 1 says is semantically null, ≥95% is confirmed null by a human labeller. *This is the epic's number, unchanged.*
- **Stage-2 false-preserve = 0** on high-impact labels within the corroboration gates. **Hard zero.** One is a failure of the phase, not a percentage to negotiate.
- **Suspected false preserves from the live agreement analysis: every one individually adjudicated and either explained or converted into a denylist entry plus an `test/adversarial/` case.** An unexplained one blocks P2.
- Model cost per decision and Stage-2 invocation rate measured and within the order-of-magnitude in IMPLEMENTATION-PLAN §12.

### 4.4 Exit criteria

- [ ] Thresholds above met.
- [ ] Security owner has read the shadow logs and signed off.
- [ ] Golden eval set and adversarial suite green in CI; zero false-preserve in the adversarial suite.
- [ ] Denylist tuned on evidence and re-ratified by the security owner (EPIC §11.2 — "start maximal, relax with evidence").
- [ ] Dashboards built (decision funnel, preserve rate, latency, cost) even though nothing is enforcing yet.

### 4.5 Rollback

Scale the deployment to zero and/or uninstall the App. **Zero developer impact** — nothing was
enforcing, no repo was enrolled, and native GitHub behavior was in force the entire phase.

### 4.6 Comms to developers

A short note to the maintainers of the observed repos: *"A tool is watching approval-dismissal
events on these repos and logging what it would have decided. It writes nothing, it cannot change
your PRs, and GitHub's behavior is exactly as it was. We'll share the results."* No org-wide
announcement — there is nothing for anyone to do.

---

## 5. P2 — Deterministic-only, LIVE on 3–5 volunteer repos (2 weeks)

**Purpose:** this is the "run it silently first, then run it for real on a small blast radius"
step. Stages 0–1 enforce. Stage 2 keeps running in shadow and cannot affect an outcome.

**What "deterministic-only live" means concretely:** the only thing that can carry an approval
forward is a difference *proved* semantically null — AST-identical, trivial-class, or
merge-base-only. Anything the deterministic stages cannot prove null is dismissed to human
re-review, exactly as GitHub does today. No model judgment reaches a PR in this phase.

### 5.1 Entry criteria

- [ ] P1 exit gates met and signed off.
- [ ] **Security-review follow-up items 2 and 3 confirmed fixed** — these explicitly gate P2 ([SECURITY-FOLLOWUPS.md](SECURITY-FOLLOWUPS.md)): platform-verified identity on the foreign-author gate, and control-surface governance (CODEOWNERS + `selfGovernedRepos`). Both are implemented and tested; re-verify on the deployed build.
- [ ] **A real deterministic-only mode exists in the deployment.** *Open engineering item:* `EngineConfig` currently has no Stage-2 toggle, `src/stages/ladder.ts` calls `stage2()` unconditionally, and the `MODE` value in `deploy/helm/values.yaml` is not read anywhere in `src/`. A `stage2Enabled: false` posture (Stage 2 never invoked; anything Stage 1 cannot prove null is dismissed) must be implemented and tested before P2, or P2 as defined here is not deployable. This is also the target state of the Tier-2 circuit breaker in [RUNBOOK.md](RUNBOOK.md), and the standing posture for any org that will not accept a machine-corroborated judgment at all.
- [ ] **App permissions elevated** to Checks: Read & write, Pull requests: Read & write, Contents: Read-only, Metadata: Read-only — and *explicitly* not Administration, Actions, Workflows, Members, or any org permission (README step 2).
- [ ] `DRY_RUN=false`.
- [ ] **The org ruleset applied at org level**, `enforcement: active`, scoped to *only* the 3–5 pilot repos, with `integration_id` set to the real App ID (the shipped `0` is a deliberate fail-closed sentinel — never guess it). Applied by the org owner via the Git-reviewed GitOps path. See [../deploy/rulesets/README.md](../deploy/rulesets/README.md).
- [ ] On those repos, native "Dismiss stale pull request approvals" and "Require approval of the most recent reviewable push" confirmed **off** in every other ruleset and in classic branch protection. The engine now owns staleness; leaving native dismissal on would make preservation impossible.
- [ ] Drift-monitoring query scheduled (from the rulesets README), alerting on any ruleset change. Run it from an **ops** repo, not this one — keep the check-writing and ruleset-reading credentials separate. Monitoring aid only; never wire it to auto-repair.
- [ ] Dashboards and alerts live; on-call trained on [RUNBOOK.md](RUNBOOK.md) and, above all, on the §1.1 caution that killing the pod is not a rollback.
- [ ] **THE LIVE DRILL PASSED — all seven steps of README §6, executed on a throwaway enrolled repo, results recorded.** This is a hard entry requirement for P2, not a nice-to-have:

  | Drill step | Proves |
  |---|---|
  | 1. Approve, push a trivial commit → PR blocked until the engine reports | The gate is real |
  | 2. Whitespace-only push → `success` without dismissing | The ladder works end to end |
  | 3. Kill the pod, push → blocked indefinitely | Fail-closed; no timer, no dead-man switch |
  | 4. Pod still dead, peer re-approves on current head → check green in ~a minute | The unblock path survives the engine (Option A only — see §6.3) |
  | 5. Plain Actions workflow with `checks: write` writes the same-named check → merge box shows it as **not** satisfying | **The `integration_id` pin. If this fails, STOP — the ruleset is not pinned and nothing else in the design holds.** |
  | 6. Restart the engine → normal evaluation resumes | Recovery needs no re-enrollment; the ruleset never changed |
  | 7. PR on the engine repo touching a control-surface path → dismissed `self_governance` **and** CODEOWNERS security review demanded | Both halves of control-surface governance |

  Then README §7 ("Operate") — drift monitoring wired, runbook read — completes the entry.
  Drill step 4 is skipped if the org has provisionally chosen Option B at §6.3; record the skip
  explicitly rather than leaving the row blank.

### 5.2 Choosing the pilot repos

**Volunteers only.** Criteria: active enough to generate post-approval pushes weekly; a
maintainer who will actually report weirdness; a language difftastic handles well; **not** the
org's highest-criticality production service; and — deliberately include — **this engine's own
repo**, enrolled with `selfGovernedRepos` set, so control-surface governance is exercised in
anger from day one.

### 5.3 Exit criteria

- [ ] **Zero incidents.** Specifically zero confirmed false preserves and zero merge-blocking surprises attributable to the engine.
- [ ] Re-review-request rate on pilot repos measurably down versus their own P1 baseline (the KPI that justifies the project).
- [ ] Decision latency p95 < 30s.
- [ ] No unexplained ruleset drift alerts.
- [ ] Pilot maintainers surveyed and none asking to leave.
- [ ] **Security sign-off to proceed to Stage 2 live.**

### 5.4 Rollback

Remove the pilot repos from the ruleset's target list, or set the ruleset to `enforcement:
disabled` — either removes the engine's gate instantly, no deploy, no workflow to run — and
re-enable native stale-dismissal on those repos in the same change (the §1.1 two-step caution).
Nothing to uninstall from the repos (except the optional fallback workflow, one PR). Note
the deliberate asymmetry recorded in [RUNBOOK.md](RUNBOOK.md): **re-enrollment is never
automated** — a human re-tightens branch protection, on purpose.

### 5.5 Comms to developers

To pilot repo teams, before the ruleset is applied — and get an acknowledgement, don't just send
it:

> **What changes on your repo this week.** GitHub currently throws away an approval whenever
> anyone pushes to an approved PR, even for a typo. On this repo we're replacing that rule with a
> more precise one: if the push provably didn't change anything meaningful (formatting, comments,
> a rebase that changed nothing, or an unrelated PR moving the base), your approval stays.
> Anything else — and anything touching infrastructure, workflows, production config or
> dependencies — still requires a fresh approval, exactly as today.
>
> **You'll see a new required check called `approval-freshness/evaluated`.** If it's red or
> missing, your merge is blocked and the fix is the same one GitHub already asks for: get a fresh
> approval on the latest commit.
>
> **Nothing was installed in your repo and nothing approves anything on your behalf.** No machine
> in this system can approve, merge, or push — it can only decide whether an existing human
> approval still counts.
>
> **If anything feels wrong, say so and we'll take your repo out the same day.** Contact:
> `#<channel>` / `<engine owner>`.

Also brief on-call, and post to the org engineering channel a short "we're piloting this on N
repos, here's the doc" note so the rest of the org isn't surprised to hear about it later.

---

## 6. P3 — Stage 2 LIVE on pilots (3–4 weeks)

**Purpose:** turn on the AI-advised tier, within gates, on the same small blast radius — and
close the two decisions that were deliberately deferred to this point.

### 6.1 Entry criteria

- [ ] P2 exit gates met and signed off.
- [ ] Weekly audit-sampling ritual defined and staffed: rate, owner, queue mechanics. Proposal from EPIC §11.3: **10% of PRESERVE decisions, weekly, security-owned, engine-provided queue.** Ratify the rate before the phase starts.
- [ ] Model version pinned; eval + adversarial suites re-run against that exact version.
- [ ] Stage-2 cost dashboarded with an alert (`afe_model_cost_usd_total`).
- [ ] **The custody decision signed off** (§6.3).
- [ ] Compliance liaison has ratified the audit narrative (EPIC §8) and the compliance mapping (EPIC §9) *as they will actually be presented*, including the honest boundary in §6.4 below.

### 6.2 Work

Flip Stage 2 from shadow to live on the pilot repos only. Begin the weekly audit sampling in week
one — not week three. The ritual is the control; if it slips, the phase stops.

### 6.3 The fallback-workflow custody decision (P3 sign-off — the org's call)

This is the one open decision the security review deliberately handed to the org rather than to
engineering. Full disposition in [SECURITY-FOLLOWUPS.md](SECURITY-FOLLOWUPS.md) Item 1. Both
options are legitimate and both are fail-closed. **Record the choice and the signer.**

**The mechanism, stated plainly:** the ruleset pins the required check to *one GitHub App
identity*. The fallback workflow therefore cannot "write a check as itself" — it has to
authenticate **as the engine's App**, which means a second copy of the App's private key must
live in org Actions secrets. That is the entire trade-off. `integration_id` defends against other
*identities*; it can never defend against holders of the *key*.

| | **Option A — Enable the fallback** | **Option B — Omit the fallback** |
|---|---|---|
| **What you get** | During an engine outage, a fresh human re-approval on the current head is echoed to a green check within ~a minute, on GitHub's own infrastructure, independent of the pod. | One custody point for the App key: AWS Secrets Manager, via EKS Pod Identity, with no human standing access. |
| **What it costs** | The App private key exists in a **second custody domain** (org Actions secret `AFE_APP_PRIVATE_KEY` + org variable `AFE_APP_ID`), whose custodians — the org's Actions-secrets admins — are a different and typically broader set of people than the engine's IAM boundary. | During an engine outage, blocked PRs wait for the pod to return, or for an org owner's audited break-glass ruleset edit. Purely a liveness/UX cost. |
| **Bounded by** | The App's grant: Checks R/W, Pull requests R/W, Contents read. **No** approve, merge, push, Administration, Actions, Workflows or ruleset scope. A leaked key cannot merge code, cannot approve a PR, and cannot alter the ruleset. **But state the worst case honestly** ([FAILURE-MODES.md](FAILURE-MODES.md) §4.2): because the enrolled ruleset deliberately turns native stale-dismissal off, an approval on an *earlier* commit still counts toward the ≥1-approval rule — so a key holder who also has push access can push a new commit, write `success` on it as the App, and merge a delta no human reviewed. The key cannot forge an approval; on an already-approved PR it does not need to. Same bound applies to the engine-runtime key copy — Option B narrows *who* can reach the key, not what it can do. | n/a |
| **Mitigations in place** | `permissions: {}` (the default Actions token is never used); no `workflow_dispatch` and no free-form inputs, so the only trigger is a platform-verified `pull_request_review`; hardcoded literal `conclusion=success`, no other conclusion reachable; TOCTOU re-verify that head hasn't moved; secret scoped to enrolled repos only, never "all repos". | n/a |
| **Per-repo footprint** | One workflow file per enrolled repo. | None. |
| **Drill step 4** | Must pass. | Not applicable — record the skip. |

**Engineering recommendation: Option A, with all mitigations in place.** The liveness benefit is
material and the residual risk is bounded by the App's inability to merge, approve, or touch the
ruleset — with the honest ceiling stated in the "Bounded by" row above (a stolen key on an
already-approved PR can green an unreviewed delta; see FAILURE-MODES.md §4.2, which must be on
the record for this sign-off). **But this is explicitly the org's sign-off, not an engineering
default.** An
org with stricter key-custody policy chooses Option B and loses only outage-window self-service,
never security.

Two items to close in the same decision if Option A is chosen: re-verify and re-pin the
`actions/create-github-app-token` SHA (the pinned commit is a v2-era release; upstream has shipped
v3.x — re-pin at rollout rather than editing the trailing comment), and note the one honest
asymmetry between the two echo implementations: the workflow's job-level guard omits the
`draft !== true` and `state === "open"` preconditions that `evaluateFreshApproval` enforces. Low
practical impact — a draft or closed PR is not mergeable and the ≥1-approval rule still applies —
but the two paths are not literally the same predicate, and a reviewer will notice.

### 6.4 The claim to make, and the claim not to make

Before Stage 2 is live, fix the wording everyone will quote. **Do not say "no change reaches
production without human re-review."** On the Stage-2 path that is false, and an auditor will
find it.

Say this instead:

> Every merged pull request carries a platform-verified human approval of that pull request —
> enforced by GitHub's own ruleset, which this system cannot alter. No machine in this system can
> create, restore, or substitute for an approval. What is automated is the **validity test**
> applied to that approval after subsequent commits. Privileged and control-surface changes
> categorically require a **fresh** human approval, decided deterministically with no model
> involvement. For non-privileged changes, the original approval is carried forward when the
> difference is proven semantically null, or when a confidence-gated, deterministically
> corroborated impact assessment supports it. In the second case, a machine-corroborated
> judgment is deliberately substituted for a fatigued re-click — that substitution is the risk
> this phase asks security to accept, and an org that will not accept it runs deterministic-only
> mode indefinitely.

### 6.5 Exit criteria

- [ ] **Audit samples clean — zero false-preserve findings.** Hard target.
- [ ] Preserve rate, time-to-merge delta and cost/PR all within expectation and dashboarded.
- [ ] Custody decision signed, dated, and recorded in [SECURITY-FOLLOWUPS.md](SECURITY-FOLLOWUPS.md) Item 1 (currently OPEN).
- [ ] Weekly audit sampling has run for at least three consecutive weeks with a named owner.
- [ ] No model-drift alerts unexplained.

### 6.6 Rollback

Two granularities, both minutes:

1. **Back to P2** — set `stage2Enabled: false`. The deterministic tier keeps working; only the AI-advised preserves stop. This is a config change, not a rollback of the phase.
2. **Full rollback** — un-enroll the repos from the ruleset (§1.1).

If Option A was chosen and later regretted: delete the org secret and variable, and remove the
workflow file from enrolled repos. The system remains fully fail-closed; only outage-window
self-service is lost.

### 6.7 Comms to developers

To pilot teams:

> **Second change to how approvals are handled on this repo.** Until now, an approval was only
> carried forward when we could *prove* your push changed nothing. From this week, a small,
> tightly-bounded additional category is included: changes that are assessed low-impact **and**
> independently pass every deterministic safety gate (size limits, no new dependencies, no
> sensitive patterns, nothing on a privileged path). If any of those gates fails, or if the
> assessment is anything other than confidently low-impact, you get a re-review request exactly
> as today.
>
> **Nothing approves your code.** A human approval on the PR is still required by GitHub itself
> and always will be. Every one of these decisions is logged with its full reasoning and a
> sample is reviewed by security every week.

---

## 7. P4 — Org-wide enrollment (ongoing)

**Purpose:** grow enrollment deliberately, via ruleset repository targeting, with the ADR merged
and the audit cadence owned.

### 7.1 Entry criteria

- [ ] P3 exit gates met.
- [ ] **ADR merged** — invariants (EPIC §2), precedent (EPIC §1), compliance mapping (EPIC §9), and the explicit reversal conditions (§1.3 above).
- [ ] Enrollment mechanism chosen and documented: explicit repo names/patterns in `enrolled-ruleset.json`, **or** a repository custom property (e.g. `afe-enrolled = true`) targeted via `conditions.repository_property`. Trade-off is auditability vs. churn — decide which surface you want enrollment changes reviewed through. **Never leave the ruleset unscoped**: every matched repo gets a hard-required check pinned to the App, which permanently blocks merges on any repo the engine does not actually run against.
- [ ] Capacity validated for the target scale (queue metrics, HPA headroom, GitHub API rate-limit budget — pre-mortem risk #3).
- [ ] Security owns the audit-sampling cadence as a standing commitment, not a project task.

### 7.2 Work — enroll in waves, never in one `PUT`

Waves of ~5–10 repos, each wave soaking for at least one week with dashboards watched before the
next. Each wave is a Git-reviewed ruleset change. For each wave:

1. Confirm the repos have no conflicting ruleset or classic branch protection still doing native dismissal.
2. If Option A: land the fallback workflow into the repos (template repo or enrollment automation) *before* the ruleset change, so the outage path exists from the first enrolled minute.
3. Apply the ruleset change; watch the first pushes get checks within SLO.
4. Send the developer comms (§7.4) *before* the change lands, not after.

**Perform the kill-switch drill on purpose, once, during P4** — un-enroll a real (non-throwaway)
repo, confirm native branch protection returns immediately, confirm there is no automated
re-enroll path, then re-enroll it by hand. Document it. This is an EPIC §10 P4 requirement and a
definition-of-done item; do not let it become theoretical.

### 7.3 Exit criteria (P4 has no end, only a steady state)

- [ ] ADR merged.
- [ ] Kill-switch drill executed and documented.
- [ ] `integration_id` drift audit scheduled and alerting.
- [ ] Audit events flowing to the 6-year retention tenant.
- [ ] Weekly audit sampling running with zero false-preserve findings sustained.
- [ ] Runbook exercised by on-call at least once for real.

### 7.4 Comms to developers (org-wide)

One announcement, plus a link to [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for anyone who wants the
plain-English version and to this plan for anyone who wants the detail. Keep it to four points:

1. **What changes:** approvals are no longer thrown away for pushes that provably changed nothing.
2. **What doesn't:** a human approval is still required on every merge, by GitHub itself. Infrastructure, workflows, production config and dependency changes always require a fresh look — that part is *stricter* than the old rule, not looser.
3. **What you'll see:** a required check called `approval-freshness/evaluated`. If it's red or missing, get a fresh approval on the latest commit. That's the whole remedy, and it is the same one GitHub already asks for.
4. **Where to complain:** a named channel and a named owner, with an explicit promise that any repo can be un-enrolled on request.

### 7.5 Rollback

Unchanged and unconditional: remove repos from the target list, or delete/disable the ruleset —
the engine's gate is gone in minutes, with nothing to uninstall from the repos. Pair it with
re-enabling native stale-dismissal on the affected repos (the §1.1 two-step caution), or the
rollback lands weaker than the starting point.

---

## 8. Standing risks carried through every phase

| Risk | Carried mitigation |
|---|---|
| `approved_sha` resolution edge cases (squash, rebase, review on a rewritten commit) — the #1 correctness risk | Fail-closed on any ambiguity (`unresolved_approved_sha` dismisses before Stage 0); heaviest test attention |
| Difftastic language coverage gaps → more Stage-2 fall-through than expected | Cost/latency issue, not safety. Measured in P0 against the real language mix; unsupported always falls through, never preserves |
| GitHub API rate limits at org scale | Installation-token scoping, conditional requests, per-key serialization and bounded concurrency in the queue, backoff |
| Ruleset interaction surprises (org vs repo rulesets vs classic protection vs CODEOWNERS) | P0 mechanics memo validates on one repo before any rollout; org-level ruleset cannot be weakened by repo admins |
| Model drift on a provider version bump | Pinned model version; eval suite re-runs on any bump; verdict distribution dashboarded with a drift alert |
| **Scope creep — "just let it approve the easy ones"** | Invariant #1 is chartered. Changing it requires a new security review. **Say no.** |
| Silent ruleset drift | Drift-monitoring query alerting from an ops repo. Monitoring aid only — never wire it to auto-repair, that would reintroduce a runtime ruleset-write credential |

---

## 9. Open items this plan depends on

These are tracked elsewhere but block specific gates; listed here so a reader of this document
alone knows what is not yet done.

| Item | Blocks | Owner |
|---|---|---|
| `loadConfig()`, blob materialization, model provider wiring (deploy-time stubs) | P0 (first two), P1 (all three) | Engine owner |
| `p0_backfill.ts` counts PRs not pushes; no per-PR error handling | P0 number quality | Engine owner |
| `baseChanged` / merge-base-only computation vs. three-dot compare semantics; zero Stage-1 test coverage | P0 interpretation, P2 confidence | Engine owner |
| Deterministic-only mode not representable (`stage2Enabled` absent; `MODE` unread by `src/`) | **P2 entry** | Engine owner |
| `integration_id` real App ID (shipped `0` is a fail-closed sentinel) | P2 entry | Org owner |
| "Restrict who can dismiss reviews" — exact ruleset field name unconfirmed | P0 mechanics memo; hardening at P2 | Engine owner + org owner |
| `create-github-app-token` pin is a v2-era SHA; upstream is v3.x | P3, Option A only | Engine owner |
| Fallback custody decision | **P3 exit** | Security owner + org owner |
| Compliance frameworks that bind us (SOC 2 / FedRAMP / HITRUST / HIPAA) | ADR at P4 | Compliance liaison |
| Bypass-actor policy on enrolled repos | P2 entry | Security owner + org owner |
| Live drill (README §6, all seven steps) never yet run | **P2 entry** | Engine owner |
