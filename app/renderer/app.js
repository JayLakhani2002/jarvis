'use strict';
const $ = (id) => document.getElementById(id);
const thread = $('thread'), orb = $('orb'), input = $('input'), micBtn = $('mic');

let bubble = null;      // current streaming jarvis bubble
let cfg = { stt: false, tts: false };
let audio = null;       // { ctx, stream, node }
let recording = false;
let speaker = null;     // active HTMLAudioElement

const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
const scroll = (was) => { if (was) thread.scrollTop = thread.scrollHeight; };

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', id);
  svg.appendChild(use);
  return svg;
}

function add(cls, text) {
  const was = atBottom();
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  thread.appendChild(el);
  scroll(was);
  return el;
}

function setState(s, label) {
  orb.className = 'orb' + (s === 'idle' ? '' : ' ' + s);
  $('orb-label').textContent = label || s;
  $('stat-state').textContent = s;
  if (s !== 'listening') level(0);
}

const level = (v) => document.documentElement.style.setProperty('--level', String(v));

// ---------------- chat
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  submit(input.value.trim());
});

async function submit(prompt) {
  if (!prompt) return;
  thread.querySelector('.empty')?.remove();
  add('msg you', prompt);
  input.value = '';
  input.disabled = $('send').disabled = true;
  $('stop').hidden = false;
  bubble = null;
  setState('thinking', 'thinking');
  await window.jarvis.ask(prompt);
}

$('stop').addEventListener('click', () => window.jarvis.cancel());

window.jarvis.onText((text) => {
  if (orb.classList.contains('thinking')) setState('speaking', 'responding');
  if (!bubble) bubble = add('msg jarvis', '');
  const was = atBottom();
  bubble.textContent += text;
  scroll(was);
});

window.jarvis.onTool(({ name, input: args }) => {
  const detail = args?.command || args?.file_path || args?.pattern || '';
  const was = atBottom();
  const el = document.createElement('div');
  el.className = 'tool';
  el.appendChild(icon('#i-tools'));
  const s = document.createElement('span');
  s.textContent = name + (detail ? '  ' + String(detail).slice(0, 140) : '');
  el.appendChild(s);
  thread.appendChild(el);
  scroll(was);
  bubble = null; // text after a tool call starts a fresh bubble
});

window.jarvis.onDone(async ({ error, reply, touched }) => {
  input.disabled = $('send').disabled = false;
  $('stop').hidden = true;
  input.focus();
  refresh();

  if (error) { add('msg err', error); setState('error', 'error'); return; }
  setState('idle', 'ready');
  if (cfg.tts && reply) speakReply(reply, touched);
});

// ---------------- voice out
async function speakReply(text, touched) {
  const res = await window.voice.speak(text, touched);
  if (!res.ok) {
    // A privacy block is expected behavior, not a failure — say so plainly.
    if (res.blocked) add('msg note', res.why);
    return;
  }
  const url = URL.createObjectURL(new Blob([res.mp3], { type: 'audio/mpeg' }));
  speaker = new Audio(url);
  setState('speaking', 'speaking');
  speaker.onended = speaker.onerror = () => {
    URL.revokeObjectURL(url);
    setState('idle', 'ready');
  };
  speaker.play().catch(() => setState('idle', 'ready'));
}

// ---------------- voice in (push to talk)
async function startMic() {
  if (recording || !cfg.stt) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  } catch {
    add('msg err', 'Microphone blocked. Allow it in System Settings › Privacy & Security › Microphone, then reopen Jarvis.');
    return;
  }

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  const started = await window.voice.start(ctx.sampleRate);
  if (!started.ok) {
    add('msg err', started.why);
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return;
  }

  const node = new AudioWorkletNode(ctx, 'pcm');
  node.port.onmessage = ({ data }) => {
    window.voice.chunk(data.pcm);
    level(Math.min(1, data.peak * 2.2));
  };
  ctx.createMediaStreamSource(stream).connect(node);
  node.connect(ctx.destination); // keeps the graph pulling; worklet emits no audio

  audio = { ctx, stream, node };
  recording = true;
  micBtn.classList.add('recording');
  setState('listening', 'listening');
}

async function stopMic() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove('recording');
  await window.voice.stop();
  audio.node.disconnect();
  audio.stream.getTracks().forEach((t) => t.stop());
  await audio.ctx.close();
  audio = null;
  setState('idle', 'ready');
  level(0);
  if (input.value.trim()) submit(input.value.trim());
}

// live transcript fills the input; you can edit before it sends
window.voice.onTranscript(({ text, final }) => {
  if (final) input.value = (input.value ? input.value + ' ' : '') + text;
});
window.voice.onError((why) => { add('msg err', why); stopMic(); });

micBtn.addEventListener('pointerdown', startMic);
micBtn.addEventListener('pointerup', stopMic);
micBtn.addEventListener('pointerleave', () => recording && stopMic());

// ⌥Space push-to-talk
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'Space' && !e.repeat) { e.preventDefault(); startMic(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || !e.altKey) recording && stopMic();
});

// ---------------- nav
document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    $('view-command').hidden = view !== 'command';
    $('view-vault').hidden = view !== 'vault';
    if (view === 'vault') loadTree('');
  });
});

// ---------------- vault
async function loadTree(rel) {
  const tree = $('tree');
  tree.replaceChildren();

  const row = (iconId, label, onClick, isDir) => {
    const el = document.createElement('div');
    el.className = 'row' + (isDir ? ' dir' : '');
    el.tabIndex = 0;
    el.appendChild(icon(iconId));
    const s = document.createElement('span');
    s.textContent = label;
    el.appendChild(s);
    el.onclick = onClick;
    el.onkeydown = (e) => e.key === 'Enter' && onClick();
    tree.appendChild(el);
  };

  if (rel) row('#i-back', 'back', () => loadTree(rel.split('/').slice(0, -1).join('/')), true);

  try {
    for (const e of await window.jarvis.vaultList(rel)) {
      row(e.dir ? '#i-folder' : '#i-file', e.name, async () => {
        if (e.dir) return loadTree(e.rel);
        try { $('note').textContent = await window.jarvis.vaultRead(e.rel); }
        catch (err) { $('note').textContent = err.message; }
      }, e.dir);
    }
  } catch (err) {
    tree.textContent = err.message;
  }
}

// ---------------- status strip
async function refresh() {
  const s = await window.jarvis.status();
  const jobs = $('stat-jobs');

  if (!s.jobs.length) {
    jobs.textContent = 'jobs —';
    jobs.className = 'stat';
  } else {
    const bad = s.jobs.filter((j) => j.state !== 'ok');
    jobs.textContent = bad.length
      ? `${bad.length} job${bad.length > 1 ? 's' : ''} down: ${bad.map((j) => j.label).join(', ')}`
      : `${s.jobs.length} jobs ok`;
    jobs.className = 'stat ' + (bad.some((j) => j.state === 'crit') ? 'crit' : bad.length ? 'warn' : 'ok');
  }

  $('stat-brief').textContent = s.brief
    ? 'briefing ' + new Date(s.brief).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'briefing —';
  $('stat-session').textContent = s.session ? 'session ' + s.session.slice(0, 8) : 'session —';
}

// ---------------- boot
(async () => {
  cfg = await window.voice.config();
  const v = $('stat-voice');
  if (cfg.stt && cfg.tts) { v.textContent = 'voice ready'; v.className = 'stat live'; }
  else if (cfg.stt || cfg.tts) { v.textContent = 'voice partial'; v.className = 'stat warn'; }
  else { v.textContent = 'voice dormant'; v.className = 'stat'; }

  micBtn.disabled = !cfg.stt;
  if (!cfg.stt) micBtn.title = 'Voice dormant — add config/voice-app.conf';

  setState('idle', 'ready');
  refresh();
  setInterval(refresh, 30000);
  input.focus();
})();
