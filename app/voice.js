'use strict';
// Phase 2 voice: Deepgram (speech->text) in, ElevenLabs (text->speech) out.
// Zero deps: Node 24 has global fetch + global WebSocket. Deepgram is
// authed with the `token` subprotocol (its documented path for clients that
// can't set an Authorization header) so the key never leaves this process.
//
// Dormant until configured — same exit-intent split as email triage (v1.6).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CONF = path.join(os.homedir(), 'Documents', 'Projects', 'Jarvis', 'config', 'voice-app.conf');

/** @returns {{deepgram?:string, elevenlabs?:string, voiceId:string}|null} null = dormant */
function loadConfig(confPath = CONF) {
  let raw;
  try {
    raw = fs.readFileSync(confPath, 'utf8');
  } catch {
    return null; // not configured yet — a valid idle state, not an error
  }
  const kv = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const cfg = {
    deepgram: kv.DEEPGRAM_KEY || '',
    elevenlabs: kv.ELEVENLABS_KEY || '',
    voiceId: kv.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
  };
  if (!cfg.deepgram && !cfg.elevenlabs) return null;
  return cfg;
}

// --- privacy boundary (PRD §10) ------------------------------------------
// Voice out is a CLOUD path: ElevenLabs receives the reply text. The
// never-leaves-the-machine rule (journals/health/faith) therefore applies to
// the speaker, not just the disk. A turn is unspeakable if Jarvis touched a
// protected vault path, or if the reply itself recites protected content.
//
// ponytail: path-tainting is exact; the keyword net is a coarse backstop for
// content recited from context. Upgrade path if it over-blocks: drop the
// keyword net and taint purely on tool reads.

const PROTECTED_PATH = /01 Journals|\/health|health\.md|Prayer|Faith|Journal/i;
const PROTECTED_WORD =
  /\b(journal entry|my journal|prayer|salah|namaz|confession|therapy|depress\w*|anxiet\w*|weight|blood pressure|heart rate|sleep score)\b/i;

/**
 * @param {string} text reply text about to be spoken
 * @param {string[]} touchedPaths file paths this turn's tools read/wrote
 * @returns {{ok:true} | {ok:false, why:string}}
 */
function speakable(text, touchedPaths = []) {
  for (const p of touchedPaths) {
    if (PROTECTED_PATH.test(String(p))) {
      return { ok: false, why: 'this answer draws on protected notes — on screen only' };
    }
  }
  if (PROTECTED_WORD.test(text)) {
    return { ok: false, why: 'this answer contains protected content — on screen only' };
  }
  return { ok: true };
}

// --- speech to text -------------------------------------------------------

/**
 * Opens a Deepgram live-transcription socket. Caller feeds PCM via send().
 * @param {{key:string, sampleRate:number, onTranscript:(t:string, final:boolean)=>void, onError:(e:string)=>void}} o
 */
function listen({ key, sampleRate, onTranscript, onError }) {
  const qs = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
  });
  // Subprotocol auth: ['token', <key>] -> Sec-WebSocket-Protocol: token, <key>
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs}`, ['token', key]);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'Results') return;
    const t = msg.channel?.alternatives?.[0]?.transcript;
    if (t) onTranscript(t, !!msg.is_final);
  });
  ws.addEventListener('error', () => onError('Deepgram connection failed — check DEEPGRAM_KEY'));

  return {
    send: (buf) => ws.readyState === 1 && ws.send(buf),
    stop: () => {
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close();
      } catch { /* already closed */ }
    },
  };
}

// --- text to speech -------------------------------------------------------

/** @returns {Promise<Buffer>} mp3 bytes */
async function speak(text, { key, voiceId }) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { loadConfig, speakable, listen, speak, CONF };

if (require.main === module) {
  const assert = require('node:assert');
  const osTmp = require('node:os');

  // loadConfig: missing file -> dormant (null), not an error
  assert.equal(loadConfig(path.join(osTmp.tmpdir(), 'jarvis-voice-test-missing.conf')), null);

  // loadConfig: parses both keys, quoted values, and defaults the voice id
  const bothPath = path.join(osTmp.tmpdir(), 'jarvis-voice-test-both.conf');
  fs.writeFileSync(bothPath, 'DEEPGRAM_KEY=dg123\nELEVENLABS_KEY="el456"\n');
  const both = loadConfig(bothPath);
  assert.equal(both.deepgram, 'dg123');
  assert.equal(both.elevenlabs, 'el456');
  assert.equal(both.voiceId, 'JBFqnCBsd6RMkjVDRZzb');
  fs.unlinkSync(bothPath);

  // loadConfig: either key alone is "partial", not dormant
  const oneKeyPath = path.join(osTmp.tmpdir(), 'jarvis-voice-test-one.conf');
  fs.writeFileSync(oneKeyPath, 'DEEPGRAM_KEY=dg123\n');
  assert.equal(loadConfig(oneKeyPath).elevenlabs, '');
  fs.unlinkSync(oneKeyPath);

  // speakable() has no shared state across calls — the per-turn taint set lives
  // entirely in main.js's call arguments now (see DECISIONS.md v2 Phase 2 taint-race
  // fix); a protected call sandwiched between two clean calls must not leak either way.
  assert.equal(speakable('clean one', []).ok, true);
  assert.equal(speakable('clean two', ['/vault/01 Journals/x.md']).ok, false);
  assert.equal(speakable('clean three', []).ok, true);

  // protected paths block the speaker
  assert.equal(speakable('All good.', ["/Users/j/J's AI Brain/01 Journals/2026-07-17.md"]).ok, false);
  assert.equal(speakable('ok', ['/vault/health.md']).ok, false);

  // protected content recited from context blocks it too
  assert.equal(speakable('Your journal entry from Tuesday says…').ok, false);
  assert.equal(speakable('Your resting heart rate is 58.').ok, false);

  // ordinary work speaks
  assert.equal(speakable('BSS deadline is in 58 days.').ok, true);
  assert.equal(speakable('Pushed the thesis draft.', ['/vault/06 Company/(C) Backlog.md']).ok, true);
  assert.equal(speakable('Three jobs are green.', []).ok, true);

  // a denial always explains itself
  assert.match(speakable('my journal').why, /screen only/);

  console.log('voice.js: all checks pass');
}
