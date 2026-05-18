# SmithersBot Public Launch — Release History Runbook

**DO NOT EXECUTE INSIDE THIS GOAL.**

This file is an operator-only runbook. It captures the exact manual commands the
maintainer must run, by hand, to publish SmithersBot v0 as a clean public history
without prior internal commits or audit artifacts. The Stage 2J cleanup goal that
generated this file is explicitly forbidden from executing any of these steps.

The current branch already contains the cleaned, presentation-ready tree at HEAD.
The orphan/squash step below collapses that tree into a single root commit on a
fresh branch — losing internal history — and is irreversible without a backup.

## Prerequisites (manual, before starting)

1. Confirm you are on the cleaned branch and the working tree is clean.

   ```sh
   git status
   git diff --quiet && git diff --cached --quiet && echo CLEAN
   ```

2. Capture the current HEAD as the pre-orphan reference. Save this somewhere
   outside the repo (e.g. a sticky note or password manager):

   ```sh
   git rev-parse HEAD
   ```

3. Confirm the archive branch still exists locally and contains RELEASE_AUDIT:

   ```sh
   git rev-parse internal/stage2-audit-archive
   git ls-tree internal/stage2-audit-archive --name-only -r | grep -c '^RELEASE_AUDIT/'
   ```

   The count must be ≥ 94. If not, **STOP** — the audit history is not safely
   archived and an orphan publish would lose it permanently.

4. Make a safety tag on the current branch so the pre-orphan tip is recoverable:

   ```sh
   git tag -a pre-public-launch-$(date +%Y%m%d) -m "Pre-orphan snapshot before SmithersBot public launch"
   ```

## Step 1 — Create the orphan public-launch branch

Run these by hand. Do not script them inside a goal.

```sh
# Start from the cleaned branch HEAD
git checkout --orphan public-launch
git add -A
git commit -m "SmithersBot v0: initial public release"
```

## Step 2 — Verify the orphan branch has exactly one commit

```sh
git log --oneline public-launch | wc -l
# Expected output: 1
```

If the count is not exactly 1, the orphan checkout did not behave as expected.
Investigate before proceeding.

## Step 3 — Compare the orphan tree to the pre-orphan tree

Substitute `<pre-orphan-ref>` with the SHA captured in Prerequisites step 2 (or
the safety tag from step 4).

```sh
git diff --stat <pre-orphan-ref> public-launch -- .
# Expected: no differences (empty output). A non-empty diff means the orphan
# commit's tree drifted from the pre-orphan tree and must be reconstructed.
```

For a stricter check (mode, content, and tree hash):

```sh
git diff --stat --no-renames <pre-orphan-ref> public-launch -- .
git rev-parse <pre-orphan-ref>^{tree}
git rev-parse public-launch^{tree}
# The two tree hashes must match exactly.
```

## Step 4 — Remove non-public remotes before any push

```sh
git remote -v
# Expected entries to remove if present: openclaw, personal, upstream, fork
git remote remove openclaw    || true
git remote remove personal    || true
git remote remove upstream    || true
git remote remove fork        || true
git remote -v
# Confirm only the intended public remote remains.
```

**Do not push** until you have re-verified `git remote -v`. The goal of these
removals is to make an accidental `git push --all` impossible.

## Step 5 — Fresh-clone verification (in a scratch directory)

After the eventual public push (which is NOT part of this runbook), clone the
public repo into a throwaway location and confirm the v0 surface still works
end-to-end. This step is the public-launch smoke test and must pass before the
launch is considered complete.

```sh
rm -rf /tmp/smithersbot-verify
git clone <public-repo-url> /tmp/smithersbot-verify
cd /tmp/smithersbot-verify
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
node scripts/run-node.mjs --help
```

All commands must exit 0. If any step fails, the public release is not
acceptable and must be fixed before announcement.

## Closing reminders

- This file is **operator-only**. Do not invoke it from `/goal`, `/loop`, or any
  scheduled agent. Each step is irreversible without manual recovery.
- The orphan publish discards all internal history. Make sure
  `internal/stage2-audit-archive` is preserved locally (and optionally pushed to
  a private archive remote) before running Step 1.
- Do not delete `internal/stage2-audit-archive` until after the public launch
  has been verified and a redundant archive copy exists outside this clone.
- Re-run `git remote -v` before every `git push` during the launch session. The
  cost of a one-second check is much smaller than the cost of pushing internal
  history to a public remote.
