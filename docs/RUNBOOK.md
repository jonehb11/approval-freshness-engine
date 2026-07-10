# Runbook — Approval Freshness Engine

## Guiding principle
Every failure path degrades to **the status quo** (native GitHub dismiss-stale). No path blocks
merges on the engine's health; no path fails open. The failure mode of this system is "today's
behavior returns."

## The three operating tiers (know which one you're in — dashboard `afe_current_mode`)
- **Tier 1 Healthy:** full ladder; trivial pushes preserved.
- **Tier 2 Model degraded:** circuit breaker → deterministic-only (Stage 0/1 still preserve; rest dismiss). Auto-recovers.
- **Tier 3 Engine down:** dead-man auto-reverts ruleset to native. Org on today's behavior.

## Manual kill switch (do this any time you're in doubt)
Run the ruleset swap to the **native** configuration (native dismiss-stale ON + required check REMOVED),
org-wide or per-repo. Instant return to today's behavior. No deploy. This is the same swap the
dead-man automates.

## Engine down — what actually happens (no action usually needed)
- **Brief blip (< ~15m):** freshly-pushed enrolled PRs wait on the pending check; already-green PRs
  unaffected. Engine recovers and clears the backlog. Nothing to do.
- **Sustained:** dead-man switch (canary fails twice, ~20–25m worst case) auto-reverts to native.
  On-call is paged to fix the engine *at leisure*. Developers are NOT blocked. After the engine is
  verified healthy, a human re-enrolls via the approval-gated `workflow_dispatch` (never automatic).

## Dead-man switch didn't fire but engine is down
Hit the manual kill switch immediately (returns to native), then investigate why the canary/revert
workflow didn't run (check the ops-repo Actions history; GitHub cron can drift, and scheduled
workflows disable after 60d inactivity — the canary pushes should prevent this).

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

## Re-enrollment after a revert (deliberately manual)
1. Confirm engine health (canary green for ≥3 consecutive cycles).
2. Run the `re-enroll` workflow_dispatch → requires environment-protection approval.
3. Watch `afe_current_mode` return to Tier 1 and the canary stay green.
Never automate this direction — it would flap branch protection on every blip.
