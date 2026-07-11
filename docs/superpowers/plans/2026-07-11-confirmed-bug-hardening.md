# Confirmed Bug Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix confirmed upstream bugs #94, #95, #96, #97, #98, and #99, ship reviewable upstream PRs, and deploy one verified combined fork commit to the live Pi supervisors.

**Architecture:** Keep Markdown authoritative, serialize destructive cross-process work with filesystem locks, and keep sensitive child prompts out of argv. Each bug family is an independent commit and test cycle; PR #100 remains untouched while the local hardening branch combines all fixes.

**Tech Stack:** TypeScript, Node.js 24/26, `node:test`, `better-sqlite3`, Pi extension API, Git/GitHub through `gh-axi`, Herdr.

## Global Constraints

- Exclude feature request issue #47 and feature PR #48.
- Keep upstream PR #100 focused at commit `c1fe550151ba07cd1b0f34b8c22b4e0d8d9b5cd8`.
- Follow red-green-refactor for every production change.
- Preserve PR #97 and #99 contributor attribution.
- Never expose prompt contents, credentials, or auth material in argv, logs, PR bodies, or tests.
- Pin the live package to an exact combined commit, never a floating branch.

---

### Task 1: External Markdown Write Protection (PR #99)

**Files:**
- Modify: `src/store/memory-store.ts`
- Test: `tests/store/memory-store.test.ts`

**Interfaces:**
- Produces: `syncTargetFromDiskIfChanged(target): Promise<void>` and exact-content fingerprints for `memory`, `user`, and `failure` files.
- Preserves: frozen `MemorySnapshot`; only mutable entry arrays refresh.

- [ ] **Step 1: Add failing same-size external rewrite tests**

Load a store, externally replace a Markdown entry with different text of the same byte length, then call `add`, `replace`, and `remove`. Assert external text survives and stale text is never resurrected.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test --test-name-pattern='external file changes' tests/store/memory-store.test.ts`

Expected: FAIL because mutations use stale in-memory arrays.

- [ ] **Step 3: Port PR #99 with attribution and strengthen its fingerprint**

Use a SHA-256 digest because `mtime:size` can miss same-size/coarse-timestamp rewrites:

```ts
private async fingerprintOf(filePath: string): Promise<string> {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}
```

Refresh only the changed target before `_add`, `replace`, and `remove`, and update the fingerprint after atomic rename.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm run check`. Preserve PR #99 author attribution in commit trailers.

---

### Task 2: Consolidation Process Locking (PR #97)

**Files:**
- Modify: `src/handlers/auto-consolidate.ts`
- Test: `tests/handlers/auto-consolidate.test.ts`

**Interfaces:**
- Produces: atomic per-target lock acquisition returning `{ release(): Promise<void> } | null`.
- Consumes: `MemoryConfig.consolidationTimeoutMs` and extension storage identity.

- [ ] **Step 1: Add failing concurrency and disappeared-lock tests**

Test simultaneous same-target consolidations and assert one `pi.exec` call. Add a race where the competing lock disappears between `mkdir(EEXIST)` and `stat`; acquisition must retry.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test --test-name-pattern='lock|duplicate consolidation' tests/handlers/auto-consolidate.test.ts`

Expected: FAIL with two child executions or no retry.

- [ ] **Step 3: Port PR #97 and correct both review findings**

Use atomic `mkdir`, owner metadata, timeout-plus-grace staleness, `ENOENT` retry, and `finally` release. Tests must always unblock the first fake child:

```ts
try {
  const second = await triggerConsolidation(pi, store, "memory");
  assert.equal(second.consolidated, false);
  assert.equal(execCalls.length, 1);
} finally {
  releaseExec();
  await first;
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm run check`. Preserve PR #97 author attribution.

---

### Task 3: Protected Child Prompt Transport (Issue #95)

**Files:**
- Modify: `src/handlers/pi-child-process.ts`
- Test: `tests/handlers/pi-child-process.test.ts`

**Interfaces:**
- Produces: `withChildPromptFile(prompt, fn)` creating mode-`0600` temporary files and deleting them in `finally`.
- Changes: child argv contains `@<path>`, never raw prompt text.

- [ ] **Step 1: Add failing privacy/cleanup tests**

Use a unique secret marker and assert it is absent from every `pi.exec` argv. Read the `@path` during fake exec to prove content delivery, then assert the file is gone after success, error, abort, and override retry.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test --test-name-pattern='argv|prompt file|temporary' tests/handlers/pi-child-process.test.ts`

Expected: FAIL because the raw prompt is currently the final argv element.

- [ ] **Step 3: Implement protected file transport**

Create one unique directory/file per call, write with `{ mode: 0o600, flag: "wx" }`, pass `@${path}`, reuse it for retry, and remove the directory in `finally`.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm run check`. Commit `fix: keep child prompts out of argv`.

---

### Task 4: Child Auth Adapter Propagation (Issue #94)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/handlers/pi-child-process.ts`
- Test: `tests/config.test.ts`
- Test: `tests/handlers/pi-child-process.test.ts`

**Interfaces:**
- Produces: `MemoryConfig.childExtensionPaths?: string[]`.
- Produces: normalized/deduplicated `-e <existing path>` arguments for configured, inherited, and auto-detected auth adapters.

- [ ] **Step 1: Add failing config and invocation tests**

Assert valid string arrays load, invalid values are ignored, duplicate paths collapse, missing paths are ignored, explicit parent `-e` paths survive, Hermes is not duplicated, and an installed Claude adapter entry is appended.

- [ ] **Step 2: Verify RED**

Run the two focused test files. Expected: FAIL because child extension paths are discarded.

- [ ] **Step 3: Implement minimal adapter discovery**

Keep `--no-extensions`; append Hermes plus existing configured/inherited extension paths. Detect only confirmed `pi-claude-oauth-adapter/extensions/index.ts` npm paths without reading credentials. Apply identical extension args to override and retry invocations.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm run check`. Commit `fix: preserve child auth adapters`.

---

### Task 5: Markdown-to-SQLite Reconciliation (Issue #98)

**Files:**
- Modify: `src/store/sqlite-memory-store.ts`
- Modify: `src/handlers/sync-markdown-memories.ts`
- Modify: full-Markdown-rewrite callers
- Test: `tests/handlers/sync-markdown-memories.test.ts`
- Test: `tests/store/sqlite-memory-store.test.ts`

**Interfaces:**
- Produces: `reconcileMarkdownMemoryScope(dbManager, entries, target, project): { upserted: number; removed: number }`.
- Guarantees: deletion is limited to the exact target/project scope and never touches session/message tables.

- [ ] **Step 1: Add failing orphan-pruning tests**

Seed SQLite with a matching row, same-scope orphan, another-target row, and another-project row. Reconcile and assert only the same-scope orphan is deleted. Run twice for idempotence.

- [ ] **Step 2: Verify RED**

Run focused sync/store tests. Expected: FAIL because sync only inserts/updates.

- [ ] **Step 3: Implement transactional scoped reconciliation**

In one transaction, upsert parsed Markdown entries, query rows for the exact target/project, compare normalized content, and delete IDs absent from Markdown. Wire startup/manual sync and post-rewrite paths to this primitive.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm run check`. Commit `fix: prune orphaned memory mirror rows`.

---

### Task 6: Single-Owner Corruption Recovery (Issue #96)

**Files:**
- Modify: `src/store/db.ts`
- Test: `tests/store/db.test.ts`

**Interfaces:**
- Produces: recovery lock adjacent to `sessions.db`, bounded wait/reopen behavior, failure circuit state, artifact cleanup, and backup retention.
- Preserves: corruption-free opens remain lock-free.

- [ ] **Step 1: Add failing multi-manager recovery tests**

Simulate multiple managers opening one corrupt database. Assert one rebuild, bounded backup/temp counts, stale-lock takeover, circuit opening after repeated failures, and circuit reset after success.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test --test-name-pattern='corruption recovery' tests/store/db.test.ts`

Expected: FAIL because managers independently recover.

- [ ] **Step 3: Implement synchronous single-owner coordination**

Acquire an adjacent atomic lock directory before rebuild. Non-owners wait a bounded interval, then reopen the owner's result. Store failure timestamps, trip after three failures in five minutes, retain three corrupt backup sets, and delete abandoned `.rebuild-*.tmp*` files.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm run check`. Commit `fix: serialize corrupt database recovery`.

---

### Task 7: Verification, Upstream Delivery, and Live Pin

**Files:**
- Verify all changed source/tests
- Create PR bodies under `/tmp` only

- [ ] **Step 1: Run repository gates**

Run `npm run check`, `npm test`, `git diff --check`, and `git status --short --branch`.

Expected: typecheck exit 0; all test files pass; no diff errors; only intended commits.

- [ ] **Step 2: Publish separate branches and PRs**

Keep PR #100 unchanged and do not duplicate PR #97/#99. Create one upstream PR each for #94, #95, #96, and #98 with reproduction, red-green evidence, and exact tests.

- [ ] **Step 3: Build combined exact pin**

Push `hardening/confirmed-bugs`, record its full SHA, replace the global package source with that SHA, and confirm `pi list` resolves the fork cache to it.

- [ ] **Step 4: Live verification**

Run Node-24 Pi smoke tests for search, protected child prompts, and reconciliation. Reload Herdr supervisors at safe boundaries, inspect process trees and session progress, and prove no duplicate repair lanes, consolidation children, or recovery storms.

- [ ] **Step 5: Completion audit**

Map every spec requirement to tests, PR URLs, commit SHAs, Pi resolution, and Herdr state before marking the goal complete.
