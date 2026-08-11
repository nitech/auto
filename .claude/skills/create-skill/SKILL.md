---
name: create-skill
description: Use whenever Auto (main agent or worker) wants to create a new skill for itself, update an existing one, or when the user asks Auto to "make a skill", "learn how to do X", or remembers a procedure it should reuse later. Covers skill file format, naming, validation, and the commit/push workflow.
---

# Create a skill for Auto

Auto's own skills live in this repo at `.claude/skills/<skill-name>/SKILL.md`.
Anything written there is loaded automatically in future sessions (main agent
and workers), so a skill written once is reusable forever.

## File layout

```
.claude/skills/<skill-name>/SKILL.md      required
.claude/skills/<skill-name>/references/*  optional bulky material (scripts, templates, examples)
```

Keep `SKILL.md` under ~200 lines. Move long templates, checklists, or example
output into `references/` and point at them from `SKILL.md`.

## SKILL.md format

```markdown
---
name: my-skill
description: Use when <trigger situations, with the words a user would actually type>. One or two sentences, third person, max ~500 chars.
---

# Title

Imperative instructions to the agent: steps, commands, pitfalls.
```

Rules:

- `name` must equal the directory name: lowercase kebab-case (`a-z0-9-`),
  max 64 chars.
- `description` is what the harness matches against user messages — pack it
  with trigger phrases ("restart", "service down", "switch repo"), not just a
  summary.
- Write instructions imperatively ("Run X", "Never do Y") — the reader is a
  future agent session, not a human.
- Follow the repo's agent-independence rule: say "the agent", never name a
  model/provider. Naming the harness CLI (`claude`) or config is fine.
- Skills are provider-agnostic: they must work whether the session's model is
  Claude, Kimi, or anything else.

## Workflow (mandatory — same as any repo change)

1. Write the files.
2. `npm test` — it validates every skill's frontmatter (name matches
   directory, description present). Fix what it flags.
3. Commit with a short message **and push** (`git push`).
4. No service restart is needed: an agent process loads skills when its
   session starts, so new sessions pick them up immediately and existing
   ones do on their next start.

## Good candidates for new skills

Create a skill when a procedure is: repeated (done twice, likely done again),
fiddly (easy to get wrong from memory), or requested by the user ("remember
how to …"). Don't create skills for one-off tasks or things already covered
by `AGENTS.md` — update `AGENTS.md` instead if it's a standing rule.
