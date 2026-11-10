# Pull request body

Every PR body a factory skill writes follows this template, unless the repo has its own (`.github/pull_request_template.md` or one its `AGENTS.md` names). The repo's template wins; the writing rules below still apply inside it. Fill the angle brackets from the work, and drop any part marked "when" that doesn't apply.

## Writing rules

- **Reader:** a developer who isn't on the project. They should understand the PR from the PR alone.
- **Place it:** say in a sentence or two where the change sits in the overall system.
- **Explain project names, not dev terms:** explain a project-specific name the first time it appears, using the repo's glossary where it covers it. Leave common, googleable dev terms (worktree, webhook, OAuth, pull request) unexplained.
- **Length:** a full-form body runs about 30 to 60 lines. Detailed evidence and review back-and-forth go in a tracker comment, which the PR may link to.
- **Leave out:** preamble, file lists, review history, follow-up lists, post-merge closeout steps, and private details (people's names, machine names, workspace ids).

## Pick a form

- **Short form:** for tiny PRs, where nothing changes at runtime and reverting is trivial (a docs fix, a pinned dev tool, a typo).
- **Full form:** everything else.

Skill or template text that agents follow counts as a runtime change: agents run it. A change that migrates other repos' files (a setup changelog entry, say) is never trivial to revert, since a revert here won't undo what already ran there.

## Short form

```markdown
<A paragraph: what was wrong or missing, and what this PR changes.> For <ABC-123>.

**Why <choice>:** <the reason behind the one choice a reviewer might question, when there is one>.

**Checked:** <what you ran or compared, and that it passed>.
```

## Full form

Every full-form body includes one visual right after the Summary's opening sentences:

- **Small:** 3–5 lines.
- **Plain words:** use the same language as the surrounding prose, with no code expressions, function signatures or SQL.
- **Shape:** use **Steps** for a flow (`request → check → result`), **Before and after** for a behavior change, or **Who sees what** for permissions or routing.
- **Format:** default to a `text` block so it also reads well in `gh pr view` and Linear's linkback. Use Mermaid only for real branching, such as a state machine.
- **Prose:** put a one-sentence plain summary immediately above the visual, so it confirms what the prose already explains.

For example, **Who sees what**:

Each person can see and change only their orchestra's sections.

```text
Working for Orchestra A  ──▶  sees and changes only A's sections
Working for Orchestra B  ──▶  sees and changes only B's sections
No orchestra set         ──▶  sees nothing
```

````markdown
## Summary

<What the user or system can now do, in plain words.> <A sentence or two placing the change in the overall system.>

```text
<One visual following the standard above.>
```

<What the change does, in a short paragraph or a few bullets. One clause on what's deliberately left out of this change.>

**Why <choice>:** <the reason, for any choice that looks surprising. Other judgment calls only when a reviewer would care.>

For <ABC-123>.
Related to <ABC-124>: [<title>](<issue URL>)

## Evidence

- **Before:** <what failed, naming the test that failed before the fix>.
- **After:** **<the headline result>**, <naming the test that passes now>.

| <Case> | <Outcome> |
| ------ | --------- |
| <a small table, when several cases have different outcomes> | |

<The Test plan as numbered steps, for changes a person can see or use.>

1. <step>

<One closing line on what wasn't verified, when something wasn't.>

## Merge Danger

**Door:** <one-way or two-way>. <Why, when it isn't obvious.>

**Blast Radius:** <one word>. <What could break, and for whom.>

## What you need to do

<Only when a person must act. Open with "Merging changes nothing that's running." when that's true.>

**Before merge**

- [ ] <step>

**After merge**

- [ ] <step>

**After pulling**

- [ ] <step>
````

Keep only the checkbox groups that have steps. Write each step so the maintainer can do it without working anything out:

- **Something to paste:** under the checkbox, a fenced block with the exact command or prompt, then one line on what a pass looks like.
- **Existing state:** point the step at an issue, branch or file that already exists. Never ask the maintainer to make a scratch one.
- **Reinstall first:** when the PR changes installed skills, the first **After merge** step is the reinstall command from the README:

  ```sh
  npx skills add mcwestling/factory --skill '*' -g
  ```

Put the issue id in the body in either form, so the tracker links the PR.
