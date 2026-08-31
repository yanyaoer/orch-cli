# Worktree Clone Lifecycle

## Goal

Provide fast, isolated agent worktrees without copying Git metadata, leaking
writes through workspace symlinks, depending on `/tmp`, or automatically
discarding work that cannot be proven safe to remove.

## Out of Scope

- Lane memory or another code-memory provider
- `knowledge_candidates` in result schemas
- Tree-sitter parsing or symbol anchoring
- A daemon, database, or other resident cleanup service
- Adopting an existing branch implicitly
- Submodule repositories: a copied submodule `.git` pointer resolves against
  the clone's worktree gitdir and breaks; cloning them is unsupported

## Constraints

- Copy-on-write remains fail-closed. If the destination filesystem cannot
  provide APFS clonefile or a Linux reflink, cloning fails before registering a
  worktree; it never silently becomes a full copy.
- The destination must be outside the source worktree and on the same CoW
  filesystem.
- Existing callers keep the three-argument clone function and boolean removal
  result. New policy is optional and defaults to snapshot semantics.
- Root `.git` and `.jj` entries are never copied.
- Policy paths are relative to the worktree. They cannot escape with `..` or
  select VCS metadata.

## Creation

Creation is register-first:

1. Resolve the source and destination to canonical paths and probe CoW support
   in the destination parent.
2. Register the final destination using `git worktree add --no-checkout`.
3. Materialize one of the two supported modes around that worktree's real
   `.git` pointer.
4. Retarget workspace-internal absolute symlinks, apply the configured external
   symlink policy, set an upstream when possible, and record provenance.
5. On any failure, unregister the worktree, remove partial content, prune the
   registration, and delete a branch created by this attempt.

No temporary worktree slot, `.git` graft, `git worktree repair`, or copy of the
object store is part of this flow.

### Materialization Modes

`snapshot` copies the source's current tracked, dirty, untracked, and ignored
workspace state using CoW. It is the default for handoff, review fanout, and
investigation because all workers must see the same captured target.

`warm-head` lets Git materialize tracked files from the captured HEAD and CoW
copies only explicitly configured cache paths. An existing cache path must be
ignored by Git; a missing cache is skipped. This mode is intended for a new
implementer that needs a clean base with selected build caches.

Exclude globs apply only to copied material. They can omit nested paths without
copying those entries first.

### Symlinks

- An absolute symlink whose canonical target is inside the source is rewritten
  to the corresponding target inside the clone.
- A relative symlink is classified in the clone's own frame, the only frame
  that matters at runtime. One that resolves inside the clone stays relative;
  one that exits the clone and re-enters the source by name is rewritten to
  the corresponding target inside the clone; anything else is external.
- A link that escapes through an intermediate symlink is external.
- External links use one explicit policy: `preserve`, `warn`, or `reject`.
  `warn` is the default and preserves the link while reporting it.

### Fanout Storage

Fanout clones live under a private sibling hierarchy:

```text
<repo-parent>/.orch-worktrees/<repo-name>/<thread>-<nonce>
```

The storage directories are real directories with mode `0700`. A symlink or
non-directory substitution is rejected. Keeping the clone beside the source
preserves the same-filesystem CoW precondition on Linux as well as macOS.

### Upstream

A newly created feature branch chooses its upstream in this order:

1. Explicit target branch
2. `origin/HEAD`
3. `origin/main`
4. `origin/master`
5. `origin/trunk`

Missing refs are skipped without making clone creation fail.

## Provenance and Loss Detection

Each registered clone stores versioned provenance in its linked-worktree Git
directory, not in copied workspace content. It records source, destination,
captured HEAD, branch, upstream, mode, copied caches, excludes, symlink policy
and findings, creation time, and hashes of the inherited index, worktree, and
untracked baseline.

Automatic removal is allowed only when one of these conditions is proven:

- HEAD is unchanged and index, worktree, and untracked state exactly match the
  inherited baseline.
- HEAD changed to a commit reachable from a named ref, index and worktree are
  clean, and untracked state still matches the inherited baseline.

This detects ordinary edits, staging-only work, new untracked content, changing
an inherited dirty file, and restoring inherited dirt to HEAD. An unreachable
detached commit blocks removal. A clean commit on a named branch is retained by
that branch and does not block removal. An untracked nested repository — a
directory `git ls-files --others` does not enter — is pinned by a digest of
its HEAD, refs, user-authored gitdir metadata (config, hooks, info), and
recursive workspace state; a nested repository whose git resolution does not
describe the directory itself (a redirected worktree) is unverifiable. When
the digest cannot be computed, or no longer matches, removal is blocked.
Git-ignored content sits outside loss detection by contract: caches are
disposable, and removal discards them. Missing or mismatched provenance fails
closed; an operator can still use Git's explicit force-removal command to
discard the clone deliberately.

## Removal

Safe removal follows `park -> unregister -> sweep`:

1. Rename ignored, untracked, and declared cache paths into a private trash
   directory on the same filesystem.
2. Unregister and remove the much smaller worktree through Git.
3. Sweep the parked content in a detached one-shot process.

The park directory persists an index-to-path manifest before the first rename,
so a crash mid-park leaves enough to reassemble the clone by hand; the
manifest outlives any entry that cannot be restored.
If unregister fails while the worktree is still registered (for example a
locked worktree), all parked paths are renamed back before removal reports
failure. Git can also destroy the registration even though content deletion
failed; safety was proven before parking, so removal then completes the
deletion itself rather than leaving an orphaned tree.
Trash directories use the same real-directory and `0700` checks as
fanout storage. A killed sweep may leave reclaimable disk usage but cannot make
Git state or workspace content incorrect.

## Acceptance

- Registration exists before the first workspace entry is copied.
- Snapshot and warm-head produce their documented status and cache behavior.
- No link in the clone writes back into the source: absolute-internal and
  source-re-entering relative links are retargeted to the clone, and
  intermediate-link escapes obey external policy.
- Fanout clone paths never use `/tmp` and reject storage symlink substitution.
- Failure after registration leaves no clone, temporary slot, worktree entry,
  or newly created branch.
- Provenance is private, versioned, and sufficient to distinguish inherited
  state from later work.
- Automatic removal rejects potentially lossy states, preserves named-branch
  commits, restores parked caches on unregister failure, and removes proven-safe
  clones.

## Test Plan

```text
bun test src/worktree.test.ts
bun test
bun run build
bun run docs:check
git diff --check
```

The platform-independent lifecycle suite uses an injected copy backend. A
separate native smoke test exercises APFS clonefile where available; Linux CI
should additionally exercise the native reflink backend on Btrfs or XFS.
