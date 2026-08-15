---
type: Concept
title: Skills and workflow
description: How agents working in this repo are instructed, tested, and how this wiki stays current.
tags: [skills, workflow, wiki]
status: stable
sources:
  - id: agents
    resource: /AGENTS.md
    title: Agent instructions
  - id: wiki-agents
    resource: /.wiki/AGENTS.md
    title: Wiki schema
  - id: test
    resource: /scripts/test.mjs
    title: Smoke tests
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# Skills and workflow

`CLAUDE.md` is a stub. The harness auto-loads that filename; the content
lives in `AGENTS.md`. Skills for Auto itself live in
`.claude/skills/<name>/SKILL.md` and load in every session in this repo.

Built-in skills: `auto-doctor`, `auto-restart`, `switch-repo`,
`create-skill`, `llm-wiki`. The global `llm-wiki` skill (user-level) is
what other repos use; this repo also has a project copy so Auto's own
sessions see it.

## Changes to this repo

1. `npm test` — syntax, core behaviour, skill frontmatter, and (if the host
   is up) health and the session API.
2. On pass: commit, **push**, then restart the host if `src/` changed.
3. On fail: revert, say which check failed, fix, start again.

Uncommitted fixes vanish for anyone restarting later. An unpushed commit
exists only on this machine.

**Testing a send goes to a scratch chat, not the session doing the work.**
A message delivered into that session becomes a prompt and costs another
turn.

Skills, docs, and `.wiki/` need no restart. Anything under `src/` does —
`POST /api/restart`, not a kill, if you are running inside Auto.

## This wiki

`.wiki/` is the compiled knowledge. After a non-trivial behaviour change,
update the touched pages in the same turn. See `.wiki/AGENTS.md`. The old
`wiki/` + `raw/` + npm `llm-wiki` ingest path is retired.

## Related

- [Host](host.md)
- [Overview](../overview.md)
