'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { decide } = require('./guard');
const { classify } = require('./jobs');
const voice = require('./voice');

const pexec = promisify(execFile);

const REPO = path.join(os.homedir(), 'Documents', 'Projects', 'Jarvis');
const VAULT = path.join(os.homedir(), 'Documents', "J's AI Brain");

let win;
let sessionId;   // Agent SDK session, so the conversation survives across turns
let running;     // active Query, for cancel
let mic;         // active Deepgram socket

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#06080d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---------------------------------------------------------------- chat

ipcMain.handle('jarvis:ask', async (_e, prompt) => {
  // ESM-only package; require() would throw in this CommonJS main.
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const q = query({
    prompt,
    options: {
      cwd: REPO,
      additionalDirectories: [VAULT],
      settingSources: ['project'], // loads Jarvis CLAUDE.md -> vault pointers
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          'You are Jarvis, speaking to the operator in their local command center app. ' +
          'The vault at ~/Documents/J\'s AI Brain is the single source of truth. ' +
          'Never auto-send, auto-deploy, auto-spend, or push — draft and let the operator ratify.',
      },
      tools: { type: 'preset', preset: 'claude_code' },
      canUseTool: async (toolName, input) => decide(toolName, input),
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });
  running = q;
  const turnTouched = []; // scoped to this turn — a concurrent turn must never clear another's taint
  let reply = '';

  try {
    for await (const msg of q) {
      if (msg.session_id) sessionId = msg.session_id;

      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            reply += block.text;
            send('jarvis:text', block.text);
          }
          if (block.type === 'tool_use') {
            // Record what was read so the TTS gate can taint this turn.
            const p = block.input?.file_path || block.input?.path || block.input?.command;
            if (p) turnTouched.push(String(p));
            send('jarvis:tool', { name: block.name, input: block.input });
          }
        }
      } else if (msg.type === 'result') {
        send('jarvis:done', {
          error: msg.is_error ? msg.result || 'error' : null,
          turns: msg.num_turns,
          ms: msg.duration_ms,
          reply: reply.trim(),
          touched: turnTouched,
        });
      }
    }
  } catch (err) {
    send('jarvis:done', { error: String(err && err.message ? err.message : err) });
  } finally {
    running = null;
  }
});

ipcMain.handle('jarvis:cancel', () => {
  try { running && running.interrupt && running.interrupt(); } catch { /* already gone */ }
});

// ---------------------------------------------------------------- voice
// Keys live here, never in the renderer. Renderer ships raw PCM up; we relay
// it to Deepgram and hand transcripts back.

ipcMain.handle('voice:config', () => {
  const c = voice.loadConfig();
  return { stt: !!(c && c.deepgram), tts: !!(c && c.elevenlabs), confPath: voice.CONF };
});

ipcMain.handle('voice:start', (_e, sampleRate) => {
  const c = voice.loadConfig();
  if (!c || !c.deepgram) return { ok: false, why: 'voice not configured' };
  try {
    mic = voice.listen({
      key: c.deepgram,
      sampleRate,
      onTranscript: (text, final) => send('voice:transcript', { text, final }),
      onError: (why) => send('voice:error', why),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, why: String(err.message || err) };
  }
});

// Fires many times a second — `on`, not `handle`, so there's no reply to await.
ipcMain.on('voice:chunk', (_e, buf) => mic && mic.send(buf));

ipcMain.handle('voice:stop', () => { mic && mic.stop(); mic = null; });

ipcMain.handle('voice:speak', async (_e, text, touched) => {
  const c = voice.loadConfig();
  if (!c || !c.elevenlabs) return { ok: false, why: 'tts not configured' };

  const gate = voice.speakable(text, touched || []);
  if (!gate.ok) return { ok: false, why: gate.why, blocked: true };

  try {
    const mp3 = await voice.speak(text, { key: c.elevenlabs, voiceId: c.voiceId });
    return { ok: true, mp3: mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) };
  } catch (err) {
    return { ok: false, why: String(err.message || err) };
  }
});

// ---------------------------------------------------------------- status strip

ipcMain.handle('jarvis:status', async () => {
  let jobs = [];
  try {
    const { stdout } = await pexec('/bin/launchctl', ['list']);
    jobs = classify(stdout);
  } catch { /* launchctl unavailable — show empty rather than crash */ }

  let brief = null;
  try {
    const p = path.join(VAULT, '06 Company', '(C) Morning Briefing.md');
    brief = (await fs.stat(p)).mtime.toISOString();
  } catch { /* no briefing yet */ }

  return { jobs, brief, session: sessionId || null };
});

// ---------------------------------------------------------------- vault

const inVault = (p) => {
  const abs = path.resolve(VAULT, p);
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) throw new Error('outside vault');
  return abs;
};

ipcMain.handle('vault:list', async (_e, rel = '') => {
  const dir = inVault(rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, dir: d.isDirectory(), rel: path.join(rel, d.name) }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});

// iCloud/Obsidian can hold a note locked (EDEADLK) — retry rather than lie
// that the file is missing. v1.4.1 lesson.
ipcMain.handle('vault:read', async (_e, rel) => {
  const file = inVault(rel);
  for (let i = 0; i < 5; i++) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('note not found');
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw new Error('vault busy — file is locked, try again');
});
