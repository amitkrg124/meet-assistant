// Pure transcript heuristics — no Electron, no network, so they can be tested
// directly (see detect.test.js).

const QUESTION_START =
  /^(what|why|how|when|where|who|whose|which|can|could|would|will|shall|do|does|did|is|are|isn'?t|aren'?t|was|were|should|have|has|had|any|tell me|tell us|explain|describe|walk (me|us) through|elaborate|clarify|define|talk about|go over|give me|give us|share|discuss|compare|contrast|outline|summari[sz]e|suppose|imagine|consider|let'?s|let us|help me understand|i'?d like to (know|hear)|i'?m curious|curious)\b/i;

const QUESTION_INTERIOR =
  /\b(what is|what are|what was|what were|what does|what do|what would|how do|how does|how did|how can|how would|how is|how are|how many|how much|could you|would you|can you|will you|do you|did you|does it|is there|are there|have you|had you|should we|shall we|your (experience|thoughts|approach|take|view)|about yourself|walk (me|us) through|tell (me|us) about|for example|an example of)\b/i;

// Speech-to-text models invent filler on near-silence ("Thank you.", "Thanks
// for watching!"). These carry no meaning and used to surface as phantom
// questions, which is a large part of why the overlay felt confusing.
const JUNK_LINE =
  /^(thank you|thanks( for watching| so much)?|okay|ok|yeah|yep|yes|no|nope|uh+|um+|mm+|hmm+|ah+|oh+|so|right|sure|bye|goodbye|hello|hi|hey|mm[-\s]?h?mm|mhm+|uh[-\s]?huh|uh[-\s]?oh|\.|\?|…|\[[^\]]*\]|\([^)]*\))[.!?,-]*$/i;

function isQuestion(text) {
  if (!text) return false;
  if (text.includes("?")) return true;
  const t = text.trim();
  return QUESTION_START.test(t) || QUESTION_INTERIOR.test(t);
}

function isJunk(text) {
  const s = (text || "").trim();
  if (s.length < 3) return true;
  return JUNK_LINE.test(s);
}

// True when `prev` looks like the first half of a question that `next`
// finishes — i.e. the interviewer paused long enough mid-sentence to close the
// phrase. Unterminated text is the tell; a line ending in ? . or ! was a
// complete thought and must not be glued to whatever follows.
function looksUnfinished(text) {
  const s = (text || "").trim();
  if (!s) return false;
  if (/[?.!]$/.test(s)) return false;
  return true;
}

// Should this speaker's question trigger an answer?
//   hasInterviewerTrack=true  → only the interviewer's lines count; the user's
//     own voice is context. This is what stops the assistant answering you.
//   hasInterviewerTrack=false → there is no way to tell the voices apart, so
//     everything counts, otherwise nothing would ever be answered.
function shouldAnswer({ speaker, autoAnswer, onlyInterviewer, hasInterviewerTrack }) {
  if (!autoAnswer) return false;
  if (onlyInterviewer && hasInterviewerTrack && speaker !== "them") return false;
  return true;
}

module.exports = { isQuestion, isJunk, looksUnfinished, shouldAnswer };
