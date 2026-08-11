// Mic float32 -> linear16 PCM, off the main thread.
// No resampling: we tell Deepgram the context's native sampleRate instead.
class PCM extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;

    const pcm = new Int16Array(ch.length);
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    // peak rides along so the orb can react to the voice, not fake it
    this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
    return true;
  }
}
registerProcessor('pcm', PCM);
