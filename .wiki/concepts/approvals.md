---
type: Concept
title: Approvals, questions, and plans
description: Permission broker, agent question cards, Created Plan, and why Keep All is not a question.
tags: [permissions, questions, plans]
status: stable
sources:
  - id: permissions
    resource: /src/core/permissions.mjs
    title: Permission broker
  - id: questions
    resource: /src/core/questions.mjs
    title: Question cards
  - id: tools
    resource: /src/web/desktop-tool-ui.js
    title: How desktop tools are drawn
generated: { by: agent, at: 2026-08-20T21:25:00Z }
---

# Approvals, questions, and plans

Four different waits look similar on a phone and must not be mixed up.

## Permission policy

ACP asks Auto to authorise a tool call and blocks until someone answers.
The first answer from the web or Telegram wins. The agent waits at least
two minutes.

| Policy | Meaning |
| --- | --- |
| `auto` | Approve everything (default, `AUTO_POLICY`) |
| `ask-on-write` | Approve reads/search/fetch/think; ask for the rest |
| `ask` | Ask every time |

A session whose policy you change keeps that choice.

## Cursor's own approvals

While a desktop turn runs, Auto watches the window for controls whose words
mean it is waiting for a person, parks them in the same broker, and presses
whichever option comes back — withdrawing the question if it is answered in
the IDE first. The vocabulary lives in `cursor-dom.mjs` (never class names).
With Cursor set to run everything automatically it rarely asks — treat the
first real sighting as a chance to learn the words Cursor actually uses.

Skip and Continue **inside a chat message bubble** are not approvals: they
belong to Cursor's `ask_question` card. Offering Skip from that card as
"Permission needed" was the first wild miss — the card is drawn before its
options are written, and those two words are otherwise indistinguishable
from an approval.

## The file-review bar is not a question

"Keep All" and "Undo All" sit there for as long as a chat has unreviewed
edits. Offering them as approvals meant offering to throw work away by
accident. They are excluded from the approval vocabulary and belong to a
deliberate action instead.

## Question cards

`ask_question` is not an approval: it holds real options, often several
questions. The phone letters them (`A`, or `1A` when there are several) so
a tap or a typed `A` / `1B` presses that option in Cursor and Continue.
Cursor draws those options on a questionnaire toolbar above the chat box,
not inside the tool bubble. The letter and the label are separate nodes
(often glued as "ARed"); Auto matches the stored label, including that
prefix, and falls back to the Nth row. Continue is disabled until a row is
chosen, so it is located anyway and pressed after the option. `Skip` is
still there, on that toolbar, not as a permission. Anything that is not a
lettered pick is a message, not an answer — a thought that happened to
start with a letter must not vanish into the question. Answering in the
IDE first still works; Auto notices and marks it answered.

## Created Plan

`create_plan` is a card: title, overview, View Plan for the markdown, and
Build with a model picker. Build presses Cursor's own button on that card,
after choosing the model there if one was named. Telegram gets the same two
actions.

On the web, View Plan opens the markdown full-window (like Settings): title
in the header, × or Escape to close. Wide fences and tables scroll inside the
viewer. Repo-path links in the plan (`[file](src/…)`) render as the file name
in code, not raw brackets.

## Related

- [Cursor window](cursor-window.md)
- [Tool lanes](tool-lanes.md)
- [Telegram](telegram.md)
- [Web](web.md)
