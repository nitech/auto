#!/usr/bin/env node
/** What the rail shows, and which sessions live in the desktop. */
const res = await fetch('http://127.0.0.1:4331/api/sessions');
const body = await res.json();
for (const s of body.sessions || body) {
  const kind = (s.kind || 'agent').padEnd(8);
  const status = String(s.status).padEnd(7);
  const thread = s.desktopThreadId ? ` thread ${s.desktopThreadId.slice(0, 8)}` : '';
  console.log(`${kind} ${status} ${s.title}${thread}`);
}
