# Continuing Cursor desktop chats

Auto can pick up a chat you started in the Cursor desktop app and carry it on
from the phone, with the agent holding the whole earlier conversation. This
note records how, because it leans on Cursor's own storage rather than on any
published interface, and that can change under us.

## What does not work

- **`session/list` over ACP** returns only sessions the CLI itself has —
  the ones Auto and `agent` created. Desktop chats are not in it.
- **`agent --resume <id>`** with a desktop chat id does *not* load that chat.
  It quietly creates an empty chat under the id you passed, which looks like
  success until the agent tells you the conversation is new.

## Why copying works

The desktop and the CLI turn out to run the same conversation machinery. Both
store a conversation as a set of content-addressed blobs plus a manifest that
names them in order, alongside a per-conversation encryption key.

| | Desktop app | ACP session |
| --- | --- | --- |
| Where | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | `~/.cursor/acp-sessions/<id>/store.db` |
| Chat record | `cursorDiskKV` key `composerData:<chatId>` | `meta` key `0`, hex-encoded JSON |
| Manifest | `composerData.conversationState`, `~` then base64 | `latestRootBlobId`, pointing at a blob |
| Blobs | `cursorDiskKV` key `agentKv:blob:<sha256>` | `blobs(id, data)` |
| Key | `blobEncryptionKey`, base64 | `blobEncryptionKey`, hex |

The manifest is protobuf: repeated field 1, each a 32-byte sha256 naming a
blob. Blob ids are the sha256 of the bytes, and the bytes themselves are
mostly plain JSON messages (`{"role":"user","content":…}`), which is also what
makes the conversation readable for display.

So continuing a chat is a copy:

1. Read `composerData:<chatId>` for the manifest and the key.
2. Fetch every blob the manifest names, following any blobs those name.
3. Write a new `~/.cursor/acp-sessions/<uuid>/` with `meta.json`, the blobs,
   and a `meta` row whose `latestRootBlobId` is the manifest stored as a blob.
4. Load it over ACP like any other session.

`src/core/desktop-chats.mjs` does this. Auto only ever reads the desktop's
database, and writes nothing but its own new session directory.

## Consequences worth knowing

- **It is a copy, not a shared session.** Continue in Auto and in the IDE and
  the two diverge from the moment you copy. Nothing is written back.
- **A chat needs its blobs on this machine.** Every chat checked had all of
  them, but the importer counts what is missing and says so.
- **Values come back in two shapes.** `cursorDiskKV` rows are sometimes raw
  bytes and sometimes hex text; read `typeof(value)` rather than assuming.
- **The database is large and busy.** It is opened read-only, for one query
  at a time, while Cursor is running.

## Listing chats

`composerHeaders` holds one row per chat with `workspaceId`, timestamps and a
JSON `value` carrying the name and subtitle. A folder's `workspaceId` is the
directory name under `%APPDATA%\Cursor\User\workspaceStorage` whose
`workspace.json` points at that folder, which is how Auto shows a project's
chats. Rows with `isSubagent` or `isArchived` set are left out.

## If it breaks

Symptoms would be an empty chat list, or an imported session whose agent
claims the conversation is new. Check, in order: the shape of
`composerData.conversationState`, whether `agentKv:blob:` is still the blob
prefix, and whether the ACP store still uses `blobs`/`meta` with a hex-encoded
`meta` row. `npm test` checks the listing path; the copying path is exercised
by continuing a chat.
