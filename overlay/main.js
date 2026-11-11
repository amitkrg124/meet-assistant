const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, session, desktopCapturer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { default: OpenAI, toFile } = require("openai");
const { loadSettings, saveSettings, getSettings } = require("./settings");
const { isQuestion, isJunk, looksUnfinished, shouldAnswer } = require("./detect");

const CONTEXT_LINES = 40;
const TRANSCRIBE_TIMEOUT_MS = 10000;
// A question that arrives this soon after an unfinished one is treated as its
// second half, and the in-flight answer is restarted with both parts.
const FOLLOWON_MS = 3500;

function loadEnv() {
  for (const file of [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
    path.join(process.resourcesPath || __dirname, ".env"),
    path.join(app.getPath("userData"), ".env"),
  ]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}
loadEnv();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
function getModel() { return getSettings().model || process.env.OPENAI_MODEL || "gpt-4o-mini"; }
function getTranscribeModel() { return getSettings().transcribeModel || process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"; }

if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals");
// GPU compositing stays ON. Disabling it forced every frame of the streaming
// answer through the CPU rasteriser, which is what made the overlay feel laggy.
// Set MEET_FORCE_CPU=1 if transparency misbehaves on a particular GPU driver.
if (process.env.MEET_FORCE_CPU === "1") app.disableHardwareAcceleration();

// ---------- sizing ----------

function getOverlaySize() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: Math.min(1000, Math.max(600, Math.round(workArea.width * 0.5))),
    height: Math.max(300, Math.round(workArea.height * 0.32)),
    heightPanel: Math.max(560, Math.round(workArea.height * 0.66)),
  };
}

const MIN_WIDTH = 380;
const MIN_HEIGHT = 170;
// Fixed toolbar footprint: #panel reserves exactly this much bottom padding, so
// content never reflows when the overlay changes state.
const TOOLBAR = { width: 392, height: 34, gap: 7 };

function getToolbarSize() {
  const w = win ? win.getBounds().width : getOverlaySize().width;
  return { width: Math.min(TOOLBAR.width, Math.max(190, w - 28)), height: TOOLBAR.height };
}

function clampBounds(b) {
  const { workArea } = screen.getPrimaryDisplay();
  b.x = Math.max(workArea.x, Math.min(b.x, workArea.x + workArea.width - b.width));
  b.y = Math.max(workArea.y, Math.min(b.y, workArea.y + workArea.height - b.height));
  return b;
}

// ---------- state ----------

let win;
let tray;
let interactive = false;
let listening = false;
let devices = [];
let activeTracks = { them: false, me: false };
const heard = []; // [{ speaker, text }]
let lastQuestion = null; // { text, speaker }
let answering = null;
let buttonWin;
let panelOpen = false;
let screenCapture = null;

function send(msg) {
  win?.webContents.send("overlay", msg);
}

// ---------- windows ----------

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const { width, height } = getOverlaySize();
  win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile("index.html");
  win.once("ready-to-show", () => {
    win.setContentProtection(true);
    win.showInactive();
  });
  win.on("show", () => {
    win.setContentProtection(true);
    placeButton(true);
    buttonWin?.showInactive();
    buttonWin?.setContentProtection(true);
    updateTray();
  });
  win.on("hide", () => {
    buttonWin?.hide();
    updateTray();
  });
  win.on("move", () => { if (!overlayDrag) placeButton(); });
  win.on("resize", placeButton);
}

function createButtonWindow() {
  buttonWin = new BrowserWindow({
    ...getToolbarSize(),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  buttonWin.setAlwaysOnTop(true, "screen-saver");
  buttonWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  buttonWin.setContentProtection(true);
  buttonWin.loadFile("button.html");
  buttonWin.webContents.once("did-finish-load", () => {
    buttonWin.webContents.send("overlay", { type: "listen", on: listening });
    placeButton(true);
    if (win.isVisible()) buttonWin.showInactive();
  });
}

// Dragging the overlay fires `move` continuously; re-positioning another window
// on every one of those events is what made the drag stutter. Coalesce them.
let placeQueued = false;

function placeButton(immediate) {
  if (!buttonWin || buttonWin.isDestroyed()) return;
  if (immediate) { placeQueued = false; doPlaceButton(); return; }
  if (placeQueued) return;
  placeQueued = true;
  setTimeout(() => { placeQueued = false; doPlaceButton(); }, 16);
}

function doPlaceButton() {
  if (!buttonWin || buttonWin.isDestroyed() || !win || win.isDestroyed()) return;
  const b = win.getBounds();
  const size = getToolbarSize();
  const next = clampBounds({
    ...size,
    x: Math.round(b.x + (b.width - size.width) / 2),
    y: b.y + b.height - size.height - TOOLBAR.gap,
  });
  const cur = buttonWin.getBounds();
  if (cur.x === next.x && cur.y === next.y && cur.width === next.width && cur.height === next.height) return;
  buttonWin.setBounds(next);
}

let savedBounds = null; // the user's own size, restored when the panel closes
let overlayDrag = null; // { x, y } cursor offset while the user is moving the overlay

function setInteractive(on) {
  interactive = on;
  win.setIgnoreMouseEvents(!on, on ? undefined : { forward: true });
  win.setFocusable(on);
  send({ type: "interactive", on });
  if (on) {
    // Without an explicit focus the settings fields can't receive keystrokes
    // on Windows, because the window is created non-focusable.
    win.focus();
  } else if (panelOpen) {
    panelOpen = false;
    if (savedBounds) {
      win.setBounds(clampBounds(savedBounds));
      savedBounds = null;
    }
    send({ type: "panel", on: false });
    buttonWin?.webContents.send("overlay", { type: "panel", on: false });
  }
  placeButton(true);
}

function togglePanel() {
  panelOpen = !panelOpen;
  const b = win.getBounds();
  if (panelOpen) {
    savedBounds = { ...b };
    const { heightPanel } = getOverlaySize();
    const newHeight = Math.max(heightPanel, b.height);
    const { workArea } = screen.getPrimaryDisplay();
    let y = b.y;
    if (y + newHeight > workArea.y + workArea.height) y = workArea.y + workArea.height - newHeight;
    win.setBounds(clampBounds({ x: b.x, y, width: Math.max(b.width, 520), height: newHeight }));
    setInteractive(true);
    send({ type: "panel", on: true });
  } else {
    win.setBounds(clampBounds(savedBounds || b));
    savedBounds = null;
    setInteractive(false);
    send({ type: "panel", on: false });
  }
  buttonWin?.webContents.send("overlay", { type: "panel", on: panelOpen });
  placeButton(true);
}

function toggleVisible() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
  updateTray();
}

// ---------- listening ----------

function listenPayload() {
  const s = getSettings();
  return {
    type: "listen",
    on: true,
    deviceId: s.micDeviceId || "default",
    audioSource: s.audioSource,
    sysDeviceId: s.sysDeviceId,
    echoCancel: s.echoCancel !== false,
    vadSensitivity: s.vadSensitivity ?? 3,
    phrasePauseMs: s.phrasePauseMs ?? 700,
  };
}

function setListening(on) {
  if (on && !openai) {
    send({ type: "error", text: "Set OPENAI_API_KEY in the .env file to use listen mode, then restart.", short: "No API key" });
    if (!win.isVisible()) win.showInactive();
    return;
  }
  listening = on;
  if (on && !win.isVisible()) win.showInactive();
  send(on ? listenPayload() : { type: "listen", on: false });
  buttonWin?.webContents.send("overlay", { type: "listen", on });
  updateTray();
}

function restartListening() {
  if (!listening) return;
  send({ type: "listen", on: false });
  send(listenPayload());
}

// ---------- transcription ----------
//
// One queue per speaker. The old single queue meant a slow request for one
// phrase stalled every later phrase behind it — including the interviewer's
// next question. Per-speaker queues keep each speaker's phrases in order while
// letting the two speakers transcribe concurrently.

const queues = { them: Promise.resolve(), me: Promise.resolve() };

ipcMain.on("audio", (_e, payload) => {
  if (!listening || !payload?.bytes) return;
  const speaker = payload.speaker === "me" ? "me" : "them";
  queues[speaker] = queues[speaker]
    .then(() => transcribe(payload.bytes, speaker))
    .catch(() => {});
});

function transcribeHint() {
  const s = getSettings();
  const bits = [s.jobRole, s.meetingPurpose].filter(Boolean);
  return bits.length ? bits.join(". ").slice(0, 200) : undefined;
}

async function transcribe(bytes, speaker) {
  let text;
  let hintEcho = null;
  try {
    const file = await toFile(Buffer.from(bytes), "phrase.webm", { type: "audio/webm" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const params = { file, model: getTranscribeModel(), temperature: 0 };
      const lang = getSettings().transcribeLanguage?.trim();
      if (lang) params.language = lang; // fixed language is faster than auto-detect
      const hint = transcribeHint();
      if (hint) {
        params.prompt = hint; // steers spelling of role-specific terms
        hintEcho = hint.toLowerCase();
      }
      ({ text } = await openai.audio.transcriptions.create(params, { signal: controller.signal }));
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // One dropped phrase on a slow connection shouldn't wipe the answer the
      // user is reading — but they do need to know a question went missing,
      // otherwise the overlay just looks frozen.
      send({ type: "notice", text: "Phrase timed out — press Ctrl+Shift+A to retry", ms: 4000 });
      return;
    }
    send({ type: "error", text: `Transcription failed: ${err.message}`, short: "Transcribe failed" });
    return;
  }

  text = text?.trim();
  if (!text || isJunk(text)) return;
  // On an ambiguous clip these models sometimes just echo the prompt back.
  if (hintEcho && text.toLowerCase() === hintEcho) return;

  heard.push({ speaker, text });
  if (heard.length > CONTEXT_LINES) heard.shift();
  send({ type: "heard", speaker, text });

  if (!isQuestion(text)) return;
  lastQuestion = { text, speaker };

  const s = getSettings();
  if (!shouldAnswer({
    speaker,
    autoAnswer: s.autoAnswer !== false,
    onlyInterviewer: s.answerOnlyInterviewer !== false,
    hasInterviewerTrack: activeTracks.them,
  })) return;

  requestAnswer(text, speaker);
}

// ---------- answering ----------

let answerCooldown = false;
let answerCooldownTimer = null;
let queuedQ = null;
let lastAsked = null; // { text, speaker, at } — what the current answer is for

// Answering starts the instant a question lands: no debounce, because a phrase
// is only closed after a ~700ms silence, so a real continuation always arrives
// later than any window short enough to be worth waiting for. Instead, when the
// second half of a split question shows up, the in-flight answer is aborted and
// restarted with both halves — fastest possible first token, self-correcting.
function requestAnswer(text, speaker) {
  let full = text;
  if (
    lastAsked &&
    lastAsked.speaker === speaker &&
    Date.now() - lastAsked.at < FOLLOWON_MS &&
    looksUnfinished(lastAsked.text)
  ) {
    full = `${lastAsked.text} ${text}`;
  }

  if (answerCooldown) {
    queuedQ = { text: full, speaker };
    send({ type: "cooldown", on: true });
    return;
  }
  answer(full, speaker);
}

function answerLast() {
  const q = lastQuestion || heard.filter((h) => h.speaker === "them").at(-1) || heard.at(-1);
  queuedQ = null;
  if (!q) return;
  clearTimeout(answerCooldownTimer);
  answerCooldown = false;
  answer(q.text, q.speaker || "them");
}

function transcriptText() {
  if (!heard.length) return "(nothing heard yet)";
  return heard.map((h) => `${h.speaker === "me" ? "You" : "Interviewer"}: ${h.text}`).join("\n");
}

function buildSystemPrompt() {
  const s = getSettings();
  let p =
    "You are a private, real-time answer assistant for the user, who is in a live meeting " +
    "right now. You receive an automatic speech transcript with two speakers:\n" +
    "- \"Interviewer\" is the other person. Their lines are what you must answer.\n" +
    "- \"You\" is the user themself. Their lines are background only — never answer them.\n\n" +
    "The transcript comes from speech recognition, so expect mis-heard words, missing " +
    "punctuation and clipped sentences; infer the intended question.\n\n" +
    "Write the answer so the user can read it aloud immediately: lead with the direct answer " +
    "in 1-3 short sentences, then at most 3 brief supporting points only if they add real " +
    "value. Speak in first person as the user. Plain text only — no markdown, no headings, " +
    "no preamble, and never mention the transcript or that you are an AI.";
  if (s.meetingPurpose) p += `\n\nMeeting purpose: ${s.meetingPurpose}`;
  if (s.jobRole) p += `\nThe user's target role: ${s.jobRole}`;
  if (s.jobDescription) p += `\nJob description:\n${s.jobDescription}`;
  if (s.resume) p += `\n\nThe user's résumé — ground every claim in it:\n${s.resume}`;
  return p;
}

async function answer(questionText, speaker = "them") {
  answering?.abort();
  clearTimeout(answerCooldownTimer);
  answerCooldown = true;
  lastAsked = { text: questionText, speaker, at: Date.now() };
  const controller = new AbortController();
  answering = controller;
  if (!win.isVisible()) win.showInactive();
  send({ type: "question", text: questionText, speaker });

  try {
    const userContent = [
      { type: "text", text: `<transcript>\n${transcriptText()}\n</transcript>\n\nAnswer this question from the ${speaker === "me" ? "user" : "interviewer"}: ${questionText}` },
    ];
    if (screenCapture) {
      userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${screenCapture.base64}`, detail: "low" } });
      userContent.push({ type: "text", text: "(The image above was shared on screen during the meeting. Use it as context.)" });
    }

    const stream = await openai.chat.completions.create(
      {
        model: getModel(),
        max_tokens: 900,
        stream: true,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userContent },
        ],
      },
      { signal: controller.signal },
    );
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) send({ type: "delta", text });
    }
    send({ type: "done" });
  } catch (err) {
    if (!controller.signal.aborted) send({ type: "error", text: `Answer failed: ${err.message}`, short: "Answer failed" });
  } finally {
    if (answering === controller) answering = null;
    const gapMs = Math.max(0, getSettings().answerCooldownSec ?? 1) * 1000;
    answerCooldownTimer = setTimeout(() => {
      answerCooldown = false;
      send({ type: "cooldown", on: false });
      const q = queuedQ;
      queuedQ = null;
      if (q && getSettings().autoAnswer) answer(q.text, q.speaker);
    }, gapMs);
  }
}

ipcMain.on("devices", (_e, list) => {
  devices = list;
  updateTray();
});

ipcMain.on("tracks", (_e, t) => {
  activeTracks = { them: !!t?.them, me: !!t?.me };
  updateTray();
});

function clearAll() {
  answering?.abort();
  clearTimeout(answerCooldownTimer);
  answerCooldown = false;
  queuedQ = null;
  lastAsked = null;
  heard.length = 0;
  lastQuestion = null;
  screenCapture = null;
  send({ type: "clear" });
}

// ---------- tray ----------

function updateTray() {
  if (!tray) return;
  tray.setImage(path.join(__dirname, "icons", listening ? "listening.png" : "idle.png"));
  const s = getSettings();
  const srcLabel = s.audioSource === "both" ? "interviewer + you" : s.audioSource === "system" ? "interviewer" : "mic";
  tray.setToolTip(listening ? `Listening (${srcLabel})` : "Meet Assistant");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: listening ? "Stop listening" : "Start listening", click: () => setListening(!listening) },
      { label: "Answer last question", click: answerLast },
      { label: "Clear session", click: clearAll },
      { type: "separator" },
      {
        label: "Audio source",
        submenu: [
          { value: "both", label: "Interviewer + you (recommended)" },
          { value: "system", label: "Interviewer only (system audio)" },
          { value: "mic", label: "Microphone only" },
        ].map((o) => ({
          label: o.label,
          type: "radio",
          checked: s.audioSource === o.value,
          click: () => {
            saveSettings({ audioSource: o.value });
            restartListening();
            updateTray();
          },
        })),
      },
      {
        label: "Microphone",
        submenu: [{ deviceId: "default", label: "Default microphone" }, ...devices].map((d) => ({
          label: d.label,
          type: "radio",
          checked: (s.micDeviceId || "default") === d.deviceId,
          click: () => {
            saveSettings({ micDeviceId: d.deviceId });
            restartListening();
            updateTray();
          },
        })),
      },
      { type: "separator" },
      { label: win.isVisible() ? "Hide overlay" : "Show overlay", click: toggleVisible },
      { label: "Move / resize overlay", click: () => setInteractive(true) },
      { label: "Setup & settings", click: togglePanel },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]),
  );
}

// ---------- ipc ----------

ipcMain.on("set-interactive", (_e, on) => setInteractive(on));

// -webkit-app-region: drag does not move transparent frameless windows on
// Linux (X11/Wayland). Track the cursor in the main process instead.
ipcMain.on("overlay-drag", (_e, phase) => {
  if (!win || win.isDestroyed()) return;
  if (phase === "start") {
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    overlayDrag = { x: cursor.x - b.x, y: cursor.y - b.y };
    return;
  }
  if (phase === "end") {
    overlayDrag = null;
    placeButton(true);
    return;
  }
  if (phase !== "move" || !overlayDrag) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const next = clampBounds({ ...b, x: cursor.x - overlayDrag.x, y: cursor.y - overlayDrag.y });
  if (next.x === b.x && next.y === b.y) return;
  win.setPosition(next.x, next.y);
  doPlaceButton();
});
ipcMain.on("clear", clearAll);
ipcMain.on("toggle-listening", () => setListening(!listening));
ipcMain.on("answer-now", answerLast);
ipcMain.on("toggle-panel", togglePanel);
ipcMain.on("close-panel", () => { if (panelOpen) togglePanel(); });
ipcMain.on("quit-app", () => app.quit());
ipcMain.handle("get-settings", () => getSettings());
ipcMain.handle("get-platform", () => process.platform);

// Changing any of these has to reach the capture pipeline, which only reads
// them when a listening session starts. Everything else applies live, so it
// must not cost the user a restart (and another calibration pause) mid-meeting.
const CAPTURE_KEYS = ["audioSource", "micDeviceId", "sysDeviceId", "echoCancel", "vadSensitivity", "phrasePauseMs"];

ipcMain.handle("save-settings", (_e, partial) => {
  const before = getSettings();
  const s = saveSettings(partial);
  if (CAPTURE_KEYS.some((k) => k in partial && before[k] !== s[k])) restartListening();
  updateTray();
  return s;
});

ipcMain.handle("get-desktop-source-id", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  return sources[0]?.id ?? null;
});

ipcMain.handle("capture-screen", async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } });
    if (!sources.length) return { success: false, error: "No screen source" };
    screenCapture = { base64: sources[0].thumbnail.toPNG().toString("base64"), timestamp: Date.now() };
    send({ type: "captured" });
    buttonWin?.webContents.send("overlay", { type: "captured" });
    clearTimeout(answerCooldownTimer);
    answerCooldown = false;
    answer(lastQuestion?.text || "What is shown on this screen? Summarise the key content or the question visible on it.", lastQuestion?.speaker || "them");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => win?.showInactive());

app.whenReady().then(() => {
  loadSettings();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "display-capture"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media" || permission === "display-capture");

  setTimeout(() => {
    createWindow();
    createButtonWindow();
    tray = new Tray(path.join(__dirname, "icons", "idle.png"));
    updateTray();

    win.webContents.once("did-finish-load", () => {
      const s = getSettings();
      send({ type: "opacity-set", value: s.opacity ?? 0.8 });
      send({ type: "settings", showTranscript: s.showTranscript !== false });
      if (!openai) {
        togglePanel();
        send({ type: "error", text: "Welcome. Paste your OpenAI API key into the .env file next to the app, then restart.", short: "No API key" });
      } else if (process.argv.includes("--listen")) {
        setListening(true);
      }
    });

    // Only keep the overlay on-screen after a resolution change; don't resize
    // away whatever size the user chose.
    screen.on("display-metrics-changed", () => {
      win.setBounds(clampBounds(win.getBounds()));
      placeButton(true);
    });

    globalShortcut.register("CommandOrControl+Shift+L", () => setListening(!listening));
    globalShortcut.register("CommandOrControl+Shift+A", answerLast);
    globalShortcut.register("CommandOrControl+Shift+Backspace", clearAll);
    globalShortcut.register("CommandOrControl+Shift+H", toggleVisible);
    globalShortcut.register("CommandOrControl+Shift+M", () => setInteractive(!interactive));
    globalShortcut.register("CommandOrControl+Shift+P", togglePanel);
    globalShortcut.register("CommandOrControl+Shift+T", () => {
      const on = !(getSettings().showTranscript !== false);
      saveSettings({ showTranscript: on });
      send({ type: "transcript", on });
    });
    globalShortcut.register("CommandOrControl+Shift+Up", () => send({ type: "scroll", by: -140 }));
    globalShortcut.register("CommandOrControl+Shift+Down", () => send({ type: "scroll", by: 140 }));
    globalShortcut.register("CommandOrControl+Shift+Left", () => send({ type: "opacity", by: -0.1 }));
    globalShortcut.register("CommandOrControl+Shift+Right", () => send({ type: "opacity", by: 0.1 }));
  }, process.platform === "linux" ? 300 : 0);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
