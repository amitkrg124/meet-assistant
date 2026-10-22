// Voice-activity segmenter: decides where one spoken phrase ends and the next
// begins. Loaded as a plain script by index.html and as a module by the tests,
// so the timing behaviour can be simulated without Web Audio.
(function (factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.MeetSegmenter = api;
})(function () {
  const SEG = {
    tickMs: 40,
    minSpeechMs: 240, // shorter than this is a cough, not a phrase
    maxPhraseMs: 8000, // chunk monologues so they transcribe as they happen
    idleResetMs: 1200, // recycle while idle; caps silence prepended to a phrase
    calibrationMs: 1400,
    ceiling: 0.045, // never demand a louder voice than this
    hysteresis: 0.6, // mid-sentence the bar drops, so dips between words don't cut
  };

  // sensitivity 1..5 → [ambient multiplier, absolute floor ]
  const SENSITIVITY = {
    1: [4.5, 0.0110],
    2: [3.6, 0.0085],
    3: [3.0, 0.0065],
    4: [2.4, 0.0048],
    5: [1.8, 0.0032],
  };

  // Returns "none" | "emit" (phrase complete, send it) | "discard" (nothing
  // worth sending; start a fresh buffer).
  function createSegmenter({ sensitivity = 3, pauseMs = 700, now = 0, cfg = SEG } = {}) {
    const [mult, floor] = SENSITIVITY[sensitivity] || SENSITIVITY[3];
    let threshold = floor;
    let calibrating = true;
    let cal = [];
    let speechMs = 0;
    let lastSpeech = 0;
    let started = now;
    let talking = false;

    return {
      get threshold() { return threshold; },
      get talking() { return talking; },
      get calibrating() { return calibrating; },

      reset(t) {
        started = t;
        speechMs = 0;
        lastSpeech = 0;
        talking = false;
      },

      // Ambient level over the calibration window sets the speech bar, so a
      // noisy room and a silent one both work without the user touching a dial.
      finishCalibration() {
        calibrating = false;
        if (cal.length) {
          const avg = cal.reduce((a, b) => a + b, 0) / cal.length;
          threshold = Math.min(cfg.ceiling, Math.max(floor, avg * mult));
        }
        cal = [];
        return threshold;
      },

      feed(rms, t) {
        if (calibrating) {
          cal.push(rms);
          return "none";
        }
        const bar = talking ? threshold * cfg.hysteresis : threshold;
        if (rms > bar) {
          speechMs += cfg.tickMs;
          lastSpeech = t;
        }
        talking = lastSpeech > 0 && t - lastSpeech < pauseMs;

        if (speechMs >= cfg.minSpeechMs && (!talking || t - started >= cfg.maxPhraseMs)) return "emit";
        if (!speechMs && t - started >= cfg.idleResetMs) return "discard";
        if (speechMs && speechMs < cfg.minSpeechMs && !talking) return "discard";
        return "none";
      },
    };
  }

  return { SEG, SENSITIVITY, createSegmenter };
});
