# Confirmed Bug Hardening Design

## Scope

Harden the fork against the six confirmed correctness, safety, privacy, and authentication failures open upstream. Feature requests, bundled skills, prompt-guideline redesign, and unrelated refactors are excluded.

The combined fork branch starts from `c1fe550` (bounded `session_search` output). PR #100 remains focused and unchanged. Each newly implemented upstream issue will be proposed as a separate, reviewable PR; existing PR authorship is preserved when their commits are incorporated.

## Adopted upstream fixes

### External Markdown writes (PR #99)

Every mutation must apply to the current Markdown source of truth. `MemoryStore` will track a content-derived fingerprint for each target after load and save. Before add, replace, or remove, it will read the small target file, compare its fingerprint, and refresh only that target if another Pi process, consolidation child, or manual edit changed it. The frozen prompt snapshot remains unchanged.

This strengthens PR #99's `mtime:size` fingerprint because same-size or coarse-timestamp rewrites must also be detected.

### Duplicate consolidation processes (PR #97)

Consolidation will acquire an atomic filesystem lock before launching a child Pi process. Locks are scoped by target and storage identity, include owner metadata, expire after the configured timeout plus grace, and are released in `finally`.

The port will fix both review findings on PR #97:

- treat a disappeared lock (`ENOENT`) as available and retry acquisition;
- make concurrency tests release their blocked child in `finally`, preventing test hangs.

## Newly implemented confirmed bugs

### Markdown/SQLite reconciliation (issue #98)

Markdown remains authoritative. The existing Markdown sync will become a true scoped reconciliation:

1. Parse all Markdown entries for a target and scope.
2. Upsert those entries into SQLite.
3. Delete SQLite memory rows in that same target/project scope whose normalized content is absent from Markdown.
4. Perform the upsert/delete set transactionally.

Reconciliation runs on the existing startup/backfill path and after operations that rewrite Markdown. It never deletes indexed session messages and never crosses global/project scopes.

### Corruption recovery storm (issue #96)

Only one process may recover a given `sessions.db` at a time. Recovery will use an atomic lock directory adjacent to the database and owner metadata. Other processes wait for a bounded interval, then reopen the database produced by the owner instead of starting another rebuild.

Safety controls:

- stale lock takeover after a bounded recovery window;
- a persistent circuit-breaker marker after repeated failed recoveries in a short window;
- cleanup of abandoned rebuild temporary files;
- retention cap for corrupt database backup sets;
- release locks in all success/failure paths.

Normal database open and corruption-free writes remain lock-free.

### Child prompt privacy (issue #95)

Sensitive review, consolidation, correction, and flush prompts must never appear in process arguments. `execChildPrompt` will:

1. create a unique temporary UTF-8 file with mode `0600`;
2. pass only Pi's `@<path>` file reference in argv;
3. use the same file for an override retry;
4. remove the file in `finally`, including timeout, abort, and thrown-error paths.

Tests will assert that a unique secret marker is absent from every spawned command and absent after cleanup.

### Child auth adapters (issue #94)

Child Pi remains isolated with `--no-extensions`, but required provider adapters can accompany Hermes:

- preserve explicitly supplied parent `-e`/`--extension` paths without duplicating Hermes;
- add a `childExtensionPaths` configuration list for settings-installed adapters;
- automatically include the installed `pi-claude-oauth-adapter` entry point when present;
- normalize, deduplicate, and require existing files before appending `-e` arguments.

No credential contents are read or logged. Missing optional adapters do not fail non-Claude users.

## Integration and delivery

The combined `hardening/confirmed-bugs` branch will contain one focused commit per bug family. PR #100's branch is not modified. Existing PR #99 is incorporated with attribution; PR #97 is ported with its review corrections and attribution. Issues #94, #95, #96, and #98 receive separate upstream PRs so maintainers can review them independently.

After the combined branch passes verification, the local Pi package setting will be pinned to its exact commit and every supervisor will reload at a safe boundary. The prior pinned commit remains available for rollback.

## Testing

Every production change follows red-green-refactor. Required regressions:

- same-size external Markdown rewrite is detected before add/replace/remove;
- concurrent same-target consolidation starts exactly one child;
- lock disappearance during acquisition retries successfully;
- test cleanup cannot hang when assertions fail;
- Markdown deletion prunes only the matching SQLite target/project scope;
- reconciliation is idempotent and preserves unrelated scopes/session rows;
- concurrent corrupt opens produce one rebuild and bounded artifacts;
- stale recovery locks are reclaimed, repeated failures trip the circuit breaker, and successful recovery clears it;
- secret child prompts never appear in argv and temporary files are always removed;
- override retry reuses the protected prompt transport;
- configured, inherited, and auto-detected auth adapters are deduplicated and passed to both attempts.

Verification gates:

- focused tests for each bug;
- `npm run check`;
- `npm test` (all test files);
- clean `git diff --check`;
- live Node-24 Pi smoke for memory search, child prompt transport, and extension loading;
- Herdr verification that supervisors progress without duplicate repair lanes or process storms.

## Non-goals

- PR #48's bundled document-generator skills;
- issue #47's prompt-guideline redesign;
- new memory features, user-interface changes, or generic job management;
- changing Pi core or its compaction algorithm;
- merging or rewriting other contributors' upstream branches.
