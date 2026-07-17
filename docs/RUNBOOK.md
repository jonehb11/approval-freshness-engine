# Runbook — Approval Freshness Engine

## Guiding principle
The merge gate is GitHub's own static ruleset, not the engine (see the merge equation in
SECURITY-REVIEW.md). **The ruleset IS the fail-safe.** No path blocks merges by mutating
enforcement; no path fails open. When the engine can't produce a `success`, the PR stays exactly as
blocked as any other required check that stopped reporting would leave it — and a fresh human
approval on the current head SHA always clears it, engine or no engine.

## The operating tiers (know which one you're in — dashboard `afe_current_mode`)
> Build honesty: the Tier-2 circuit breaker and its metrics (`afe_current_mode`,
> `afe_circuit_breaker_state`) describe the target design and ship with the Stage-2 model
> wiring — they are not implemented in the current scaffold. Tiers 1 and 3 behave as written
> today. Currently-shipped metrics are listed in IMPLEMENTATION-PLAN §10.
- **Tier 1 Healthy:** full ladder; trivial pushes preserved.
- **Tier 2 Model degraded:** circuit breaker → deterministic-only (Stage 0/1 still preserve; rest dismiss). Auto-recovers.
- **Tier 3 Engine down:** nothing reverts. Enrolled PRs sit on the required check until it's satisfied — by the engine coming back, or by a fresh human approval echoed via the fallback workflow.

## Manual kill switch (do this any time you're in doubt)
There is no automated ruleset mutation to trigger. The kill switch is a **human GitOps action**:
un-enroll the repo by removing it from the ruleset's target list (or disabling the ruleset for it)
via the same Git-reviewed process used to enroll it — a `PUT` to the update-ruleset endpoint
(GitHub's ruleset API is `PUT`, not `PATCH`), reviewed and merged like any other infra change.
This instantly restores fully native branch protection for that repo. No deploy, no workflow to
run, no automated equivalent — because there is no automated direction to protect against.

## Engine down — what actually happens (nothing to do for safety, any duration)
- Freshly-pushed enrolled PRs wait on the required check exactly as they would for any other
  down check: missing/pending, merge blocked. This is expected, safe, and not itself an incident.
- **To unblock:** get the PR a fresh approval on the current head SHA — the same native GitHub
  action a dismissal already asks for. `.github/workflows/fresh-approval-fallback.yaml` (running
  on GitHub's infra, independent of the engine) picks up that `pull_request_review` event and
  echoes it to a green check, authenticating as the same GitHub App the ruleset's
  `integration_id` pin requires. This works whether or not the engine's pod is alive.
- **Page on-call to fix the pod at leisure — never to unblock developers.** There is no
  re-enrollment step to run afterward: the ruleset never changed, so there's nothing to restore.
  Once the pod is healthy again, it simply resumes evaluating new pushes; nothing needs to be
  flipped back.
- If the org chose not to deploy the fallback workflow (a documented trade-off — it carries a
  second copy of the App's private key in org Actions secrets), the only unblock path during an
  outage is waiting for the pod, or an org owner's break-glass ruleset edit. Both are still
  fail-closed; they're just slower.

## Model provider outage
Circuit breaker trips to Tier 2 automatically. Verify `afe_circuit_breaker_state=open` on the
dashboard. Safe buckets still preserved; everything else dismisses (native-equivalent). Auto-resets
after cooldown when the provider returns. No manual action unless it flaps — then pin to
deterministic-only via config until the provider stabilizes.

## Suspected false PRESERVE (the only safety-relevant failure)
1. Pull the audit event (repo/pr/headSha) from the Loki audit tenant — it has delta + verdict + gates.
2. If it's a real miss: add the class to the denylist immediately (dismiss going forward),
   add the case to `test/adversarial/`, open a post-mortem.
3. If the model was involved: bump prompt version, re-run eval + adversarial, redeploy.

## False DISMISS (too strict)
Human just re-approves — identical to today. Log a tuning ticket; adjust denylist/thresholds via PR.

## Changing the prompt or thresholds (control logic)
PR → CI runs eval + adversarial (must pass) → shadow one cycle if material → merge. Prompt version
is auto-stamped into every audit event, so decisions are always attributable to a prompt revision.

## Weekly audit sampling ritual (security-owned)
Engine provides a queue of N% of PRESERVE decisions. Security reviews; findings feed denylist/rubric.
Target: zero false-preserve findings.

## Re-enrolling a repo after a manual kill-switch un-enrollment
There is no automated re-enroll path — only the reverse of the manual kill switch, deliberately:
1. Confirm the engine is healthy (dashboard `afe_current_mode` = Tier 1, no open incidents).
2. Add the repo back to the ruleset's target list via the same Git-reviewed `PUT` process (§7.1,
   IMPLEMENTATION-PLAN.md) used for original enrollment.
3. Watch the next push to that repo get a check within the normal decision-latency SLO.
Never automate this direction — it's the same reasoning as never auto-reverting: a human should
be the one re-tightening branch protection.
