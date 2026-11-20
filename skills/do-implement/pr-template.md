# Pull request body

Every PR body a factory skill writes follows this template, unless the repo has its own (`.github/pull_request_template.md` or one its `AGENTS.md` names). The repo's template wins; the writing rules below still apply inside it. Fill the angle brackets from the work, and drop any part marked "when" that doesn't apply.

## Writing rules

- **Reader:** a developer who isn't on the project. They should understand the PR from the PR alone.
- **Place it:** say in a sentence or two where the change sits in the overall system.
- **Explain project names, not dev terms:** explain a project-specific name the first time it appears, using the repo's glossary where it covers it. Leave common, googleable dev terms (worktree, webhook, OAuth, pull request) unexplained.
- **Headline first:** open each section with its main point in one sentence. Detail follows it. The skeleton's openers (Summary's first sentence, **Before** and **After**, **Door**) already do this.
- **No walls of text:** keep paragraphs to three sentences. Use bullets for parts and cases, one sentence each. **What you need to do** steps follow their own rules below.
- **Behavior, not mechanism:** say what changes for the user or the system. Leave function names, columns, flags and retry logic to the code, unless a reviewer needs one to judge the change.
- **Length:** a full-form body is at most 500 words above `## What you need to do`, **Questions along the way** included. In a repo's own template, count only the words you write. Check it before opening the PR, and after any body rewrite you make: `sed '/^## What you need to do/,$d' <body file> | wc -w`. Over the limit, cut in this order until it fits:
  1. **Evidence:** case tables past five rows, mutation checks, and each check command's result.
  2. **Summary:** mechanism and edge cases a reviewer doesn't need to judge the change.
  3. **Questions along the way:** the reasoning, down to the question and the choice.
  4. **Merge Danger:** failure modes past the main one.

  Never cut the **Place it** sentence, **Before** and **After** with their test names, the line on what wasn't verified, the `For` and `Related to` lines, or any **What you need to do** step. A body still over after these cuts goes out as it is.
- **Detail goes on the issue:** whatever you cut, and anything a first-time reader doesn't need (long evidence, case-by-case results, review history), goes in a comment on the tracker issue: the **PR opened** comment, or a new one for a later rewrite. The body points to it in one line naming the issue id, such as "Full results are on ABC-123."
- **Leave out:** preamble, file lists, review history, follow-up lists, post-merge closeout steps, and private details (people's names, machine names, workspace ids).

## Pick a form

- **Short form:** for tiny PRs, where nothing changes at runtime and reverting is trivial (a docs fix, a pinned dev tool, a typo).
- **Full form:** everything else.

Skill or template text that agents follow counts as a runtime change: agents run it. A change that migrates other repos' files (a tracker template change, say) is never trivial to revert, since a revert here won't undo what already ran there.

## Short form

```markdown
<A paragraph: what was wrong or missing, and what this PR changes.> For <ABC-123>.

**Why <choice>:** <the reason behind the one choice a reviewer might question, when there is one>.

**Checked:** <what you ran or compared, and that it passed>.
```

## Full form

Add one visual right after the Summary's opening sentences only when it shows something the prose can't: a flow with several steps, a before and after, or who sees what. Otherwise the body has none. When there is one, it follows these rules:

- **Small:** 3–5 lines.
- **Plain words:** use the same language as the surrounding prose, with no code expressions, function signatures or SQL.
- **Shape:** use **Steps** for a flow (`request → check → result`), **Before and after** for a behavior change, or **Who sees what** for permissions or routing.
- **Format:** default to a `text` block so it also reads well in `gh pr view` and Linear's linkback, with one plain line per step. Use Mermaid only for real branching, such as a state machine.
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
<One visual following the rules above, when it shows something the prose can't.>
```

<What the change does, in up to five one-sentence bullets. One clause on what's deliberately left out of this change.>

**Why <choice>:** <the reason for the one choice that looks most surprising, in a sentence or two, when there is one.>

For <ABC-123>.
Related to <ABC-124>: [<title>](<issue URL>)

## Evidence

- **Before:** <what failed, naming the test that failed before the fix>.
- **After:** **<the headline result>**, <naming the test that passes now, and that the repo's full check passes>.

| <Case> | <Outcome> |
| ------ | --------- |
| <up to five rows, when cases have different outcomes> | |

<The Test plan as numbered steps, for changes a person can see or use.>

1. <step>

<One closing line on what wasn't verified, when something wasn't.>

<"Full results are on ABC-123.", when detail went to the issue.>

## Merge Danger

**Door:** <one-way or two-way>. <Why, in a sentence, when it isn't obvious.>

**Blast Radius:** <one word>. <The main thing that could break, and for whom, in a sentence or two.>

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
- **Refresh first:** when the PR changes installed skills or a locally installed service, the first **After pulling** step is the repo's upkeep or reinstall command from its README, if it has one, with its pass line.
- **Setup:** when the PR changes what a checkout needs (dependencies, generated files, local tools), an **After pulling** step runs `scripts/setup`, never the install commands it holds.
- **New shell:** every **After pulling** command must work in a new shell at the repo root, with nothing left over from your session: no exported variables, no `cd`, no activated toolchain. Before writing the step, run it that way (for example `$SHELL -lc '<command>'` from the repo root, a new login shell) and fix the step or `scripts/setup` until it passes.

Put the issue id in the body in either form, so the tracker links the PR.
