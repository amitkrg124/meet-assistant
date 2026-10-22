const $ = (id) => document.getElementById(id);

const panel = $("panel");
const stateEl = $("state");
const question = $("question");
const qwho = $("qwho");
const answer = $("answer");
const meters = $("meters");
const tbox = $("tbox");
const tlist = $("tlist");
const done = $("done");
const restart = $("restart");
const panelArea = $("panel-area");

let alpha = 0.8;
let showTranscript = true;

// ============================================================
// status line — one writer, so nothing fights over the text
// ============================================================

const ui = {
  listening: false,
  calibrating: false,
  hearing: null, // "them" | "me" | null
  thinking: false,
  cooldown: false,
  error: null,
  note: null, // sticky, e.g. "listening, but system audio is unavailable"
  notice: null, // transient, e.g. "phrase dropped"
};

let noticeTimer = 0;

const STATE_CLASSES = ["s-listening", "s-calibrating", "s-them", "s-me", "s-thinking", "s-error"];

function renderStatus() {
  let text;
  let cls = null;

  if (ui.error) {
    text = ui.error;
    cls = "s-error";
  } else if (ui.notice) {
    text = ui.notice;
    cls = ui.listening ? "s-calibrating" : null;
  } else if (ui.thinking) {
    text = "Answering…";
    cls = "s-thinking";
  } else if (!ui.listening) {
    text = ui.note || "Idle";
  } else if (ui.calibrating) {
    text = "Calibrating…";
    cls = "s-calibrating";
  } else if (ui.hearing === "them") {
    text = "Interviewer speaking";
    cls = "s-them";
  } else if (ui.hearing === "me") {
    text = "You speaking";
    cls = "s-me";
  } else if (ui.cooldown) {
    text = "Queued…";
    cls = "s-listening";
  } else {
    text = ui.note || "Listening";
    cls = "s-listening";
  }

  if (stateEl.textContent !== text) stateEl.textContent = text;
  for (const c of STATE_CLASSES) {
    const want = c === cls;
    if (panel.classList.contains(c) !== want) panel.classList.toggle(c, want);
  }
}
renderStatus();

// ============================================================
// answer streaming — coalesce tokens into one paint per frame
// ============================================================

let pending = "";
let rafId = 0;
let streaming = false;

function appendAnswer(text) {
  pending += text;
  if (!rafId) rafId = requestAnimationFrame(flushAnswer);
}

function flushAnswer() {
  rafId = 0;
  if (!pending) return;
  // Stick to the bottom only if the user hasn't scrolled away.
  const atBottom = answer.scrollHeight - answer.scrollTop - answer.clientHeight < 48;
  // appendChild beats `textContent +=`, which re-creates the whole text node.
  answer.appendChild(document.createTextNode(pending));
  pending = "";
  if (atBottom) answer.scrollTop = answer.scrollHeight;
}

function resetAnswer() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  pending = "";
  answer.textContent = "";
  answer.classList.remove("error");
  answer.scrollTop = 0;
}

function setStreaming(on) {
  streaming = on;
  answer.classList.toggle("streaming", on);
}

// Scroll in a click-through window: apply exactly once, instantly.
// (The old code called scrollBy *and* let the native scroll through, which
// double-applied every notch and felt like lag.)
answer.addEventListener("wheel", (e) => {
  e.preventDefault();
  answer.scrollTop += e.deltaY;
}, { passive: false });

// ============================================================
// live transcript strip
// ============================================================

const TRANSCRIPT_LINES = 3;
const lines = [];

function pushLine(speaker, text) {
  lines.push({ speaker, text });
  if (lines.length > TRANSCRIPT_LINES) lines.shift();
  renderTranscript();
}

function renderTranscript() {
  tbox.classList.toggle("has-lines", lines.length > 0);
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const row = document.createElement("div");
    row.className = l.speaker === "me" ? "tline me" : "tline";
    const who = document.createElement("span");
    who.className = "tw";
    who.textContent = l.speaker === "me" ? "you" : "them";
    const tt = document.createElement("span");
    tt.className = "tt";
    tt.textContent = l.text;
    row.append(who, tt);
    frag.appendChild(row);
  }
  tlist.replaceChildren(frag);
}

function clearTranscript() {
  lines.length = 0;
  renderTranscript();
}

function applyTranscriptVisibility() {
  tbox.hidden = !showTranscript;
}

// ============================================================
// responsive: react to the window the user actually dragged out
// ============================================================

new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  document.body.classList.toggle("compact", width < 620 || height < 260);
  document.body.classList.toggle("tiny", width < 440 || height < 210);
}).observe(document.body);

// ============================================================
// main process messages
// ============================================================

window.overlay.onMessage((msg) => {
  switch (msg.type) {
    case "listen":
      if (msg.on) startListening(msg);
      else stopListening();
      break;

    case "heard":
      pushLine(msg.speaker, msg.text);
      break;

    case "question":
      setEmpty(false);
      question.textContent = msg.text;
      qwho.textContent = msg.speaker === "me" ? "you" : "interviewer";
      qwho.className = msg.speaker === "me" ? "chip me" : "chip them";
      resetAnswer();
      setStreaming(true);
      ui.thinking = true;
      ui.error = null;
      renderStatus();
      break;

    case "delta":
      appendAnswer(msg.text);
      break;

    case "done":
      setStreaming(false);
      ui.thinking = false;
      renderStatus();
      break;

    case "error":
      setEmpty(false);
      setStreaming(false);
      resetAnswer();
      answer.textContent = msg.text;
      answer.classList.add("error");
      ui.thinking = false;
      ui.error = msg.short || "Error";
      renderStatus();
      // Errors shouldn't stick in the status line forever.
      setTimeout(() => { if (ui.error === (msg.short || "Error")) { ui.error = null; renderStatus(); } }, 6000);
      break;

    case "clear":
      setEmpty(true);
      question.textContent = "";
      resetAnswer();
      setStreaming(false);
      clearTranscript();
      ui.thinking = false;
      ui.cooldown = false;
      ui.error = null;
      renderStatus();
      break;

    case "scroll":
      answer.scrollTop += msg.by;
      break;

    case "opacity":
      setAlpha(alpha + msg.by);
      break;

    case "opacity-set":
      setAlpha(msg.value);
      break;

    case "interactive":
      panel.classList.toggle("interactive", msg.on);
      if (!msg.on) closePanel();
      break;

    case "panel":
      if (msg.on) openPanel();
      else closePanel();
      break;

    case "cooldown":
      ui.cooldown = msg.on;
      renderStatus();
      break;

    // A short-lived status-line message. Unlike "error" it leaves whatever
    // answer is on screen alone, so a single dropped phrase doesn't wipe
    // something the user is mid-way through reading.
    case "notice":
      ui.notice = msg.text;
      renderStatus();
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { ui.notice = null; renderStatus(); }, msg.ms || 3000);
      break;

    case "transcript":
      showTranscript = msg.on;
      applyTranscriptVisibility();
      break;

    case "settings":
      showTranscript = msg.showTranscript !== false;
      applyTranscriptVisibility();
      break;
  }
});

done.addEventListener("click", () => window.overlay.setInteractive(false));
restart.addEventListener("click", () => window.overlay.clear());

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !panelArea.hidden) window.overlay.closePanel();
});

function setEmpty(on) {
  panel.classList.toggle("empty", on);
}

function setAlpha(v) {
  // Floor at 0.3: below that the streaming answer stops being readable over a
  // bright window behind it, and the overlay is useless.
  alpha = Math.min(1, Math.max(0.3, v));
  panel.style.setProperty("--alpha", alpha);
}

// ============================================================
// Capture
//
// Two *independent* tracks, never mixed:
//   them → system/loopback audio (what the interviewer says)
//   me   → microphone, with echo cancellation on so it does not
//          re-record the interviewer coming out of the speakers
//
// Each track runs its own VAD and its own MediaRecorder, and every
// phrase is sent upstream tagged with its speaker. Mixing the two
// into one stream (the previous design) made speaker attribution
// impossible and left the system track out of the VAD entirely.
// ============================================================

const { SEG, createSegmenter } = MeetSegmenter;
const MIN_BLOB_BYTES = 1200; // below this there is no speech worth uploading

let session = null;
// Bumped on every start. Opening a stream is async, so a fast toggle (or a
// settings save mid-session) could otherwise leave two pipelines running and
// transcribe every phrase twice.
let startGen = 0;

async function getMicStream(deviceId, echoCancel) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined,
      echoCancellation: echoCancel,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

async function getSystemStream(sysDeviceId) {
  // A named loopback input (macOS/Linux virtual device) wins when configured.
  if (sysDeviceId) {
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: sysDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  const sourceId = await window.overlay.getDesktopSourceId();
  if (!sourceId) throw new Error("no screen source for loopback audio");
  // Chromium only hands over desktop audio when video is requested too.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } },
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 1, maxHeight: 1 } },
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) throw new Error("system audio returned no track");
  return stream;
}

function createTrack({ id, stream, ctx, sensitivity, pauseMs, meterFill }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const seg = createSegmenter({ sensitivity, pauseMs, now: performance.now() });

  const track = { id, stream, level: 0, meterFill, talking: false, current: null, dead: false };

  const newRecorder = () => {
    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 32000, // speech-grade: smaller upload, faster transcription
      });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    const chunks = [];
    const keep = { value: false };
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      if (!keep.value) return;
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size < MIN_BLOB_BYTES) return;
      const bytes = await blob.arrayBuffer();
      window.overlay.sendAudio({ speaker: id, bytes: new Uint8Array(bytes) });
    };
    recorder.onerror = () => { track.dead = true; };
    recorder.start();
    seg.reset(performance.now());
    return { recorder, keep };
  };

  track.current = newRecorder();

  const cut = (keep) => {
    track.current.keep.value = keep;
    try { track.current.recorder.stop(); } catch {}
    track.current = newRecorder();
  };

  track.tick = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    track.level = rms;

    const action = seg.feed(rms, performance.now());
    track.talking = seg.talking;
    if (action === "emit") cut(true);
    else if (action === "discard") cut(false);
  };

  track.finishCalibration = () => seg.finishCalibration();

  track.stop = () => {
    track.current.keep.value = false;
    try { track.current.recorder.stop(); } catch {}
    stream.getTracks().forEach((t) => t.stop());
  };

  return track;
}

async function startListening(opts) {
  stopListening();
  const gen = ++startGen;
  const abandoned = () => {
    if (gen === startGen) return false;
    return true;
  };

  const {
    deviceId,
    audioSource = "both",
    sysDeviceId,
    echoCancel = true,
    vadSensitivity = 3,
    phrasePauseMs = 700,
  } = opts;

  const wantMe = audioSource === "mic" || audioSource === "both";
  const wantThem = audioSource === "system" || audioSource === "both";

  const opened = [];
  const problems = [];

  if (wantThem) {
    try {
      opened.push({ id: "them", stream: await getSystemStream(sysDeviceId) });
    } catch (err) {
      problems.push(`interviewer audio unavailable (${err.message})`);
    }
  }
  if (wantMe) {
    try {
      opened.push({ id: "me", stream: await getMicStream(deviceId, echoCancel) });
    } catch (err) {
      problems.push(`microphone unavailable (${err.message})`);
    }
  }

  // A newer start superseded this one while we were waiting on getUserMedia.
  if (abandoned()) {
    opened.forEach(({ stream }) => stream.getTracks().forEach((t) => t.stop()));
    return;
  }

  // Degrade instead of giving up: one working track still gets you answers.
  if (!opened.length) {
    setEmpty(false);
    resetAnswer();
    answer.textContent = `Can't open any audio input.\n\n${problems.join("\n")}\n\nOpen Setup (Ctrl+Shift+P) → Audio and pick a different source.`;
    answer.classList.add("error");
    ui.listening = false;
    ui.error = "No audio input";
    renderStatus();
    return;
  }

  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  if (abandoned()) {
    opened.forEach(({ stream }) => stream.getTracks().forEach((t) => t.stop()));
    ctx.close().catch(() => {});
    return;
  }

  const tracks = opened.map(({ id, stream }) =>
    createTrack({
      id,
      stream,
      ctx,
      sensitivity: vadSensitivity,
      pauseMs: phrasePauseMs,
      meterFill: document.querySelector(`#m-${id} .m-fill`),
    }),
  );

  session = { ctx, tracks, tickTimer: 0, meterTimer: 0, calTimer: 0 };
  ui.listening = true;
  ui.calibrating = true;
  ui.error = null;
  ui.note = problems.length ? `Listening — ${problems[0]}` : null;
  renderStatus();

  // Only show a meter for a track that actually opened.
  meters.hidden = false;
  for (const id of ["them", "me"]) {
    const el = $(`m-${id}`);
    if (el) el.hidden = !tracks.some((t) => t.id === id);
  }

  session.calTimer = setTimeout(() => {
    for (const t of tracks) t.finishCalibration();
    ui.calibrating = false;
    renderStatus();
  }, SEG.calibrationMs);

  session.tickTimer = setInterval(() => {
    for (const t of session.tracks) {
      if (!t.dead) t.tick();
    }
  }, SEG.tickMs);

  // Meters repaint at ~15fps on a transform (compositor only, no relayout).
  session.meterTimer = setInterval(() => {
    let hearing = null;
    for (const t of session.tracks) {
      const v = Math.min(1, Math.sqrt(t.level / 0.11));
      if (t.meterFill) t.meterFill.style.transform = `scaleX(${v.toFixed(3)})`;
      if (t.talking && !hearing) hearing = t.id;
      // "them" wins the status line: that's the voice that matters.
      if (t.talking && t.id === "them") hearing = "them";
    }
    if (ui.hearing !== hearing) {
      ui.hearing = hearing;
      renderStatus();
    }
  }, 66);

  window.overlay.sendTracks({ them: tracks.some((t) => t.id === "them"), me: tracks.some((t) => t.id === "me") });
  reportDevices();
}

function stopListening() {
  if (!session) return;
  clearInterval(session.tickTimer);
  clearInterval(session.meterTimer);
  clearTimeout(session.calTimer);
  for (const t of session.tracks) t.stop();
  session.ctx.close().catch(() => {});
  session = null;

  meters.hidden = true;
  ui.listening = false;
  ui.calibrating = false;
  ui.hearing = null;
  ui.note = null;
  renderStatus();
  window.overlay.sendTracks({ them: false, me: false });
}

async function reportDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    window.overlay.sendDevices(
      all
        .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.label)
        .map((d) => ({ deviceId: d.deviceId, label: d.label })),
    );
  } catch {}
}
reportDevices();

// ============================================================
// Setup / settings panel
// ============================================================

const tabBtns = document.querySelectorAll("#tab-bar .tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

function selectTab(tab) {
  tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  tabContents.forEach((c) => c.classList.toggle("active", c.dataset.tab === tab));
}
tabBtns.forEach((btn) => btn.addEventListener("click", () => selectTab(btn.dataset.tab)));

$("panel-close").addEventListener("click", () => window.overlay.closePanel());
$("panel-save").addEventListener("click", savePanelSettings);
$("panel-cancel").addEventListener("click", () => window.overlay.closePanel());

const cooldownSlider = $("set-cooldown");
const sensitivitySlider = $("set-sensitivity");
const pauseSlider = $("set-pause");
const opacitySlider = $("set-opacity");

const SENSITIVITY_LABEL = { 1: "1 · lowest", 2: "2 · low", 3: "3 · balanced", 4: "4 · high", 5: "5 · highest" };

cooldownSlider.addEventListener("input", () => {
  $("cooldown-val").textContent = cooldownSlider.value === "0" ? "none" : cooldownSlider.value + "s";
});
sensitivitySlider.addEventListener("input", () => {
  $("sensitivity-val").textContent = SENSITIVITY_LABEL[sensitivitySlider.value];
});
pauseSlider.addEventListener("input", () => {
  $("pause-val").textContent = pauseSlider.value + "ms";
});
opacitySlider.addEventListener("input", () => {
  $("opacity-val").textContent = opacitySlider.value + "%";
  setAlpha(parseInt(opacitySlider.value, 10) / 100); // live preview
});

$("upload-resume-btn").addEventListener("click", () => $("upload-resume").click());
$("upload-resume").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $("set-resume").value = reader.result; };
  reader.readAsText(file);
  e.target.value = "";
});

const audioSourceSelect = $("set-audio-source");
audioSourceSelect.addEventListener("change", updateAudioFieldVisibility);

let panelPlatform = "win32";

function updateAudioFieldVisibility() {
  const src = audioSourceSelect.value;
  $("set-mic-device").closest("label").hidden = src === "system";
  // Windows captures loopback through desktopCapturer — no device to choose.
  $("sys-device-label").hidden = src === "mic" || panelPlatform === "win32";
  $("set-echo-cancel").closest("label").hidden = src === "system";
}

async function openPanel() {
  const s = await window.overlay.getSettings();
  panelPlatform = await window.overlay.getPlatform();

  $("set-meeting-purpose").value = s.meetingPurpose || "";
  $("set-job-role").value = s.jobRole || "";
  $("set-job-description").value = s.jobDescription || "";
  $("set-resume").value = s.resume || "";

  audioSourceSelect.value = s.audioSource || "both";
  $("set-echo-cancel").checked = s.echoCancel !== false;
  $("set-model").value = s.model || "";
  $("set-transcribe-model").value = s.transcribeModel || "";
  $("set-language").value = s.transcribeLanguage || "";
  $("set-auto-answer").checked = s.autoAnswer !== false;
  $("set-only-interviewer").checked = s.answerOnlyInterviewer !== false;
  $("set-show-transcript").checked = s.showTranscript !== false;

  sensitivitySlider.value = s.vadSensitivity ?? 3;
  $("sensitivity-val").textContent = SENSITIVITY_LABEL[sensitivitySlider.value];
  pauseSlider.value = s.phrasePauseMs ?? 700;
  $("pause-val").textContent = pauseSlider.value + "ms";
  cooldownSlider.value = s.answerCooldownSec ?? 1;
  $("cooldown-val").textContent = cooldownSlider.value === "0" ? "none" : cooldownSlider.value + "s";
  opacitySlider.value = Math.round((s.opacity ?? 0.8) * 100);
  $("opacity-val").textContent = opacitySlider.value + "%";

  // Device lists. Labels only exist once mic permission has been granted,
  // so offer a sane fallback rather than an empty dropdown.
  let inputs = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.label);
  } catch {}

  const micSelect = $("set-mic-device");
  micSelect.replaceChildren(option("default", "Default microphone"));
  for (const d of inputs) micSelect.appendChild(option(d.deviceId, d.label));
  micSelect.value = inputs.some((d) => d.deviceId === s.micDeviceId) ? s.micDeviceId : "default";

  const sysSelect = $("set-sys-device");
  sysSelect.replaceChildren(option("", panelPlatform === "win32" ? "System loopback (automatic)" : "Select a loopback device…"));
  for (const d of inputs) sysSelect.appendChild(option(d.deviceId, d.label));
  sysSelect.value = inputs.some((d) => d.deviceId === s.sysDeviceId) ? s.sysDeviceId : "";

  updateAudioFieldVisibility();

  panelArea.hidden = false;
  panel.classList.add("panel-open");
  selectTab("context");
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function closePanel() {
  if (panelArea.hidden) return;
  panelArea.hidden = true;
  panel.classList.remove("panel-open");
}

async function savePanelSettings() {
  const partial = {
    meetingPurpose: $("set-meeting-purpose").value.trim(),
    jobRole: $("set-job-role").value.trim(),
    jobDescription: $("set-job-description").value.trim(),
    resume: $("set-resume").value.trim(),

    audioSource: audioSourceSelect.value,
    micDeviceId: $("set-mic-device").value,
    sysDeviceId: $("set-sys-device").value,
    echoCancel: $("set-echo-cancel").checked,
    vadSensitivity: parseInt(sensitivitySlider.value, 10),
    phrasePauseMs: parseInt(pauseSlider.value, 10),

    model: $("set-model").value.trim(),
    transcribeModel: $("set-transcribe-model").value.trim(),
    transcribeLanguage: $("set-language").value.trim(),

    autoAnswer: $("set-auto-answer").checked,
    answerOnlyInterviewer: $("set-only-interviewer").checked,
    answerCooldownSec: parseInt(cooldownSlider.value, 10),

    opacity: parseInt(opacitySlider.value, 10) / 100,
    showTranscript: $("set-show-transcript").checked,
  };
  await window.overlay.saveSettings(partial);
  setAlpha(partial.opacity);
  showTranscript = partial.showTranscript;
  applyTranscriptVisibility();
  window.overlay.closePanel();
}
