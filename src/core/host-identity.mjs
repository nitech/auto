/**
 * Who this Auto host is: the OS hostname, plus an optional nick the operator
 * sets from Settings so a phone can tell one machine from another.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';

export class HostIdentity {
  /**
   * @param {string} stateDir directory for host.json
   */
  constructor(stateDir) {
    this.path = join(stateDir, 'host.json');
    this.hostname = osHostname();
    /** @type {string} empty means "show the OS hostname" */
    this.nick = '';
    this.#load();
  }

  /** What the rail and Settings should put on screen. */
  label() {
    return this.nick || this.hostname;
  }

  /** Shape sent on hello and after a nick change. */
  snapshot() {
    return {
      hostname: this.hostname,
      nick: this.nick || null,
      label: this.label(),
    };
  }

  /**
   * @param {string} nick trimmed; empty clears the override
   */
  setNick(nick) {
    this.nick = String(nick ?? '').trim();
    this.#persist();
    return this.snapshot();
  }

  #load() {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof raw?.nick === 'string') this.nick = raw.nick.trim();
    } catch {
      // A corrupt file is treated as "no nick"; the next save replaces it.
    }
  }

  #persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = {
      nick: this.nick || null,
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}
