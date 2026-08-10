# Harness entry point

The harness CLI auto-loads a file named `CLAUDE.md` from the repo root as
project instructions — that filename is fixed by the harness, regardless of
which model/provider is behind the session. So this file stays as the entry
point, but Auto's actual agent instructions live in `AUTO.md` (imported
below) to keep the docs provider-agnostic. Edit `AUTO.md`, not this file.

@AUTO.md
