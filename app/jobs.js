'use strict';
// launchctl list classification. Mirrors bin/watchdog.sh — a label being
// present proves nothing: a crash-looping job still lists. Daemons must hold a
// PID; any job can exit 78 (EX_CONFIG). Signal deaths (negative) are normal on
// reload. This is the check that missed two multi-day outages before v1.5.

const DAEMONS = new Set(['telegrambot', 'voiceserver']);

/** @param {string} stdout raw `launchctl list` output */
function classify(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.includes('com.jaysbrain.'))
    .map((line) => {
      const [pid, status, full] = line.trim().split(/\s+/);
      const label = (full || '').replace(/^com\.jaysbrain\./, '');
      const exit = Number(status);
      const alive = pid !== '-';

      let state = 'ok';
      if (exit === 78) state = 'crit';                       // EX_CONFIG crash loop
      else if (DAEMONS.has(label) && !alive) state = 'crit'; // 24/7 job not running
      else if (!alive && exit > 0) state = 'warn';           // last run failed

      return { label, pid, exit, state };
    });
}

module.exports = { classify };

if (require.main === module) {
  const assert = require('node:assert');
  const one = (s) => classify(s)[0];

  // daemon alive -> ok; daemon dead -> crit even with a clean exit code
  assert.equal(one('730\t0\tcom.jaysbrain.telegrambot').state, 'ok');
  assert.equal(one('-\t0\tcom.jaysbrain.telegrambot').state, 'crit');
  assert.equal(one('-\t0\tcom.jaysbrain.voiceserver').state, 'crit');

  // scheduled job idle between runs is normal, not a failure
  assert.equal(one('-\t0\tcom.jaysbrain.briefingpush').state, 'ok');
  // ...but a nonzero last exit is
  assert.equal(one('-\t1\tcom.jaysbrain.marketradar').state, 'warn');
  // exit 78 is critical on any job
  assert.equal(one('-\t78\tcom.jaysbrain.dailysync').state, 'crit');
  // SIGTERM on reload is not a failure
  assert.equal(one('-\t-15\tcom.jaysbrain.watchdog').state, 'ok');

  assert.equal(one('730\t0\tcom.jaysbrain.telegrambot').label, 'telegrambot');
  assert.equal(classify('-\t0\tcom.apple.something').length, 0);
  assert.equal(classify('').length, 0);

  console.log('jobs.js: all checks pass');
}
