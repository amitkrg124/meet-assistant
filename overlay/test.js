// Real-life interview scenarios run against the actual shipped logic.
//   node test.js
const assert = require("node:assert/strict");
const { isQuestion, isJunk, looksUnfinished, shouldAnswer } = require("./detect");
const { SEG, createSegmenter } = require("./segmenter");

let pass = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fails.push(`${name}\n    ${err.message.split("\n")[0]}`);
  }
}

// ============================================================
// 1. Does the interviewer's line get recognised as a question?
// ============================================================

const SHOULD_ANSWER = [
  "So, what's your experience with distributed systems?",
  "Tell me about yourself.",
  "Tell me about a time you disagreed with your manager.",
  "Walk me through your last project.",
  "Can you describe how you'd scale this service?",
  "Why do you want to leave your current role?",
  "How would you debug a memory leak in production?",
  "Any experience with Kubernetes?",
  "I'd like to know how you handled that outage.",
  "Could you elaborate on the caching layer",
  "Give me an example of a hard technical trade-off you made.",
  "What's your notice period",
  "Describe your testing strategy.",
  "Do you have any questions for us?",
  "Let's talk about your time at Acme.",
  "I'm curious about the migration you mentioned.",
  "Explain the difference between a process and a thread.",
  "Where do you see yourself in five years?",
  "Have you worked with Postgres replication?",
  "What are your salary expectations",
];

for (const line of SHOULD_ANSWER) {
  test(`question: "${line}"`, () => assert.equal(isQuestion(line), true));
}

// Statements the interviewer makes that must NOT trigger an answer — these are
// the ones that used to make the overlay fire at random.
const SHOULD_NOT_ANSWER = [
  "Great, that makes a lot of sense.",
  "We're a team of about fifty engineers.",
  "I'll hand over to my colleague now.",
  "Thanks, that's really helpful context.",
  "My name is Priya and I lead the platform team.",
  "The role is mostly backend with some infra work.",
  "Perfect, let me share my screen.",
  "We use Go and Python here.",
];

for (const line of SHOULD_NOT_ANSWER) {
  test(`not a question: "${line}"`, () => assert.equal(isQuestion(line), false));
}

// ============================================================
// 2. Speech-recogniser hallucinations on silence
// ============================================================

const JUNK = [
  "Thank you.",
  "Thanks for watching!",
  "[BLANK_AUDIO]",
  "(silence)",
  "Okay.",
  "mm-hmm",
  "Uhh",
  "...",
  "ok",
  "Yeah",
  "  ",
];

for (const line of JUNK) {
  test(`junk dropped: "${line}"`, () => assert.equal(isJunk(line), true));
}

test("real speech is never treated as junk", () => {
  for (const line of SHOULD_ANSWER) assert.equal(isJunk(line), false, `wrongly junked: ${line}`);
  for (const line of SHOULD_NOT_ANSWER) assert.equal(isJunk(line), false, `wrongly junked: ${line}`);
});

// ============================================================
// 3. Speaker gating — the "it answers my own voice" complaint
// ============================================================

const BOTH_TRACKS = { autoAnswer: true, onlyInterviewer: true, hasInterviewerTrack: true };

test("interviewer's question is answered", () => {
  assert.equal(shouldAnswer({ ...BOTH_TRACKS, speaker: "them" }), true);
});

test("candidate's own question is ignored when the interviewer has its own track", () => {
  assert.equal(shouldAnswer({ ...BOTH_TRACKS, speaker: "me" }), false);
});

test("mic-only falls back to answering any voice, so it still works", () => {
  assert.equal(
    shouldAnswer({ autoAnswer: true, onlyInterviewer: true, hasInterviewerTrack: false, speaker: "me" }),
    true,
  );
});

test("auto-answer off means nothing fires", () => {
  assert.equal(shouldAnswer({ ...BOTH_TRACKS, speaker: "them", autoAnswer: false }), false);
});

test("opting out of speaker gating answers the candidate too", () => {
  assert.equal(shouldAnswer({ ...BOTH_TRACKS, speaker: "me", onlyInterviewer: false }), true);
});

// ============================================================
// 4. Questions split in half by a mid-sentence pause
// ============================================================

test("an unterminated fragment is marked as continuable", () => {
  assert.equal(looksUnfinished("So what's your experience"), true);
  assert.equal(looksUnfinished("Tell me about a time when you"), true);
});

test("a finished question is never glued to the next one", () => {
  assert.equal(looksUnfinished("What is your experience with Kafka?"), false);
  assert.equal(looksUnfinished("Tell me about yourself."), false);
  assert.equal(looksUnfinished("That's great!"), false);
});

// ============================================================
// 5. VAD segmentation — the latency and over-capture complaints
// ============================================================

// Drive the real segmenter with a synthetic level envelope.
// `envelope` is a list of [durationMs, rms] pairs.
function run(envelope, { sensitivity = 3, pauseMs = 700, ambient = 0.002 } = {}) {
  const seg = createSegmenter({ sensitivity, pauseMs, now: 0 });
  // calibration window first
  let t = 0;
  for (; t < SEG.calibrationMs; t += SEG.tickMs) seg.feed(ambient, t);
  seg.finishCalibration();
  seg.reset(t);

  // `at` is wall-clock from the start of the envelope; `len` is how much audio
  // the emitted buffer actually holds (time since the previous cut), which is
  // what determines upload size and transcription latency.
  const events = [];
  let elapsed = 0;
  let bufferStart = 0;
  for (const [dur, rms] of envelope) {
    const until = elapsed + dur;
    for (; elapsed < until; elapsed += SEG.tickMs, t += SEG.tickMs) {
      const action = seg.feed(rms, t);
      if (action !== "none") {
        events.push({ action, at: elapsed, len: elapsed - bufferStart });
        bufferStart = elapsed;
        seg.reset(t);
      }
    }
  }
  return { events, threshold: seg.threshold };
}

const SPEECH = 0.05; // a normal speaking level
const QUIET = 0.012; // a soft-spoken interviewer over laptop speakers
const SILENCE = 0.002;

test("one spoken phrase produces exactly one emit", () => {
  const { events } = run([[2000, SILENCE], [1600, SPEECH], [1500, SILENCE]]);
  const emits = events.filter((e) => e.action === "emit");
  assert.equal(emits.length, 1, `got ${emits.length} emits`);
});

test("a phrase is emitted within ~pauseMs of the speaker stopping", () => {
  const speechEndsAt = 2000 + 1600;
  const { events } = run([[2000, SILENCE], [1600, SPEECH], [1500, SILENCE]]);
  const emit = events.find((e) => e.action === "emit");
  const lag = emit.at - speechEndsAt;
  assert.ok(lag >= 0 && lag <= 700 + 2 * SEG.tickMs, `emit lag was ${lag}ms`);
});

test("long dead air is not prepended to the next phrase", () => {
  // 9s of silence before the question. The old build kept recording through all
  // of it and shipped the lot, which is what made transcription slow.
  const { events } = run([[9000, SILENCE], [1200, SPEECH], [1200, SILENCE]]);
  const emit = events.find((e) => e.action === "emit");
  assert.ok(
    events.some((e) => e.action === "discard" && e.at < emit.at),
    "idle buffers should have been recycled during the silence",
  );
  const budget = SEG.idleResetMs + 1200 + 700 + 2 * SEG.tickMs;
  assert.ok(emit.len <= budget, `phrase carried ${emit.len}ms of audio (budget ${budget}ms)`);
});

test("a short cough or keyboard knock is discarded, not transcribed", () => {
  const { events } = run([[1000, SILENCE], [120, SPEECH], [1500, SILENCE]]);
  assert.equal(events.filter((e) => e.action === "emit").length, 0);
});

test("a long monologue is chunked instead of waiting for the speaker to finish", () => {
  const { events } = run([[500, SILENCE], [30000, SPEECH], [1000, SILENCE]]);
  const emits = events.filter((e) => e.action === "emit");
  assert.ok(emits.length >= 3, `30s of speech produced only ${emits.length} chunks`);
  for (const e of emits) {
    assert.ok(e.len <= SEG.maxPhraseMs + 2 * SEG.tickMs, `chunk was ${e.len}ms long`);
  }
});

test("a brief dip between words does not split one question in two", () => {
  // "What's your experience" <220ms breath> "with Kubernetes?"
  const { events } = run([[500, SILENCE], [900, SPEECH], [220, SILENCE], [900, SPEECH], [1200, SILENCE]]);
  assert.equal(events.filter((e) => e.action === "emit").length, 1);
});

test("a soft-spoken interviewer is still captured at the default sensitivity", () => {
  const { events, threshold } = run([[1000, SILENCE], [1500, QUIET], [1200, SILENCE]], { sensitivity: 3 });
  assert.ok(threshold < QUIET, `threshold ${threshold.toFixed(4)} is above a quiet voice`);
  assert.equal(events.filter((e) => e.action === "emit").length, 1);
});

test("a noisy room does not trigger endless captures", () => {
  // Calibrate against steady background hiss, then feed only that hiss.
  const noise = 0.009;
  const { events } = run([[6000, noise]], { ambient: noise });
  assert.equal(events.filter((e) => e.action === "emit").length, 0);
});

test("highest sensitivity picks up a quieter voice than the lowest", () => {
  const low = createSegmenter({ sensitivity: 1, now: 0 });
  const high = createSegmenter({ sensitivity: 5, now: 0 });
  low.finishCalibration();
  high.finishCalibration();
  assert.ok(high.threshold < low.threshold);
});

test("a shorter phrase pause emits sooner", () => {
  const fast = run([[500, SILENCE], [1000, SPEECH], [1500, SILENCE]], { pauseMs: 400 });
  const slow = run([[500, SILENCE], [1000, SPEECH], [1500, SILENCE]], { pauseMs: 1200 });
  const f = fast.events.find((e) => e.action === "emit").at;
  const s = slow.events.find((e) => e.action === "emit").at;
  assert.ok(f < s, `fast=${f}ms slow=${s}ms`);
  assert.ok(s - f >= 700, `expected ~800ms difference, got ${s - f}ms`);
});

// ============================================================

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
for (const f of fails) console.log(`  ✗ ${f}\n`);
process.exit(fails.length ? 1 : 0);
