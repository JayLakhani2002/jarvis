'use strict';
// The draft-only boundary, expressed as a tool-permission gate.
// Jarvis may read/think/draft freely; it may never send, push, deploy, spend,
// or touch launchd. Jay does those by hand. See DECISIONS.md 2026-07-07.

const BLOCKED = [
  [/\bgit\s+(push|remote\s+add)\b/, 'git push — commits are Jay\'s to make'],
  [/\blaunchctl\b/, 'launchctl — schedule changes go through launchd/*.plist + ./install.sh'],
  [/\bapi\.telegram\.org\b|\bsendMessage\b/, 'Telegram send — Jarvis never initiates external contact'],
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, 'recursive delete'],
  [/\b(smtp|sendmail|mail\s+-s)\b/, 'outbound mail — there is no send path'],
  [/\b(vercel|netlify|fly\s+deploy|gh\s+release|npm\s+publish)\b/, 'deploy/publish'],
  [/>\s*\/dev\/(sd|disk)/, 'raw disk write'],
];

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @returns {{behavior:'allow'} | {behavior:'deny', message:string}}
 */
function decide(toolName, input) {
  if (toolName !== 'Bash') return { behavior: 'allow' };
  const cmd = String((input && input.command) || '');
  for (const [re, why] of BLOCKED) {
    if (re.test(cmd)) {
      return {
        behavior: 'deny',
        message: `Blocked by Jarvis draft-only boundary: ${why}. Draft it and let Jay ratify.`,
      };
    }
  }
  return { behavior: 'allow' };
}

module.exports = { decide };

if (require.main === module) {
  const assert = require('node:assert');
  const denied = (c) => decide('Bash', { command: c }).behavior === 'deny';
  const ok = (c) => decide('Bash', { command: c }).behavior === 'allow';

  assert(denied('git push origin main'));
  assert(denied('cd /tmp && launchctl list'));
  assert(denied('curl -s https://api.telegram.org/bot123/sendMessage -d x=1'));
  assert(denied('rm -rf ~/Documents'));
  assert(denied('rm -fr /tmp/x'));
  assert(denied('npm publish'));

  assert(ok('git status'));
  assert(ok('git commit -m "wip"'));       // committing is fine; pushing is not
  assert(ok('ls ~/Documents/Projects/Jarvis/bin'));
  assert(ok('rm /tmp/scratch.txt'));       // non-recursive delete is fine
  assert(ok('grep -r foo .'));

  assert(decide('Read', { file_path: '/etc/passwd' }).behavior === 'allow');
  assert(decide('Write', { file_path: '/x' }).behavior === 'allow');

  console.log('guard.js: all checks pass');
}
