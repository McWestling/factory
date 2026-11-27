---
name: Factory
pitch: The Factory turns ideas into finished software changes, with coding agents we can work with wherever we are.
url: https://github.com/mcwestling/factory
created: 2026-11-26
updated: 2026-11-27
---

At McWestling we build software with coding agents, programs that can read a project’s code, change it, and run it. The Factory is how we work with them.

## Why we built it

We wanted to be able to choose a problem, go make dinner, and come back to a change we could try. That’s why we built the Factory.

Sometimes two projects need our attention. We can choose what’s worth doing on one, talk through a tradeoff with an agent, and turn to the other while the agent builds. Trying what it made gives us another chance to think. Does this solve the problem? Now that we’ve used it, would we ask for something different?

We want to be able to give that input wherever we are. A question that seemed tricky at a desk might have an obvious answer halfway through a subway ride. We can send the answer then, or share an idea between sets at the gym, and let the agent carry on. That feels like a healthier way to work, and it’s one we want to build our lives around.

## How an idea becomes a finished change

Imagine we run Potluck, an app for friends who take turns hosting dinner.

<figure>
<img src="images/potluck.svg" width="392" alt="Potluck, the made-up product used as the example: a pot with a lid as its logo, the name Potluck, and the line dinners with friends, hosted in turns.">
</figure>

Guests use it to say whether they’re coming and what they’ll bring. Tonight two of them forgot the date. While it’s still on our minds, we scribble “remind people before the dinner!!” on a sticky note.

<figure>
<img src="images/sticky.svg" width="392" alt="The sticky note, in handwriting: remind people before the dinner, with two exclamation marks, underlined.">
</figure>

Here’s how that note makes its way into the app. You can also skip ahead to [the checks](#how-the-work-gets-checked), [the tools](#what-its-made-of), or [what we’re working on next](#where-its-going).

<figure>
<picture data-live>
<source media="(max-width: 40rem)" srcset="images/journey-tall.svg">
<img src="images/journey-wide.svg" width="824" alt="An idea's journey: a sticky note travels along a timeline through six stations, each marked with its icon on a round plaque, and ends as a smiling face, a happy user. An orange lamp is lit on the second, third and fifth stations, where a human decides.">
</picture>
<figcaption>

The lamps mark the three times we weigh in.

1. Capture: a note.
2. Triage: a map of what’s still to decide.
3. Refine: a stack of small tasks.
4. Implement: a built change.
5. Review: a checked change.
6. Closeout: a happy user.

</figcaption>
</figure>

### <img src="images/icon-capture.svg" alt="" width="26" height="20">Capture

A photo of the note will do. We could also leave a voice note, send a message or email, or type the idea straight into our task tracker. We’d like to get back to dinner.

<figure>
<img src="images/inputs.svg" width="480" alt="Where ideas come from: a loose heap of five things. A handwritten sticky note that says remind people before the dinner, a voice note, a task typed into the tracker that says RSVP count is wrong, a chat message that asks could guests bring a plus one, and an email.">
<figcaption>

Five ways an idea can reach us.

1. Our sticky note.
2. A voice note.
3. A flaw someone spotted, typed straight into the task tracker.
4. A question in a message.
5. An email.

</figcaption>
</figure>

An agent files the idea in [Linear](https://linear.app), where we keep track of the work. The idea is assigned a number to refer to it by in Linear, POT-101, and a title, *Send reminders to guests before dinner events*. An idea typed straight into Linear is already filed, so it skips this step.

<figure>
<img src="images/step-capture.svg" width="352" alt="Capture: a handwritten sticky note that says remind people before the dinner, on a heap with a voice note, a task, a chat message and an email, is dropped into a station shaped like a hopper, and leaves as a typed note.">
<figcaption>

The sticky note becomes POT-101.

1. Our sticky note, on the heap.
2. An agent reads it.
3. The same idea, typed up and filed as POT-101.

</figcaption>
</figure>

### <img src="images/icon-triage.svg" alt="" width="26" height="20">Triage

When we go through the pile, an agent recommends which ideas to build now, which need a little planning, and which to drop. We make the call. We’d like to build reminders. Reading our note again, though, we couldn’t tell you what time a guest should expect one.

The agent opens a Linear project called *Dinner reminders* and puts POT-101 in it. We call that project a map. It keeps the goal, the open questions, and eventually the build tasks together. We borrowed the idea from Matt Pocock’s [wayfinder skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder).

<figure>
<img src="images/step-triage.svg" width="352" alt="Triage: the typed note enters a station with a peaked top and leaves as a folded map named Dinner reminders. On the map, a dashed route with question marks along it runs from the idea to a flag at the destination. Speech, question and thought bubbles rise from the station one at a time, showing that a human decides here.">
<figcaption>

The reminder gets its own map.

1. POT-101, as it was captured.
2. We decide, with the agent, what happens to it.
3. A new map, <i>Dinner reminders</i>: the idea at one end, the goal at the other, the way between unknown.

</figcaption>
</figure>

### <img src="images/icon-refine.svg" alt="" width="26" height="20">Refine

Those two exclamation marks tell us how much we want a reminder. They say remarkably little about how to send one. The agent suggests email because Potluck already sends invitations that way. We settle on 9 a.m. the day before dinner. One more thing occurs to us. The host should be able to turn reminders off for a particular dinner.

This conversation follows Matt Pocock’s [grilling skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling). The agent asks one question at a time and offers the answer it would pick. It writes our answer on the map under POT-102, *Decide how guests are reminded*, so whoever builds the feature can find it.

Now the agent can make two tasks. POT-103 gives the host the switch. POT-104 sends the email and waits until the switch is in place.

<figure>
<img src="images/step-refine.svg" width="352" alt="Refine: the map named Dinner reminders, its route still marked with question marks, enters a station with a wide base and leaves as two smaller task cards, POT-103 and POT-104. Speech, question and thought bubbles rise from the station one at a time, showing that a human decides here.">
<figcaption>

One decision gives us two build tasks.

1. The map, with the way still unknown.
2. We settle its open question with the agent.
3. Two small tasks, ready to build.

</figcaption>
</figure>

### <img src="images/icon-implement.svg" alt="" width="26" height="20">Implement

An agent picks up the host’s switch, builds it, runs the checks, and opens a pull request on [GitHub](https://github.com). That’s the proposed code change where the review happens. Once the switch is in, another agent can pick up the email. We can spend that time on our other project.

<figure>
<img src="images/step-implement.svg" width="352" alt="Implement: the small task card POT-104 enters a station with a sloped roof and leaves as a solid block marked PR, a pull request.">
<figcaption>

The email change is ready for review.

1. POT-104, a small, clear task.
2. An agent builds it.
3. A pull request (PR).

</figcaption>
</figure>

### <img src="images/icon-review.svg" alt="" width="26" height="20">Review

A second agent reads the change with fresh eyes. If it spots a problem, the first agent gets another turn. Once the reviewer is satisfied, we get a look.

For the email task, we can finally read the reminder as someone who’s just been invited to dinner. Would we know which dinner it meant? If it reads strangely, we can send it back. When we’re happy with it, we merge the change into the project.

<figure>
<img src="images/step-review.svg" width="352" alt="Review: the block marked PR enters a domed station and leaves with a check mark on it. Speech, question and thought bubbles rise from the station one at a time, showing that a human decides here.">
<figcaption>

A second agent reviews the change before we do.

1. A pull request.
2. A reviewer agent goes through it, then we do.
3. A change that has been checked and merged.

</figcaption>
</figure>

### <img src="images/icon-closeout.svg" alt="" width="26" height="20">Closeout

As soon as a change is merged, an agent automatically starts cleaning up. It checks what we actually delivered, runs anything that had to wait for the merge, and gives us a verdict of “Good to close” or “Not yet.” It also suggests what to pick up next. Once both changes are in and accounted for, we can close the original sticky-note idea. Next time dinner rolls around, the guests get an email.

<figure>
<img src="images/step-closeout.svg" width="352" alt="Closeout: the checked block enters a square station and leaves as a round smiling face, a happy user.">
<figcaption>

Both changes are in. We can close the original idea.

1. A merged change.
2. An agent confirms everything was delivered.
3. A happy user.

</figcaption>
</figure>

## How the work gets checked

What do we know by the time we open that reminder email? Each product has a set of tests and other checks we expect a change to pass. Verifier runs them while the agent works. Before the agent can open a pull request, it has to show that they passed.

The checks run again on the pull request. Once they pass, the reviewer agent reads the change. After we merge, Verifier runs the checks once more and files a task if something breaks. That leaves us free to spend our review time on things like what the host will actually see when they open Potluck.

## What it's made of

We built three pieces to connect tools we already use.

<figure>
<picture>
<source media="(max-width: 40rem)" srcset="images/map-tall.svg">
<img src="images/map-wide.svg" width="824" alt="What the Factory is made of: a task in Linear goes to Delegator, which starts coding agents in Orca. The agents follow the Factory's skills. Verifier runs the checks, and the change goes up to GitHub as a pull request. A human under a lit orange lamp reviews and merges it, and the result goes back to Linear. The Factory's own parts, Skills, Delegator and Verifier, are filled brown.">
</picture>
<figcaption>Filled shapes belong to the Factory. Outlines are the tools we connect.</figcaption>
</figure>

**What we built**

- [Skills](https://github.com/mcwestling/factory#skills) give an agent written instructions for each step. You can use them on their own.
- [Delegator](https://github.com/mcwestling/factory/tree/main/packages/delegator#readme) starts an agent in its own Orca workspace on your computer when a Linear task is ready.
- [Verifier](https://github.com/mcwestling/factory/tree/main/packages/verifier#readme) runs the product’s checks.

**What we use**

- [Linear](https://linear.app) holds the ideas, decisions, and tasks.
- [Orca](https://onorca.dev) lets agents work side by side in separate copies of the code.
- [GitHub](https://github.com) holds the code and the pull requests where we review and merge changes.

## Where it's going

Right now we’re teaching the Factory to file a task against itself when a problem gets past the checks. We’d like to catch it the next time. After that, we want a passing check to start the review automatically. That’s one less thing someone has to remember to ask for.

We’re still deciding whether small, low-risk changes should be able to merge on their own. We built the Factory so we could choose where to spend our attention. Which changes do we actually want to see before they ship? That one’s still open.

## Learn more

You can [look around the Factory on GitHub](https://github.com/mcwestling/factory) or fork it and follow the README to try it yourself. We built it for our own use, so expect things to change. We don’t offer support.

You can also explore [Matt Pocock’s skills](https://github.com/mattpocock/skills) or [read about McWestling](https://mcwestling.com/about/).
