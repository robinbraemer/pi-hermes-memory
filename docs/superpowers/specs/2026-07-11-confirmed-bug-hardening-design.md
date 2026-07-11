# Confirmed Bug Hardening Design

## Scope

Harden the fork against the six confirmed correctness, safety, privacy, and authentication failures open upstream. Feature requests, bundled skills, prompt-guideline redesign, and unrelated refactors are excluded.

The combined fork branch starts from `c1fe550` (bounded `session_search` output). Existing contributor authorship is preserved where upstream work was incorporated.

## Adopted upstream fixes

### External Markdown writes (PR #99)

Every mutation applies to the current Markdown source of truth. `MemoryStore` tracks a content-derived fingerprint for each target after load and save. Before add, replace, or remove, it reads the target, compares its fingerprint, and refreshes only that target if another Pi process, consolidation child, or manual edit changed it. A canonical per-file mutation lease serializes writers, and guarded publication preserves displaced inodes for bounded recovery. The frozen prompt snapshot remains unchanged.

This strengthens PR #99's `mtime:size` fingerprint because same-size or coarse-timestamp rewrites must also be detected.

### Duplicate consolidation processes (PR #97)

Consolidation acquires an atomic coordinator lease before launching a child Pi process. Leases are scoped by target and canonical storage identity, expire after the configured timeout plus grace, and are released in `finally`. A concurrent duplicate skips its child process.

The coordinator uses persistent ownership records and bounded stale-owner recovery rather than directory existence checks.

## Newly implemented confirmed bugs

### Markdown/SQLite reconciliation (issue #98)

Markdown remains authoritative. Markdown sync performs a true scoped reconciliation:

1. Parse all Markdown entries for a target and scope.
2. Upsert those entries into SQLite.
3. Delete SQLite memory rows in that same target/project scope whose normalized content is absent from Markdown.
4. Perform the upsert/delete set transactionally.

Reconciliation runs on the existing startup/backfill path and after operations that rewrite Markdown. It never deletes indexed session messages and never crosses global/project scopes.

### Corruption recovery storm (issue #96)

Only one process may recover a given `sessions.db` at a time. An adjacent SQLite lock coordinator grants shared access leases for normal database use and an exclusive lease for handle-free recovery. Other processes wait for a bounded interval and reuse the healthy database produced by the recovery owner instead of starting another rebuild.

Safety controls:

- stale-owner takeover after a bounded recovery window;
- a persistent circuit-breaker marker after repeated failed recoveries in a short window;
- cleanup of abandoned rebuild temporary files;
- retention cap for corrupt database backup sets;
- release locks in all success/failure paths.

Corruption-free access uses shared leases, allowing normal readers and writers to proceed concurrently while excluding recovery.

### Child prompt privacy (issue #95)

Sensitive review, consolidation, correction, and flush prompts never appear in process arguments. `execChildPrompt`:

1. create a unique temporary UTF-8 file with mode `0600`;
2. pass only Pi's `@<path>` file reference in argv;
3. use the same file for an override retry;
4. remove the file in `finally`, including timeout, abort, and thrown-error paths.

Tests will assert that a unique secret marker is absent from every spawned command and absent after cleanup.

### Child auth adapters (issue #94)

Child Pi remains isolated with `--no-extensions`, but required provider adapters can accompany Hermes:

- accepts a `childExtensionPaths` configuration list for explicitly trusted adapter entry points;
- automatically include the installed `pi-claude-oauth-adapter` entry point when present;
- normalize, deduplicate, and require existing files before appending `-e` arguments.

No credential contents are read or logged. Missing optional adapters do not fail non-Claude users.

## Testing

Every production change follows red-green-refactor. Required regressions:

- same-size external Markdown rewrite is detected before add/replace/remove;
- concurrent same-target consolidation starts exactly one child;
- stale coordinator ownership is recovered without overlapping consolidation children;
- test cleanup cannot hang when assertions fail;
- Markdown deletion prunes only the matching SQLite target/project scope;
- reconciliation is idempotent and preserves unrelated scopes/session rows;
- concurrent corrupt opens produce one rebuild and bounded artifacts;
- stale recovery locks are reclaimed, repeated failures trip the circuit breaker, and successful recovery clears it;
- secret child prompts never appear in argv and temporary files are always removed;
- override retry reuses the protected prompt transport;
- configured and auto-detected auth adapters are deduplicated and passed to both attempts.

Verification gates:

- focused tests for each bug;
- `npm run check`;
- `npm test` (all test files);
- clean `git diff --check`;
- live Node-24 Pi smoke for memory search, child prompt transport, and extension loading.

## Non-goals

- PR #48's bundled document-generator skills;
- issue #47's prompt-guideline redesign;
- new memory features, user-interface changes, or generic job management;
- changing Pi core or its compaction algorithm;
- merging or rewriting other contributors' upstream branches.
