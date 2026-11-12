---
name: do-post-its
description: Turn photos of handwritten notes (Post-its, notebook pages) or dictated jottings into Triage muses in the issue tracker. Use when the user shares a photo of notes, or dictates a pile of thoughts, and wants them captured.
---

People jot ideas down as they notice them, on Post-its, in a notebook or out loud, then hand over the pile. This skill is **capture**: every idea lands in **Triage** as a muse, in the user's own words. It doesn't refine, prioritize or decide anything; that waits for triage review with the user.

Get it right before getting it done. A misread filed as an issue costs more than a question asked now.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it.

**Asking.** Ask with AskUserQuestion where the client has it (multiSelect when picking several items, up to 4 questions per call), otherwise in chat.

## The tracker doc

The procedure lives here; the workspace values live in the repo's tracker doc. Find it through `AGENTS.md`, which names either a path in this repo or a doc in another repo (like `docs/issue-tracker.md` in `owner/name`); read another repo's doc from its checkout, found through `orca repo list --json`. If `AGENTS.md` names none, use `docs/issue-tracker.md`. Read it before filing. This skill uses these headings:

- **Tracker:** the tool, and how to reach it.
- **Team:** the team the muses go to.
- **Issue statuses:** the names for Triage and Backlog.
- **Labels:** the Product labels, and the Bug label that marks a defect; a Triage item without it is a muse.
- **Repo routing:** which product maps to which repo, to tell which product the repo you're in belongs to. When it isn't any product's repo, ask which product the notes belong to instead of inferring it.

Use only what the doc says. Where a value you need is missing (no doc, no team, no Product labels), ask the user, use the answer for this run, and offer to add it to the doc or to run `do-repo-setup`.

Reach the tracker only through the access the doc's **Tracker** section names. If that access is unavailable or unauthorized, stop and say so; don't fall back to a browser, the desktop app or the raw API.

## Steps

### 1. Transcribe

Write out every note **verbatim**: the header, any markers the user adds for audience or area (such as `(adm)`), every bullet, strikethroughs, arrows, and a description in words of any sketch. For dictation, the user's words are the note. Leave abbreviations as written; expand them in your reading, never inside the quote.

Put ❓ on anything you can't read or can't place: an illegible word, an unknown abbreviation, a sketch, a bullet with no subject ("fix subheading", but on which page?), an empty bullet.

### 2. Ground it

Take a short, bounded look at the product's codebase (another repo's checkout is in `orca repo list --json`; read it, never edit it) to narrow down what each note could mean: grep for quoted copy or labels, list the pages or routes a note names, check whether something the note implies already exists. The point is sharper questions and one line of context per issue. Don't read deeply and don't propose fixes.

### 3. Show your reading, then ask

Post the transcription with a one-line reading of each item, ❓ marks included, so the user can catch misreads you didn't flag.

Then ask about every ❓, with AskUserQuestion when it's available (up to 4 questions per call, as many rounds as it takes). Offer concrete options from your grounding and keep context in the option descriptions. An answer may reframe an item completely, such as a sketch that turns out to be about another page; go with what the user says.

Unless the user has already said, ask about **granularity** in the first round:

- **One muse per idea** (recommended): every bullet that could ship on its own gets its own issue. This fits one issue per PR, and triage can merge them later.
- **One muse per note**, with its bullets as a checklist.

File nothing until every ❓ is settled or the user says to file it as it stands.

### 4. Check for duplicates

List the team's Triage and Backlog issues; titles and labels are enough. When one clearly matches a new item, comment the new thought on it instead of filing a duplicate. When one is related but distinct, file the new muse and add a related-to relation.

### 5. File

Create the muses in parallel. Each one gets:

- **Status:** Triage.
- **Title:** a short imperative in plain words ("Combine the admin calendar and events pages"), not the note's shorthand.
- **Labels:** a Product label when the product is obvious, and the Bug label when the note describes a concrete defect. Nothing else: never create a label, never add area labels.
- **Nothing more:** leave priority, assignee, project, estimate, template and any suggested-dispatch line unset. Those belong to implementation issues, which refinement writes later.
- **Body:**

  ```markdown
  > <note header> — <the bullet, verbatim>

  <The user's clarification, quoted and attributed, if there was one.>

  <A line or two of grounding: which page or route, what exists today. No fixes.>

  _Captured from a Post-it, YYYY-MM-DD._
  ```

  Swap "Post-it" for the real source (notebook, dictation). If the item came from a note about something else, say which note.

Some trackers escape square brackets on save, so describe a sketch in words rather than drawing it with `[ ]`.

### 6. Report

Reply with one table, grouped by source note, listing each new issue as `ABC-123 title`. Then name any clusters you noticed (items that overlap, or might merge into a bigger piece of work) as input for triage. Don't act on them.

## Boundaries

- Never move an issue out of Triage, and never accept or decline one. That's the user's call in triage review.
- Never set priority, even when a note says "urgent"; quote the word in the body.
- When a note is about a different product or repo than the one you're in, file it with that product's label. When the product is unclear, ask.
