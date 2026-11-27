# Contributing

ZeroCode is an open-source control plane for coding agents, hosted at
[github.com/feelmypain/zerocode](https://github.com/feelmypain/zerocode).

Small, focused bug fixes are the easiest to review and merge. Before opening a pull request for a
larger change or new feature, open an issue or discussion first to align on scope and design.

## How to help

- **Report bugs** with clear reproduction steps and the version you tested.
- **Triage duplicates and fixed issues.** Link the original issue/PR or note when an open issue no
  longer reproduces on the latest build.
- **Test open PRs** and share what you observed.

## Rules for a PR

<a id="prior-approval"></a>

### Scope

A PR should fix a bug or implement a change that maintainers have agreed on. A crash, a regression,
and a real performance problem are bugs. For larger changes, link the relevant issue.

<a id="vouched-features"></a>

Maintainers and vouched contributors in [.github/VOUCHED.td](.github/VOUCHED.td) may also open
focused feature PRs directly. Large architecture overhauls, new auth methods, or sweeping UI
rewrites should always be discussed first.

<a id="one-problem"></a>

### One problem per PR

Fix one problem. Include every change that fix needs across contracts, server, clients, tests, and
docs. Cleanup, refactors, and a second fix go in their own PRs.

<a id="verification"></a>

### Show that it works

Say how you found the bug (or what your change does), how you checked it, and what you saw.
"Tests pass" alone is not evidence.

UI changes need before and after screenshots. Add a short video when the change is about motion or
timing. Upload them to the PR rather than committing them to the repository.

<a id="models"></a>

### AI-assisted contributions

If an AI coding tool helped write the change, disclose the model and harness used, and verify every
change yourself before opening the PR.

<a id="open-pr-limit"></a>

### Open PR hygiene

Keep your open PR count small (up to 3 open PRs at a time for outside contributors) so reviews stay
focused and timely.

<a id="conflict-window"></a>

### Keep your PR mergeable

A PR that conflicts with its base branch gets a `needs-rebase` label. Rebase promptly so it stays
reviewable.

<a id="closure-and-reconsideration"></a>

### When a PR is closed

If a PR is closed due to missing context or scope issues, address the feedback and comment on the
PR or open a focused replacement PR linking the original.

## Branding and license

ZeroCode is distributed under the [MIT License](./LICENSE). See [TRADEMARK.md](./TRADEMARK.md) for branding details.

## Setup

See the [development runbook](docs/operations/00_development.md#first-checkout).
