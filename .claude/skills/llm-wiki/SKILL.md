---
name: llm-wiki
description: >-
  Keep Auto's `.wiki/` knowledge bundle current. Use after any non-trivial
  code, architecture, API, or behaviour change in this repo, and when the
  user mentions wiki, LLM Wiki, OKF, document the project, ingest, query, or
  lint. Dev-sync in the same turn without being asked. The old wiki/ + raw/
  layout is retired.
---

# Auto wiki (dev-sync)

This repo's compiled knowledge is `.wiki/`. Schema: `.wiki/AGENTS.md`. Full
OKF rules: the global `llm-wiki` skill.

## After a non-trivial change

In the same turn, without being asked:

1. Read `.wiki/index.md` and the pages that cover what you changed.
2. Update those concept files (and `overview.md` if the map of Auto changed).
3. Bump `generated.at`, refresh `.wiki/index.md`, append `.wiki/log.md`.
4. Skip trivial/no-behaviour diffs.

## If `.wiki/` is missing

Migrate `wiki/` (and anything under `raw/`) into `.wiki/` with OKF
frontmatter. Leave a one-line pointer at `wiki/index.md`. Do not copy sources
into a `raw/` folder.

## Query

Read `.wiki/index.md` first, then the linked pages. Cite them. File a reusable
answer as a new concept.
