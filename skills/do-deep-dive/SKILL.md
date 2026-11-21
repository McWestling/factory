---
name: do-deep-dive
description: Research one big question in depth and deliver a single long HTML report to read later, with a verdict, evidence marked by how it was checked, a recommendation, a way to flag passages for discussion, and a link that opens over Tailscale.
disable-model-invocation: true
---

`/do-deep-dive <the question>`

The session researches one question, asks the user a few framing questions first, and writes one HTML report into the reports folder. The user reads it in a browser, flags passages, and pastes the flags back for discussion.

## The brief

Take these from the user's message; ask for whichever are missing in the framing round.

- **Question**, in one sentence.
- **Background:** what exists and where it lives (repos, docs, tracker projects, links).
- **Report parts**, in order, 3 to 8 of them, best content only.
- **Out of scope.**

## Rules

1. **Read-only.** Change nothing in any repo, tracker or outside service. The only files you write are in the report folder, and the only other change is the report server and `tailscale serve` in [Output and link](#output-and-link).
2. **Privacy.** Never put project, product, company or person names into outside searches or requests. Search for the generic thing.
3. **Lightest option first.** Every recommendation starts with the cheapest thing that could work. "Don't do this" and "do nothing yet" are always allowed answers.

## Step 1: framing round, before any expensive work

Skim for a few minutes at most: the background sources, their current status, recent activity. Then ask the user 3 to 5 multiple-choice questions with AskUserQuestion (if that tool is missing, ask in chat). Always cover:

- **Status of each thing in scope:** active, frozen, being replaced, not started. Never assume something is still being developed, or that a plan that isn't written yet is a gap rather than simply next.
- **Horizon:** a date or deadline, or none.
- **What counts as must-have**, and what can wait.
- **What is already decided** and must not be reopened.
- One or two questions specific to the topic.

Give each question a recommended default, marked as such.

**If the user doesn't answer:** don't stall. Take the defaults, carry on, and put a "Framing I assumed" box directly under the verdict: each assumption, why you picked it, and what in the report changes if it is wrong. Ask the same questions again in your final message.

**Second round:** if research overturns the framing (something turns out frozen, replaced or already decided), ask again before writing.

## Step 2: research

- Use sub-agents for code walks, document walks and outside research. Give each one a narrow question and require sources: `path:line`, a URL, or the command it ran.
- Have sub-agents append findings to `findings.md` in the report folder, so a rewrite on new framing doesn't repeat the research.
- **Spot-check before it goes in.** Every claim the verdict or the top recommendation rests on, and each sub-agent's biggest claims, you open and read yourself.
- **Absence is a claim.** "We don't have X" or "no competitor offers Z" may be written only after a search you ran yourself, worded with its scope: "no X found in <where>, searching for <terms>". An absence you inferred and didn't search for is marked unverified, or left out.
- **Counts and approximations.** Say when a number is approximate, and when a count comes from one page of a longer list.
- Every finding carries one status: **ran** (executed it and saw the result), **read by me**, **read by sub-agent** (not rechecked), **unverified**.

## Step 3: write the report

Copy [report-template.html](report-template.html) and fill it. Set `data-report` on `<html>` to `<folder name>@v<n>`; leave the flag layer at the end of the file unchanged. The skeleton is the same for every topic:

1. **Header.** Topic, date, version, one line on what was and wasn't touched. On a rewrite, one sentence on what changed and which earlier advice is withdrawn.
2. **Verdict box.** The answer in two or three sentences, and how sure you are.
3. **Your answers, and what each one costs**, or the "Framing I assumed" box.
4. **The parts from the brief**, in order. For each, pick the block that fits: a findings table with a status column; an option comparison (lightest first); a before/after pair, only when something changes shape; a sequence for order and dependencies; a diagram (Mermaid when graph-shaped, hand-built boxes when emphasis matters). Keep prose short.
5. **Found on the way** (optional): bugs, drift, contradictions between sources, each with where and its status.
6. **Top recommendation box**, with links to the parts it rests on.
7. **Open questions, each with the default I used**, then "Calls I made".
8. **Footer:** "Which of these would you like to explore?"

Use the user's own terms (the project glossary if there is one). Plain language.

## Output and link

- Folder: `~/Reports/<yyyy-mm-dd>-<short-slug>/`. Lower case, hyphens, no spaces. Never a temp or scratchpad path, never inside a repo.
- The current version is `index.html`. Before a rewrite, save the old one as `v1.html`, `v2.html` and so on.
- **Always return a Tailscale link.** `~/Reports` is served on localhost and published to the user's tailnet over HTTPS:

  1. Start the local server if it isn't answering, then check it answers. If it still doesn't (port 8765 taken by something else, say), say so and give only the `file://` link.

     ```sh
     curl -sf -o /dev/null http://127.0.0.1:8765/ || { (nohup python3 -m http.server 8765 --bind 127.0.0.1 --directory "$HOME/Reports" >/dev/null 2>&1 &); sleep 1; }
     curl -sf -o /dev/null http://127.0.0.1:8765/
     ```

  2. Run `tailscale serve status`. If it shows `/ proxy http://127.0.0.1:8765`, it is already published. If it shows anything else at `/`, don't replace it: say so and give only the `file://` link. Otherwise publish it with `tailscale serve --bg 8765`.
  3. Look up the address: `tailscale status --json | python3 -c "import json,sys; print('https://' + json.load(sys.stdin)['Self']['DNSName'].rstrip('.') + '/')"`.
  4. Fetch `<that address><folder>/` yourself and confirm it answers 200 before giving it to the user.

  Never bind the server to the whole local network. If Tailscale isn't available, say so and give the `file://` link instead.

## Review loop

The user flags passages in the page (Option-click, or the Flag button on touch) and pastes the result of "Copy notes" into the chat. When notes arrive: answer each one in chat, grouped by section, and say which are decisions. Flags are attached by position, so fold decisions in by changing the text of existing paragraphs, bullets, rows and headings only, never adding or removing one. A change that needs more is a new version: save the old one and write a new one, whose new `data-report` starts it with no flags.

## Final message

In this order: the Tailscale link, then the `file://` path, then the verdict in up to three lines, any framing questions still unanswered, and "Which of these would you like to explore?"
