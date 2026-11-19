// Reading answers aloud: Windows voice or the JARVIS avatar.
import { $, state, toast } from './shared.js';
import { cleanError } from './runs.js';

// ---------- speech ----------
export let speaking = false;
function setSpeaking(on) { speaking = on; $('#btn-stop-speech').disabled = !on; }
export function stopSpeaking() { window.speechSynthesis.cancel(); setSpeaking(false); }

function chunks(text) {
  const out = []; let cur = '';
  for (const s of text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*\s*/g) || []) {
    if ((cur + s).length > 220 && cur) { out.push(cur); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export async function windowsSpeak(text) {
  stopSpeaking();
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => v.name === state.settings.speech.voice) || voices.find((v) => /en[-_]US/i.test(v.lang)) || null;
  const parts = chunks(text);
  if (!parts.length) return;
  setSpeaking(true);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    if (voice) u.voice = voice;
    u.rate = Number(state.settings.speech.rate) || 1;
    if (i === parts.length - 1) { u.onend = () => setSpeaking(false); u.onerror = () => setSpeaking(false); }
    window.speechSynthesis.speak(u);
  });
}

export async function speak(markdown, { manual = false, final = false } = {}) {
  const s = state.settings.speech;
  if (s.muted) { if (manual) toast('Voice is muted. Press 🔇 to unmute.'); return; }
  if (s.output === 'off' && !manual) return;
  if (final) { state.lastFinal = markdown; $('#btn-replay').disabled = false; }
  const text = await ron.speechText(markdown);
  if (s.output === 'jarvis' && final) {
    try {
      const r = await ron.jarvisSpeak(markdown);
      toast(r.clipped ? 'Sent to the JARVIS avatar (long answer shortened for speech)' : 'Sent to the JARVIS avatar');
      return;
    } catch (e) { toast(`JARVIS avatar unavailable — using Windows voice. ${cleanError(e)}`); }
  }
  windowsSpeak(text);
}

export function maybeAutoSpeak(run) {
  if (run.status === 'running' || state.spoken.has(run.id)) return;
  if (run.mode !== 'review' || run.final?.state !== 'done') return;
  state.spoken.add(run.id);
  state.lastFinal = run.final.text; $('#btn-replay').disabled = false;
  if (state.settings.speech.autoSpeak) speak(run.final.text, { final: true });
}
