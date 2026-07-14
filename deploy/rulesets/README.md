# Enrolled-repo ruleset

`enrolled-ruleset.json` is the canonical **org-level** ruleset for repos enrolled in
approval-freshness. It is the entire fail-safe: there is no dead-man switch, no
auto-revert, and no runtime component anywhere in this system that holds a
ruleset-write credential. This ruleset is applied by a human, via GitOps/Terraform,
and never edited by any automation at runtime. See the "merge equation" in the
top-level README.md for how the check this ruleset requires gets satisfied.

Apply it as org-level policy (`POST /orgs/{org}/rulesets` to create;
`PUT /orgs/{org}/rulesets/{ruleset_id}` to update — **note: PUT, not PATCH**;
the update endpoint replaces the whole ruleset object), or via
whatever Terraform/GitOps tooling your org already uses for org rulesets. Do not
apply it as a repo-level ruleset — see "Org-level, on purpose" below.

Before applying, resolve every placeholder in the file:

| Placeholder | Where | Replace with |
|---|---|---|
| `REPLACE_WITH_ENROLLED_REPO_NAMES_OR_PATTERNS` | `conditions.repository_name.include` | See "Scoping to enrolled repos" |
| `0` | `rules[].parameters.required_status_checks[].integration_id` | See "Pinning is mandatory" |

## Pinning is mandatory

`required_status_checks[].integration_id` pins the required context
`approval-freshness/evaluated` to **one specific GitHub App** — the engine's own
App. Without it, GitHub accepts a check with that name from *any* source,
including a plain `github-actions` workflow run with `checks: write`. That is
exactly the hole the old `peer-override-reusable.yaml` workflow exploited (it
force-set the check to success from the generic `github-actions` identity on a
comment trigger — no platform-verified approval involved at all). It has been
deleted; do not reintroduce anything that writes this check without the App
identity behind it.

`integration_id` in this file is deliberately set to the invalid sentinel `0`
(no real GitHub App is ever assigned ID `0`). Leaving it unmodified is
**fail-closed by construction**: GitHub will never see a matching App, the
check stays permanently unsatisfied, and merges block rather than silently
accepting an unpinned/spoofable check. Get the real value with:

```sh
gh api /orgs/<org>/installations --jq '.installations[] | select(.app_slug == "<afe-app-slug>") | .app_id'
```

or from the App's settings page (`https://github.com/organizations/<org>/settings/apps/<app-slug>` →
"App ID"). Put that number — not the installation ID — into `integration_id`.

## Scoping to enrolled repos

`conditions.repository_name.include` in this file is a placeholder list. Two
supported patterns, pick one for your org:

1. **Explicit names/patterns** (shown as the placeholder): list enrolled repo
   names or `fnmatch`-style patterns directly, e.g. `["payments-api", "checkout-*"]`.
   Simple, fully auditable in this one file, but requires editing this file
   (via the normal GitOps review process) every time a repo enrolls or unenrolls.
2. **Repository custom property**: tag enrolled repos with an org custom
   property (e.g. `afe-enrolled = true`) and target via
   `conditions.repository_property` instead of `repository_name`. Scales
   better if enrollment changes often, at the cost of the enrollment list
   living outside this file (in repo property assignments) — decide per your
   org's audit requirements which surface you want enrollment changes to be
   reviewed through.

Whichever pattern you choose, **never** leave this ruleset unscoped (matching
every repo in the org) — every matched repo gets a hard-required check pinned
to the engine App, which will permanently block merges on any repo the engine
does not actually run against.

## Org-level, on purpose

This ruleset must be applied at the **organization** level, not per-repo.
Ruleset rules combine as pure AND across org- and repo-level rulesets, with
most-restrictive-wins, and org-level rulesets cannot be edited or weakened by
repo admins. Applying this at repo level instead would let any repo admin
loosen or delete it — reintroducing exactly the "someone quietly turns off
the check" failure mode this design closes.

## Break-glass

`bypass_actors` is intentionally `[]`. There is no standing bypass identity —
no team, no role, no app — configured to skip this ruleset. The only way to
bypass it is for an org owner to edit the ruleset itself (through the same
GitOps path used to apply it, or directly if truly urgent), which is a
`repository_ruleset.*` event in the org audit log
(`gh api /orgs/<org>/audit-log --jq '.[] | select(.action | startswith("repository_ruleset"))'`).
This is deliberate: an unaudited or automated bypass path is a bigger risk
than the (small) friction of requiring a human, audited edit. See
`docs/RUNBOOK.md` for the "engine down" procedure — it is not this file.

## Restrict who can dismiss reviews (GA 2026-07-07)

GitHub GA'd a ruleset control to restrict who can dismiss pull request
reviews, as part of the `pull_request` rule, shortly before this file was
written. It belongs in this ruleset — dismissal authority should be limited
to `{the engine's GitHub App, a break-glass team}`, mirroring the same
principle as `integration_id` pinning: don't let an unrelated identity
undo review state.

It is **not** included in `enrolled-ruleset.json` yet. Research at design time
(GitHub's own REST API reference and changelog post) could not confirm the
exact JSON parameter name/shape for this feature — guessing it into a file
that's meant to be applied as literal API input is worse than leaving it out,
since a wrong field name either gets silently ignored or causes a 422
depending on the endpoint, and either way you won't get the protection you
think you configured. Before rollout:

1. Confirm the live field name and shape against the OpenAPI schema for the
   ruleset endpoints:
   ```sh
   gh api /orgs/<org>/rulesets/<any-existing-ruleset-id> --jq '.rules[] | select(.type == "pull_request")'
   ```
   (inspect an existing `pull_request` rule, or a scratch ruleset you create
   with the dismiss-restriction UI setting enabled via
   `https://github.com/organizations/<org>/settings/rules`, then read it back
   via the API) to see the actual key GitHub emits for this setting.
   Cross-check against the current REST reference at
   `https://docs.github.com/en/rest/orgs/rules` for the `pull_request` rule
   type's parameter list.
2. Add the confirmed field to the `pull_request` rule's `parameters` object in
   `enrolled-ruleset.json` in the same change that updates this README to
   remove this section.
3. Until then, dismissal authority is whatever your org's existing repo
   permission model already grants (anyone with write access can dismiss
   reviews) — a real but pre-existing gap, not one this design introduces.

## Drift monitoring (monitoring aid, NOT a safety mechanism)

Because this ruleset is the *only* enforcement point and nothing at runtime
can repair it, silent drift (someone manually edits it outside GitOps, or a
future admin action changes it) would degrade security without any code path
noticing. Run this periodically (cron, or a scheduled Action in an ops repo —
**not** in this engine repo, to keep the check-writing and ruleset-reading
credentials separate) and alert on any diff against `enrolled-ruleset.json`:

```sh
gh api /orgs/<org>/rulesets/<ruleset_id> | \
  jq '{
    enforcement,
    bypass_actors,
    integration_id: [.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].integration_id],
    required_approving_review_count: [.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count],
    has_non_fast_forward: ([.rules[].type] | contains(["non_fast_forward"]))
  }'
```

Compare the output against the checked-in JSON and alert (page, ticket,
Slack — your choice) on any mismatch, especially: `enforcement != "active"`,
`bypass_actors` non-empty, `integration_id` missing/changed, or
`required_approving_review_count < 1`.

This is explicitly a **monitoring aid**, not a safety mechanism: its failure
mode is "nobody notices drift promptly," never "a merge gets approved that
shouldn't have." The ruleset itself — not this script — is what blocks
merges at every moment, drift-detected or not. Do not build any automation
that reacts to a detected drift by writing to the ruleset; that would
reintroduce a runtime ruleset-write credential, which is exactly what this
design set out to eliminate.
