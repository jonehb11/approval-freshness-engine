# Dead-man switch (ops-repo component)

Guarantees automatic fallback to native GitHub behavior if the engine dies — with no merge freeze
and no human paged to unblock developers. Runs entirely on GitHub Actions infra, independent of the
engine's cluster.

## Pieces
- `afe-deadman.yaml` — scheduled canary probe + auto-revert on 2 consecutive misses (hysteresis).
- `scripts/probe_canary.sh` — push a trivial commit to the canary PR, poll for `approval-freshness/evaluated` on the new SHA within SLA.
- `scripts/revert_to_native.sh` — atomically PATCH each enrolled repo's ruleset to the NATIVE config (native dismiss ON + required check REMOVED). Both changes in one call.
- `re-enroll.yaml` (separate) — human-approved `workflow_dispatch` to return to the enrolled config after the engine is verified healthy. NEVER automatic.

## Credentials (least privilege, all in the `afe-deadman` protected environment)
- `CANARY_TOKEN` — push to the canary repo only.
- `RULESET_ADMIN_TOKEN` — org-ruleset write. Its ONLY automated use restores the *stricter* native control (fail-safe, not escalation). Every use lands in the org audit log.

## Why a canary, not a heartbeat
A `/healthz` ping proves the process is up; it does NOT prove webhooks deliver, the queue drains,
the model answers, and the actuator writes the check. The canary exercises the whole path.

## Verify in P0
Confirm the exact ruleset API scope (org vs repo endpoints) and that a fresh push re-blocks on the
new SHA natively. The dead-man is the primary fallback; do not rely on undocumented check-inheritance.
