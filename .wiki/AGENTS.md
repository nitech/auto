# Auto wiki — agent schema

This is Auto's compiled knowledge. Agents write it; people read it from a
phone. Follow the global `llm-wiki` skill (OKF core). This file is the
producer-defined extra for *this* repo.

## Where it lives

Knowledge is `.wiki/`. The old `wiki/` + `raw/` layout (npm `llm-wiki` CLI)
is retired. Do not ingest into `raw/` and do not update `wiki/concepts/`.

## When to update

After any non-trivial change to architecture, contracts, APIs, failure modes,
or agent-critical behaviour, update the touched pages in the **same turn**.
Skip formatting, tests-only, and diffs that do not change how Auto behaves.

## How to write

- One concept per file under `concepts/`. `overview.md` is the way in.
- YAML frontmatter with `type` required. Cite code through `sources`, not by
  copying files into the bundle.
- Describe behaviour, not models. Say "the agent". Naming `cursor-agent` or a
  config key as setup documentation is fine.
- Cross-link with markdown paths: `[Sessions](concepts/sessions.md)`.
- After edits: bump `generated.at` on touched pages, refresh `index.md`,
  append a date-grouped line to `log.md` (newest date first).

## Do not

- Rewrite the whole bundle for a one-file change.
- Put long explanations only in a commit message when a wiki page should
  have them — the wiki is what the next session will read.
