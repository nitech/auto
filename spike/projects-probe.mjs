#!/usr/bin/env node
/** What does Auto think your projects are? */
import { listProjects } from '../src/core/projects.mjs';

const projects = listProjects(['D:\\Sevenfold\\auto']);
console.log(`${projects.length} projects\n`);
for (const p of projects.slice(0, 20)) {
  const flag = p.open ? '●' : ' ';
  const chats = p.desktopChats ? `${p.desktopChats} desktop chats` : '';
  console.log(`${flag} ${p.name.padEnd(24)} ${chats.padEnd(18)} ${p.path}`);
}
