# AGENTS.md

Factory holds workflow skills and, later, the code, contracts and configs behind them. See the [README](README.md) for what each skill does.

## Issue tracker

The workspace values the skills read are in [`docs/issue-tracker.md`](docs/issue-tracker.md).

## Planning sessions

Planning sessions (`do-post-its`, `do-triage`, `do-refine`) can run here for any repo the tracker routes to. Find another repo's checkout through `orca repo list --json`, matching its remote, and read its `AGENTS.md` before surveying its code. Read other checkouts only; never edit them.

## Pull requests

- **Review:** no PR autopilot in this repo. PRs open as drafts; the maintainer marks them ready and merges.

## Tool stack

The tool stack and its defaults live in Linear. [`docs/issue-tracker.md`](docs/issue-tracker.md#tool-stack) links the document.

## Scripts

Write scripts in TypeScript by default, run directly with Node (no build step). Use Python 3 with only the standard library for tools that ship into repos regardless of their stack, like [Factory Verifier](https://linear.app/mcwestling/project/factory-verify-00114d9892fe/overview), or when Python's standard library makes the script much simpler, like parsing TOML. Don't add Ruby, or shell scripts longer than a few lines.

## Checks

Run these before every push; all three must pass.

- **Delegator and setup:** `cd packages/delegator && npm test`. It typechecks, then runs every test. If `tsc` is missing, run `npm ci` there first.
- **Verifier, Python:** `python3 packages/verifier/factory-verifier.test.py`. It needs Python 3.11 or newer. If `python3` is older, look for a newer one before calling it missing, for example `ls /opt/homebrew/bin | grep python3`.
- **Verifier, Node:** `node --test packages/verifier/autopilot.test.mjs`.

This repo holds Factory Verifier's source but doesn't adopt it: there is no `scripts/factory-verifier` and no preflight to run here. The checks above are the full check.

A test that fails after your change is yours until you show it also fails on `main`.

## Where things go

The repo is organised by kind of thing. Add a folder only when its first file lands; never commit empty folders.

- **Skills:** `skills/<name>/`, with `SKILL.md` and `agents/openai.yaml`.
- **Shared code:** `packages/<name>/`.
- **Stack packs:** `packs/<name>/`.
- **Tool configs:** `tools/<name>/`.
- **Prose contracts:** `docs/<contract>.md`.
- **Glossary:** `GLOSSARY.md` at the root. Add or change a term in the PR that brings it in.
- **Example config and schemas:** `*.example` files and machine-readable schemas sit beside the code that reads them. The real config is gitignored: add its path to `.gitignore` in the same PR.

## Open source

This repo is built to be published. Never commit secrets, personal data, machine names, workspace ids or Cloud Inbox URLs. Use placeholders such as `ABC-123` for ticket ids, and commit `*.example` files instead of real config. The one exception is `docs/issue-tracker.md`: it is McWestling's real tracker config, committed so cloud agents can read it, and it holds nothing private.
