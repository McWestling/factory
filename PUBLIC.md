---
name: Factory
pitch: Factory turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.
url: https://github.com/mcwestling/factory
---

Factory is how we build software at McWestling. An idea goes in as a scribbled note and comes out as a finished, checked change to a real product. Coding agents, which are AI programs that read and write code by themselves, do the building. A person makes every call that needs judgement.

This page is for anyone who has heard of coding agents and wonders what it looks like to run real work through them. You don't need to use any of the tools named here to follow along.

Here is what it covers:

- [Why we built it](#why-we-built-it)
- [How an idea becomes a finished change](#how-an-idea-becomes-a-finished-change), in six steps, following one example
- [How the work gets checked](#how-the-work-gets-checked)
- [What it's made of](#what-its-made-of)
- [Where it's going](#where-its-going)
- [Takeaways](#takeaways) and where to [learn more](#learn-more)

## Why we built it

Software work is a mix of two kinds. A small part is deciding: what to build, how it should behave, how the pieces fit together. The rest is wiring and plumbing: connecting those pieces, following the patterns already in place, getting the details right. Both matter. Only the first needs a person.

Coding agents are now good at the second kind, as long as someone tells them clearly what to do and checks what comes back. So we wanted to spend our thinking on the hard parts, the decisions and the architecture, and hand over the rest.

Factory is how we do that. Every idea goes through the same steps. At the steps that need judgement, Factory stops and asks a person. At the others, it keeps going.

<figure>
<img src="public-page/sorting.svg" width="392" alt="Sorting the work: a line of plain squares runs into a station and comes out as built blocks. One square marked with a question mark, a decision, has been lifted off the line to a person, who thinks it over under a lit orange lamp. A square with a tick, a decision already settled, is back on the line.">
<figcaption>Most of the work runs straight through to the agents and comes out built. The pieces that are really decisions are lifted off for a person to settle, then go back on the line.</figcaption>
</figure>

There were three more reasons:

- **One person can run it.** A large organisation spends most of its effort getting people to agree. McWestling is small, and Factory lets one person make the decisions and still ship steadily.
- **Time.** The work carries on while we're away from the desk, which gives us more control over where our time goes.
- **Curiosity.** We wanted to know how far this could go, and the way to find out was to build it and use it every day.

## How an idea becomes a finished change

An idea passes through six steps. At three of them, a person decides.

<figure>
<picture data-live>
<source media="(max-width: 40rem)" srcset="public-page/journey-tall.svg">
<img src="public-page/journey-wide.svg" width="824" alt="An idea's journey: a sticky note travels along a timeline through six stations, each marked with its icon on a round plaque, and ends as a finished change. An orange lamp is lit on the second, third and fifth stations, where a person decides.">
</picture>
<figcaption>An idea moves down the line and leaves each step in a new shape: a note, a map, a stack of small tasks, a built change, a checked change, a finished one. <b>1</b> Capture, <b>2</b> Triage, <b>3</b> Refine, <b>4</b> Implement, <b>5</b> Review, <b>6</b> Closeout. A lit lamp marks a step where a person decides.</figcaption>
</figure>

To make the steps concrete, we'll follow one idea through all six, in a made-up product.

Potluck is a small app for friends who take turns hosting dinners. A host invites guests, and each guest says whether they're coming and what they'll bring. Its tasks are kept in Linear, a task tracker, where each one gets a number like ABC-101.

One evening a host notices that two guests forgot the date. That's the idea we'll follow.

### <img src="public-page/icon-capture.svg" alt="" width="20" height="20"> 1. Capture

Ideas turn up at bad moments, so getting one down has to cost nothing. An idea might be a flaw in the software, a new feature, or a question to explore. It might arrive as a photo of a sticky note, a voice note, a chat message, an email, or a task typed straight into Linear.

<figure>
<img src="public-page/inputs.svg" width="480" alt="Where ideas come from: a loose heap of five things. A handwritten sticky note that says remind people before the dinner, a voice note, a task typed into the tracker that says RSVP count is wrong, a chat message that asks could guests bring a plus one, and an email.">
<figcaption><b>1</b> A sticky note with a feature idea. <b>2</b> A voice note. <b>3</b> A flaw someone noticed, typed straight into Linear. <b>4</b> A question in a chat message. <b>5</b> An email.</figcaption>
</figure>

Whatever the form, an agent reads it and files it. Our host's sticky note says "remind people before the dinner!!". Capture files it as ABC-101, *Send reminders to guests before dinner events*, in a pile of new ideas waiting to be sorted.

<figure>
<img src="public-page/step-capture.svg" width="352" alt="Capture: a handwritten sticky note that says remind people before the dinner, on a heap with a voice note, a task, a chat message and an email, is dropped into a station shaped like a hopper, and leaves as a typed note.">
<figcaption><b>1</b> Our sticky note, on the heap. <b>2</b> Capture reads it. <b>3</b> The same idea, written out and filed.</figcaption>
</figure>

### <img src="public-page/icon-triage.svg" alt="" width="20" height="20"> 2. Triage

The pile gets sorted with you. For each idea, the agent says what it thinks should happen, and you choose: build it now, plan it further, or drop it. ABC-101 sounds simple, but nobody has said how guests are reminded, or when. So you choose to plan it further.

An idea that needs planning gets a map: a project in Linear that holds one goal, the questions still open on the way to it and, later, the tasks to build. The idea comes from Matt Pocock's [wayfinder skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder), which Factory's planning is built on. The agent starts a map called *Dinner reminders* and moves ABC-101 into it. For now the map says where we want to end up, and not yet how to get there.

<figure>
<img src="public-page/step-triage.svg" width="352" alt="Triage: the typed note enters a station with a peaked top and leaves as a folded map named Dinner reminders. On the map, a dashed route with question marks along it runs from the idea to a flag at the destination. Speech, question and thought bubbles rise from the station one at a time, showing that a person decides here.">
<figcaption><b>1</b> The idea as it was captured. <b>2</b> You and the agent decide what happens to it. <b>3</b> A new map, <i>Dinner reminders</i>: the idea at one end, the goal at the other, the way between unknown.</figcaption>
</figure>

### <img src="public-page/icon-refine.svg" alt="" width="20" height="20"> 3. Refine

This is where most of the thinking happens. The agent turns the unknown part of the map into questions, and you settle them one at a time. This map needs one: ABC-103, *Decide how guests are reminded*. The agent recommends email, since Potluck already sends invitations that way. You answer: "Email only, at 9am the day before. The host can turn it off for a dinner."

The agent then slices the work into small tasks on the map, each clear enough to build without asking anything more. ABC-104 lets a host turn reminders on or off for a dinner. ABC-105 emails the guests, and waits for ABC-104 to be finished first.

<figure>
<img src="public-page/step-refine.svg" width="352" alt="Refine: the map named Dinner reminders, its route still marked with question marks, enters a station with a wide base and leaves as two smaller task cards, ABC-104 and ABC-105. Speech, question and thought bubbles rise from the station one at a time, showing that a person decides here.">
<figcaption><b>1</b> The map, with the way still unknown. <b>2</b> You settle its questions, one at a time. <b>3</b> Small tasks, ready to build.</figcaption>
</figure>

### <img src="public-page/icon-implement.svg" alt="" width="20" height="20"> 4. Implement

Each small task goes to an agent, which builds it, checks its own work and opens a pull request: a proposed change to the code, ready for someone to look at. Nobody has to watch.

<figure>
<img src="public-page/step-implement.svg" width="352" alt="Implement: the small task card ABC-105 enters a station with a sloped roof and leaves as a solid block marked PR, a pull request.">
<figcaption><b>1</b> A small, clear task. <b>2</b> An agent builds it. <b>3</b> A pull request (PR).</figcaption>
</figure>

### <img src="public-page/icon-review.svg" alt="" width="20" height="20"> 5. Review

A second agent, which took no part in the building, reads the pull request and works with the first agent until it has no complaints left. Only then are you asked to look. You read the change and either merge it, which makes it part of the product, or send it back.

<figure>
<img src="public-page/step-review.svg" width="352" alt="Review: the block marked PR enters a domed station and leaves with a tick on it. Speech, question and thought bubbles rise from the station one at a time, showing that a person decides here.">
<figcaption><b>1</b> A pull request. <b>2</b> A reviewer agent goes through it, then you do. <b>3</b> A change that has been checked and accepted.</figcaption>
</figure>

### <img src="public-page/icon-closeout.svg" alt="" width="20" height="20"> 6. Closeout

After the merge, an agent tidies up. It marks the task done, confirms that each thing the task asked for was delivered, and runs any steps that had to wait for the merge. It ends with a verdict, "Good to close" or "Not yet", and suggests what to pick up next.

<figure>
<img src="public-page/step-closeout.svg" width="352" alt="Closeout: the ticked block enters a square station and leaves as a round seal with a tick, the finished change.">
<figcaption><b>1</b> A merged change. <b>2</b> An agent confirms everything was delivered. <b>3</b> Finished.</figcaption>
</figure>

## How the work gets checked

Handing work to agents only makes sense if you can trust what comes back, and an agent saying "done" is not enough.

Each project declares its own checks: the tests and other commands that have to pass. A part of Factory called Verifier runs them at every point where a mistake could slip through:

- while the agent works, on the same computer;
- before the change can go up for review, where it is refused unless it carries proof that the checks passed;
- on the pull request itself;
- and again after the merge, where a failure is filed as a new task.

Then the reviewer agent reads the change. By the time a person is asked to look, the work has passed everything a machine can check. That leaves the person with the one question a machine can't answer: is this the right change?

## What it's made of

Factory is three parts of its own, joined to three tools made by other people.

<figure>
<picture>
<source media="(max-width: 40rem)" srcset="public-page/map-tall.svg">
<img src="public-page/map-wide.svg" width="824" alt="What Factory is made of: a task in Linear goes to Delegator, which starts coding agents in Orca. The agents follow Factory's skills. Verifier runs the checks, and the change goes up to GitHub as a pull request. A person under a lit orange lamp reviews and merges it, and the result goes back to Linear. Factory's own parts, Skills, Delegator and Verifier, are filled brown.">
</picture>
<figcaption>Filled parts are Factory's own. Outlined parts are tools it connects. The loop closes with you.</figcaption>
</figure>

Factory's own parts:

- **[Skills](https://github.com/mcwestling/factory#skills):** written instructions for a coding agent, one for each step above. They are the heart of Factory, and you can use them without the other two parts.
- **[Delegator](https://github.com/mcwestling/factory/tree/main/packages/delegator#readme):** starts the work. When a task in Linear is ready, Delegator opens a workspace on your own computer and puts an agent to work in it.
- **[Verifier](https://github.com/mcwestling/factory/tree/main/packages/verifier#readme)** <small>Coming soon</small>**:** runs each project's checks, as described above.

The tools it connects:

- **[Linear](https://linear.app):** a task tracker. Every idea and task lives here.
- **[Orca](https://onorca.dev):** an app that runs several coding agents side by side, each in its own copy of the code.
- **[GitHub](https://github.com):** where the code is kept, and where pull requests are reviewed and merged.

Factory also builds on [Matt Pocock's skills](https://github.com/mattpocock/skills) for research, design, prototyping and testing.

## Where it's going

Factory changes every week. Three things are ahead, from nearest to furthest:

- **Rolling out now:** when a problem gets past the checks, Factory files a task against itself to close the gap, so the same mistake can't get through twice.
- **Planned:** review starts by itself as soon as the checks pass, with nobody having to ask for it.
- **Still being weighed:** letting small, low-risk changes merge with very little human involvement. We haven't decided whether to do this.

## Takeaways

- People decide; agents do the wiring and plumbing.
- Every idea takes the same six steps, and a person is brought in at the three that need judgement.
- Nothing reaches a person until it has passed every check a machine can run.

## Learn more

- [Factory on GitHub](https://github.com/mcwestling/factory) has everything: the skills, Delegator and Verifier. It's built for McWestling, not as a product: there is no support, and anything may change. To stand up the same thing for yourself, fork the repo and follow its README.
- [Matt Pocock's skills](https://github.com/mattpocock/skills) are the ones Factory builds on.
- [About McWestling](https://mcwestling.com/about/) says who we are.
