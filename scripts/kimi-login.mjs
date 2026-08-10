#!/usr/bin/env node
/**
 * Log in to Kimi Code membership (device flow) for Auto subscription mode.
 *
 *   npm run kimi:login
 *   node scripts/kimi-login.mjs
 */
import { spawn } from 'node:child_process';
import {
  startKimiDeviceLogin,
  pollKimiDeviceLogin,
  KIMI_CRED_PATH,
} from './kimi-oauth.mjs';

function openUrl(url) {
  const plat = process.platform;
  try {
    if (plat === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
  }
}

const auth = await startKimiDeviceLogin();
console.log('Kimi Code subscription login');
console.log('');
console.log(`1. Open: ${auth.verificationUriComplete}`);
console.log(`2. Confirm code: ${auth.userCode}`);
console.log('');
console.log('Waiting for browser approval…');
openUrl(auth.verificationUriComplete);

const creds = await pollKimiDeviceLogin(auth.deviceCode, auth.interval);
console.log('');
console.log(`Logged in. Saved: ${KIMI_CRED_PATH}`);
console.log(
  `Token expires at: ${new Date(creds.expires_at * 1000).toISOString()}`,
);
console.log('Restart Auto (npm run supervise) if it is already running.');
