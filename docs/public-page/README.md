---
name: Factory
pitch: Factory turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.
url: https://github.com/mcwestling/factory
---

Factory is how we build software at McWestling. An idea goes in as a scribbled note and comes out as a finished, checked change to a real product. Coding agents, which are AI programs that read and write code by themselves, do the building. A human makes every call that needs judgment.

This page is for anyone who has heard of coding agents and wonders what it looks like to run real work through them. You don't need to use any of the tools named here to follow along.

Here is what it covers:

- [Why we built it](#why-we-built-it)
- [How an idea becomes a finished change](#how-an-idea-becomes-a-finished-change), in six steps, following one example
- [How the work gets checked](#how-the-work-gets-checked)
- [What it's made of](#what-its-made-of)
- [Where it's going](#where-its-going)
- [Takeaways](#takeaways) and where to [learn more](#learn-more)

## Why we built it

Building software takes two kinds of work: deciding, and what we call wiring and plumbing. Deciding is choosing what to build, how it should behave and how the pieces fit together. Wiring and plumbing is everything after that: connecting the pieces, following the patterns already in place and getting the details right. Deciding is the smaller part, and the only one that needs a human.

Coding agents are now good at the wiring and plumbing, as long as someone tells them clearly what to do and checks what comes back. So we wanted to spend our own thinking on the deciding, and hand over the rest.

Factory is how we do that. Every idea starts down the same steps. At the steps that need judgment, Factory stops and asks a human. At the others, it keeps going.

<figure>
<img src="images/sorting.svg" width="392" alt="Sorting the work: a line of plain squares runs into a station and comes out as built blocks. One square marked with a question mark, a decision, is still on the line; another has been lifted off to a human, who thinks it over, hand on chin, under a lit orange lamp while speech and thought bubbles rise. A square with a check mark, a decision already settled, is back on the line.">
<figcaption>

Most of the work runs straight through to the agents and comes out built. The pieces that are really decisions are lifted off for a human to settle, then go back on the line.

</figcaption>
</figure>

There were three more reasons:

- **One person can run it.** A large organization spends most of its effort getting people to agree. McWestling is small, and Factory lets one person make the decisions and still ship steadily.
- **Time.** The work carries on while we're away from the desk, which gives us more control over where our time goes.
- **Curiosity.** We wanted to know how far this could go, and the way to find out was to build it and use it every day.

## How an idea becomes a finished change

An idea passes through six steps. At three of them, a human decides.

<figure>
<picture data-live>
<source media="(max-width: 40rem)" srcset="images/journey-tall.svg">
<img src="images/journey-wide.svg" width="824" alt="An idea's journey: a sticky note travels along a timeline through six stations, each marked with its icon on a round plaque, and ends as a finished change. An orange lamp is lit on the second, third and fifth stations, where a human decides.">
</picture>
<figcaption>

An idea moves down the line and leaves each step in a new shape. A lit lamp marks a step where a human decides.

1. Capture: a note.
2. Triage: a map of what's still to decide.
3. Refine: a stack of small tasks.
4. Implement: a built change.
5. Review: a checked change.
6. Closeout: a finished one.

</figcaption>
</figure>

To make the steps concrete, we'll follow one idea through all six, in a made-up product.

<figure>
<img src="images/potluck.svg" width="392" alt="Potluck, the made-up product used as the example: a pot with a lid as its logo, the name Potluck, and the line dinners with friends, hosted in turns.">
</figure>

Potluck is a small app for friends who take turns hosting dinners. A host invites guests, and each guest says whether they're coming and what they'll bring.

One evening, someone on the Potluck team hosts a dinner, notices that two guests forgot the date, and wishes the app had reminded them. They scribble a sticky note. Reminders are the feature we'll follow in this example.

### <img src="images/icon-capture.svg" alt="" width="26" height="20">Capture

Ideas turn up at bad moments, so getting one down has to cost nothing. An idea might be a flaw in the software, a new feature, or a question to explore. It might arrive as a photo of a sticky note, a voice note, a chat message, an email, or a task typed straight into the task management tool.

<figure>
<img src="images/inputs.svg" width="480" alt="Where ideas come from: a loose heap of five things. A handwritten sticky note that says remind people before the dinner, a voice note, a task typed into the tracker that says RSVP count is wrong, a chat message that asks could guests bring a plus one, and an email.">
<figcaption>

1. A sticky note with a feature idea.
2. A voice note.
3. A flaw someone noticed, typed straight into the task management tool.
4. A question in a chat message.
5. An email.

</figcaption>
</figure>

Whatever the form, it ends up in the same place. The Potluck team tracks its work in [Linear](https://linear.app), a task management tool where each task gets a number like POT-101. An agent reads the idea and files it there, unless it was typed there to begin with. That sticky note says "remind people before the dinner!!". Capture files it as POT-101, *Send reminders to guests before dinner events*, in a pile of new ideas waiting to be sorted.

<figure>
<img src="images/step-capture.svg" width="352" alt="Capture: a handwritten sticky note that says remind people before the dinner, on a heap with a voice note, a task, a chat message and an email, is dropped into a station shaped like a hopper, and leaves as a typed note.">
<figcaption>

1. Our sticky note, on the heap.
2. Capture reads it.
3. The same idea, written out and filed.

</figcaption>
</figure>

### <img src="images/icon-triage.svg" alt="" width="26" height="20">Triage

Next, an agent goes through the pile with a human. From here on, picture that human as you. For each idea, the agent says what it thinks should happen, and you choose: build it now, plan it further, or drop it. POT-101 sounds simple, but nobody has said how guests are reminded, or when. So you choose to plan it further.

An idea that needs planning gets a map: a project in [Linear](https://linear.app) that holds one goal, the questions still open on the way to it and, later, the tasks to build. We borrowed maps from Matt Pocock's [wayfinder skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder). A skill is a set of written instructions for an agent, and Factory's planning is built on this one. The agent starts a map called *Dinner reminders* and moves POT-101 into it. For now the map says where you want to end up, but not yet how to get there.

<figure>
<img src="images/step-triage.svg" width="352" alt="Triage: the typed note enters a station with a peaked top and leaves as a folded map named Dinner reminders. On the map, a dashed route with question marks along it runs from the idea to a flag at the destination. Speech, question and thought bubbles rise from the station one at a time, showing that a human decides here.">
<figcaption>

1. The idea as it was captured.
2. You and the agent decide what happens to it.
3. A new map, <i>Dinner reminders</i>: the idea at one end, the goal at the other, the way between unknown.

</figcaption>
</figure>

### <img src="images/icon-refine.svg" alt="" width="26" height="20">Refine

This is where most of the thinking happens. The agent turns the unknown part of the map into questions, and you settle them one at a time. This map has only one question: POT-102, *Decide how guests are reminded*. The agent recommends email, since Potluck already sends invitations that way. You answer: "Email only, at 9am the day before. The host can turn it off for a dinner."

Refine is built on Matt Pocock's [grilling skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling). The agent interviews you about each question on the map. Every time it asks something, it offers the answer it would pick, so often you only have to say yes. It keeps asking until nothing is left assumed. Factory adds the record-keeping: each question on the map is a task in [Linear](https://linear.app), and each answer is written down where the agents doing the building will find it.

The agent then slices the work into small tasks on the map, each clear enough to build without asking anything more. POT-103 is to let a host turn reminders off for a dinner. POT-104 is to email the guests at 9am the day before; it can't start until POT-103 is done.

<figure>
<img src="images/step-refine.svg" width="352" alt="Refine: the map named Dinner reminders, its route still marked with question marks, enters a station with a wide base and leaves as two smaller task cards, POT-103 and POT-104. Speech, question and thought bubbles rise from the station one at a time, showing that a human decides here.">
<figcaption>

1. The map, with the way still unknown.
2. You settle its questions, one at a time.
3. Small tasks, ready to build.

</figcaption>
</figure>

### <img src="images/icon-implement.svg" alt="" width="26" height="20">Implement

Each small task goes to an agent, which builds it, checks its own work and opens a pull request on [GitHub](https://github.com): a proposed change to the code, ready for someone to look at. Nobody has to watch. In our example, an agent takes POT-103; once that is finished, another takes POT-104.

<figure>
<img src="images/step-implement.svg" width="352" alt="Implement: the small task card POT-104 enters a station with a sloped roof and leaves as a solid block marked PR, a pull request.">
<figcaption>

1. A small, clear task.
2. An agent builds it.
3. A pull request (PR).

</figcaption>
</figure>

### <img src="images/icon-review.svg" alt="" width="26" height="20">Review

A second agent, the reviewer, took no part in the building. It reads the pull request and sends it back to the first agent until the reviewer has no complaints left. Only then are you asked to look. You read the change and either merge it, which makes it part of the product, or send it back. For POT-104, you read the change, check that the reminder email looks right, and merge it.

<figure>
<img src="images/step-review.svg" width="352" alt="Review: the block marked PR enters a domed station and leaves with a check mark on it. Speech, question and thought bubbles rise from the station one at a time, showing that a human decides here.">
<figcaption>

1. A pull request.
2. A reviewer agent goes through it, then you do.
3. A change that has been checked and merged.

</figcaption>
</figure>

### <img src="images/icon-closeout.svg" alt="" width="26" height="20">Closeout

After the merge, an agent tidies up. It marks the task done, confirms that each thing the task asked for was delivered, and runs any steps that had to wait for the merge. It ends with a verdict, "Good to close" or "Not yet", and suggests what to pick up next. With POT-103 and POT-104 both merged, guests get their reminder, and the idea that began as a sticky note, POT-101, is finished.

<figure>
<img src="images/step-closeout.svg" width="352" alt="Closeout: the checked block enters a square station and leaves as a round seal with a check mark, the finished change.">
<figcaption>

1. A merged change.
2. An agent confirms everything was delivered.
3. Finished.

</figcaption>
</figure>

## How the work gets checked

Handing work to agents only makes sense if you can trust what comes back, and an agent saying "done" is not enough.

Each product declares its own checks: the tests and other commands that have to pass. A part of Factory called Verifier runs them at every point where a mistake could slip through:

- while the agent works, on the computer it is working on;
- before a pull request can be opened: the change is refused unless it carries proof that the checks passed;
- on the pull request itself;
- and again after the merge, when a failure is filed as a new task.

Once the checks pass on the pull request, the reviewer agent reads the change. By the time a human is asked to look, the work has passed everything a machine can check. That leaves the human with the one question a machine can't answer: is this the right change?

## What it's made of

Factory is three parts of its own, joined to three tools made by other people.

<figure>
<picture>
<source media="(max-width: 40rem)" srcset="images/map-tall.svg">
<img src="images/map-wide.svg" width="824" alt="What Factory is made of: a task in Linear goes to Delegator, which starts coding agents in Orca. The agents follow Factory's skills. Verifier runs the checks, and the change goes up to GitHub as a pull request. A human under a lit orange lamp reviews and merges it, and the result goes back to Linear. Factory's own parts, Skills, Delegator and Verifier, are filled brown.">
</picture>
<figcaption>

Filled parts are Factory's own. Outlined parts are tools it connects. The loop closes with you.

</figcaption>
</figure>

Factory's own parts:

- **[Skills](https://github.com/mcwestling/factory#skills):** written instructions for a coding agent, one for each step above. They are the heart of Factory, and you can use them without the other two parts.
- **[Delegator](https://github.com/mcwestling/factory/tree/main/packages/delegator#readme):** starts the work. When a task in [Linear](https://linear.app) is ready, Delegator opens a workspace in [Orca](https://onorca.dev) on your own computer and puts an agent to work in it.
- **[Verifier](https://github.com/mcwestling/factory/tree/main/packages/verifier#readme):** runs each product's checks, as described above.

The tools it connects:

- **[Linear](https://linear.app):** a task management tool. Every idea and task lives here.
- **[Orca](https://onorca.dev):** an app that runs several coding agents side by side, each in its own copy of the code.
- **[GitHub](https://github.com):** where the code is kept, and where pull requests are reviewed and merged.

## Where it's going

Factory changes every week. Three things are ahead, from nearest to furthest:

- **Rolling out now:** when a problem gets past the checks, Factory files a task against itself to close the gap, so the same mistake can't get through twice.
- **Planned:** review starts by itself as soon as the checks pass, with nobody having to ask for it.
- **Still being weighed:** letting small, low-risk changes merge with very little human involvement. We haven't decided whether to do this.

## Takeaways

- Humans make the decisions; agents do the wiring and plumbing.
- Every idea starts down the same six steps, and a human is brought in at the three that need judgment.
- No change reaches a human for review until it has passed every check a machine can run.

## Learn more

- [Factory on GitHub](https://github.com/mcwestling/factory) has everything: the skills, Delegator and Verifier. We built it for ourselves, not as a product: there is no support, and anything may change. To stand up the same thing for yourself, fork the repo and follow its README.
- [Matt Pocock's skills](https://github.com/mattpocock/skills) are the ones Factory builds on.
- [About McWestling](https://mcwestling.com/about/) says who we are.
