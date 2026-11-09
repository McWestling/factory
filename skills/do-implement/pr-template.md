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

## Short form

```markdown
<A paragraph: what was wrong or missing, and what this PR changes.> For <ABC-123>.

**Why <choice>:** <the reason behind the one choice a reviewer might question>.

**Checked:** <what you ran or compared, and that it passed>.
```

## Full form

````markdown
## Summary

<What the user or system can now do, in plain words.> <A sentence or two placing the change in the overall system.>

```text
<A small flow diagram, when there's a flow.>
```

<What the change does, in a short paragraph or a few bullets. One clause on what's deliberately left out of this change.>

**Why <choice>:** <the reason, for any choice that looks surprising. Other judgment calls only when a reviewer would care.>

For <ABC-123>. <Links to issues filed during the work, when there are any.>

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

Keep only the checkbox groups that have steps. Put the issue id in the body in either form, so the tracker links the PR.
