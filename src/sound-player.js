// Marimba-style cues ported from zylos-dashboard public/js/fleet-sounds.js
// (timbre and note timings ear-picked by Howard, dashboard issue #218/#223).
let audioCtx = null;

function ensureContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

// Fixed pitch, near-instant attack into exponential decay, plus a quiet
// 4th-harmonic partial fading faster than the fundamental — reads as
// "wooden bar" instead of "synth blip".
function strike(ctx, { freq, at, decay = 0.28, peak = 0.34 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + decay + 0.05);
  const partial = ctx.createOscillator();
  const partialGain = ctx.createGain();
  partial.type = 'sine';
  partial.frequency.setValueAtTime(freq * 4, at);
  partialGain.gain.setValueAtTime(0.0001, at);
  partialGain.gain.exponentialRampToValueAtTime(peak * 0.25, at + 0.004);
  partialGain.gain.exponentialRampToValueAtTime(0.0001, at + decay * 0.6);
  partial.connect(partialGain).connect(ctx.destination);
  partial.start(at);
  partial.stop(at + decay);
}

// Scheduling at exactly currentTime clips a random slice of the attack ramp;
// a fixed lead also gives sleepy output paths time to wake.
const SCHEDULE_LEAD = 0.08;

const CUES = {
  // two rising strikes (E5 -> A5) — dashboard "start"
  start: (ctx, at) => {
    strike(ctx, { freq: 659, at });
    strike(ctx, { freq: 880, at: at + 0.13 });
  },
  // three falling strikes (A5 -> E5 -> B4) — dashboard "finish"
  finish: (ctx, at) => {
    strike(ctx, { freq: 880, at });
    strike(ctx, { freq: 659, at: at + 0.12 });
    strike(ctx, { freq: 494, at: at + 0.24, decay: 0.4 });
  },
  // same timbre family, pet-specific: double tap on A5 — "needs you"
  waiting: (ctx, at) => {
    strike(ctx, { freq: 880, at });
    strike(ctx, { freq: 880, at: at + 0.15 });
  },
  // low falling pair (B4 -> G4) — "stuck", deliberately not the finish phrase
  stuck: (ctx, at) => {
    strike(ctx, { freq: 494, at });
    strike(ctx, { freq: 392, at: at + 0.13, decay: 0.4 });
  },
};

function playCue(name) {
  const cue = CUES[name];
  if (!cue) return;
  const ctx = ensureContext();
  if (!ctx) return;
  const play = () => cue(ctx, ctx.currentTime + SCHEDULE_LEAD);
  if (ctx.state === 'running') {
    play();
  } else {
    const requestedAt = Date.now();
    ctx.resume().then(() => {
      if (ctx.state === 'running' && Date.now() - requestedAt < 2000) play();
    }).catch(() => {});
  }
}

module.exports = { playCue };
