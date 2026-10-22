// Drives the real overlay renderer through a live meeting's worth of messages
// and asserts what ends up on screen.
//   npx electron uitest.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

let pass = 0;
const fails = [];
const consoleErrors = [];

function check(name, cond, detail) {
  if (cond) pass++;
  else fails.push(`${name}${detail ? `\n      ${detail}` : ""}`);
}

app.whenReady().then(async () => {
  ipcMain.handle("get-settings", () => ({
    audioSource: "both", micDeviceId: "default", sysDeviceId: "", echoCancel: true,
    vadSensitivity: 4, phrasePauseMs: 600, model: "gpt-4o-mini", transcribeModel: "",
    transcribeLanguage: "en", autoAnswer: true, answerOnlyInterviewer: true,
    answerCooldownSec: 2, opacity: 0.65, showTranscript: true,
    meetingPurpose: "Backend interview", jobRole: "Senior Backend Engineer",
    jobDescription: "Go, Postgres, k8s", resume: "8 years backend.",
  }));
  ipcMain.handle("get-platform", () => "win32");
  ipcMain.handle("get-desktop-source-id", () => null);
  ipcMain.handle("save-settings", (_e, p) => p);
  ipcMain.handle("capture-screen", () => ({ success: false }));

  const win = new BrowserWindow({
    width: 900, height: 420, x: 40, y: 40,
    frame: false, transparent: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  win.webContents.on("console-message", (...a) => {
    const e = a[0];
    const level = typeof e === "object" && e && "level" in e ? e.level : a[1];
    const msg = typeof e === "object" && e && "message" in e ? e.message : a[2];
    if (level === "error" || level === 3) consoleErrors.push(String(msg));
  });

  await win.loadFile("index.html");
  win.showInactive(); // rAF is paused in a hidden window; the delta flush needs it
  await new Promise((r) => setTimeout(r, 700));

  const send = (msg) => win.webContents.send("overlay", msg);
  const js = (code) => win.webContents.executeJavaScript(code);
  // two frames, so a requestAnimationFrame flush has definitely landed
  const settle = () => js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))) ");

  const snap = () => js(`({
    empty: panel.classList.contains("empty"),
    interactive: panel.classList.contains("interactive"),
    panelOpen: panel.classList.contains("panel-open"),
    stateClass: [...panel.classList].filter(c => c.startsWith("s-")),
    state: document.getElementById("state").textContent,
    question: document.getElementById("question").textContent,
    qwho: document.getElementById("qwho").textContent,
    qwhoClass: document.getElementById("qwho").className,
    answer: document.getElementById("answer").textContent,
    answerErr: document.getElementById("answer").classList.contains("error"),
    streaming: document.getElementById("answer").classList.contains("streaming"),
    tlines: [...document.querySelectorAll(".tline")].map(e => e.className + "|" + e.textContent),
    tboxHidden: document.getElementById("tbox").hidden,
    alpha: panel.style.getPropertyValue("--alpha"),
    barActionsVisible: getComputedStyle(document.getElementById("bar-actions")).display !== "none",
    settingsVisible: !document.getElementById("panel-area").hidden,
    qrowVisible: getComputedStyle(document.getElementById("qrow")).display !== "none",
    hintsVisible: getComputedStyle(document.getElementById("hints")).display !== "none",
  })`);

  // ---------- opening state ----------
  let s = await snap();
  check("starts empty with the shortcut hints showing", s.empty && s.hintsVisible && !s.qrowVisible, JSON.stringify(s));
  check("idle status reads 'Idle'", s.state === "Idle", s.state);

  // ---------- opacity ----------
  send({ type: "opacity-set", value: 0.65 });
  await settle();
  s = await snap();
  check("opacity applies", s.alpha === "0.65", `alpha=${s.alpha}`);
  send({ type: "opacity", by: 0.1 });
  await settle();
  s = await snap();
  check("opacity nudges up", Math.abs(parseFloat(s.alpha) - 0.75) < 1e-6, `alpha=${s.alpha}`);

  // ---------- the interviewer speaks ----------
  send({ type: "heard", speaker: "them", text: "So tell me about a time you had to debug something under pressure." });
  send({ type: "heard", speaker: "me", text: "Sure, happy to walk you through one." });
  await settle();
  s = await snap();
  check("both speakers appear in the transcript", s.tlines.length === 2, JSON.stringify(s.tlines));
  check("the interviewer's line is tagged 'them'", /tline\|them/.test(s.tlines[0]), s.tlines[0]);
  check("your own line is tagged 'you' and styled differently", /tline me\|you/.test(s.tlines[1]), s.tlines[1]);

  // ---------- a question arrives ----------
  send({ type: "question", speaker: "them", text: "How would you scale this to a million users?" });
  await settle();
  s = await snap();
  check("leaves the empty state once a question lands", !s.empty && s.qrowVisible && !s.hintsVisible);
  check("question text shows", s.question.includes("million users"), s.question);
  check("question is attributed to the interviewer", s.qwho === "interviewer" && s.qwhoClass === "chip them", `${s.qwho} / ${s.qwhoClass}`);
  check("status switches to Answering", s.state === "Answering…" && s.stateClass.includes("s-thinking"), `${s.state} ${s.stateClass}`);
  check("streaming caret is on", s.streaming);

  // ---------- tokens stream in ----------
  for (const t of ["I'd shard ", "by tenant ", "and put ", "Redis in front."]) send({ type: "delta", text: t });
  await settle();
  s = await snap();
  check("streamed tokens are concatenated in order",
    s.answer === "I'd shard by tenant and put Redis in front.", JSON.stringify(s.answer));

  send({ type: "done" });
  await settle();
  s = await snap();
  check("caret clears when the answer finishes", !s.streaming);
  check("status returns to Idle after answering", s.state === "Idle", s.state);

  // ---------- a second question replaces the first ----------
  send({ type: "question", speaker: "them", text: "And how would you test it?" });
  send({ type: "delta", text: "Contract tests first." });
  await settle();
  s = await snap();
  check("a new question resets the answer body rather than appending",
    s.answer === "Contract tests first.", JSON.stringify(s.answer));

  // ---------- your own question, shown but attributed to you ----------
  send({ type: "question", speaker: "me", text: "Did I cover that properly?" });
  await settle();
  s = await snap();
  check("your own question is labelled 'you'", s.qwho === "you" && s.qwhoClass === "chip me", `${s.qwho} / ${s.qwhoClass}`);

  // ---------- error handling ----------
  send({ type: "error", text: "Answer failed: network unreachable", short: "Answer failed" });
  await settle();
  s = await snap();
  check("errors render in the answer area", s.answerErr && s.answer.includes("network unreachable"), s.answer);
  check("errors surface in the status line", s.state === "Answer failed" && s.stateClass.includes("s-error"), `${s.state} ${s.stateClass}`);

  // ---------- a transient notice must not destroy the answer on screen ----------
  send({ type: "question", speaker: "them", text: "What about caching?" });
  send({ type: "delta", text: "Cache at the edge." });
  send({ type: "done" });
  await settle();
  send({ type: "notice", text: "Phrase timed out — press Ctrl+Shift+A to retry", ms: 600 });
  await settle();
  s = await snap();
  check("a notice shows in the status line", s.state.includes("Phrase timed out"), s.state);
  check("a notice leaves the answer intact", s.answer === "Cache at the edge." && !s.answerErr, JSON.stringify(s.answer));
  await new Promise((r) => setTimeout(r, 900));
  s = await snap();
  check("a notice clears itself", !s.state.includes("Phrase timed out"), s.state);

  // ---------- cooldown / queued ----------
  send({ type: "clear" });
  send({ type: "cooldown", on: true });
  await settle();
  s = await snap();
  check("clear empties everything", s.empty && s.answer === "" && s.tlines.length === 0, JSON.stringify(s));

  // ---------- interactive mode ----------
  send({ type: "interactive", on: true });
  await settle();
  s = await snap();
  check("interactive mode reveals Clear/Done", s.interactive && s.barActionsVisible);

  // ---------- settings panel round-trip ----------
  send({ type: "panel", on: true });
  await new Promise((r) => setTimeout(r, 400));
  s = await snap();
  check("settings panel opens and hides the stage", s.settingsVisible && s.panelOpen);

  const loaded = await js(`({
    purpose: document.getElementById("set-meeting-purpose").value,
    role: document.getElementById("set-job-role").value,
    source: document.getElementById("set-audio-source").value,
    sens: document.getElementById("set-sensitivity").value,
    sensLabel: document.getElementById("sensitivity-val").textContent,
    pause: document.getElementById("set-pause").value,
    pauseLabel: document.getElementById("pause-val").textContent,
    cooldownLabel: document.getElementById("cooldown-val").textContent,
    opacityLabel: document.getElementById("opacity-val").textContent,
    onlyInterviewer: document.getElementById("set-only-interviewer").checked,
    echo: document.getElementById("set-echo-cancel").checked,
    lang: document.getElementById("set-language").value,
    sysHidden: document.getElementById("sys-device-label").hidden,
    activeTab: document.querySelector(".tab-btn.active").dataset.tab,
  })`);
  check("saved context is populated", loaded.purpose === "Backend interview" && loaded.role === "Senior Backend Engineer", JSON.stringify(loaded));
  check("audio settings are populated", loaded.source === "both" && loaded.sens === "4" && loaded.pause === "600", JSON.stringify(loaded));
  check("slider labels are humanised", loaded.sensLabel === "4 · high" && loaded.pauseLabel === "600ms" && loaded.cooldownLabel === "2s" && loaded.opacityLabel === "65%", JSON.stringify(loaded));
  check("behaviour toggles are populated", loaded.onlyInterviewer === true && loaded.echo === true && loaded.lang === "en");
  check("system-device picker is hidden on Windows", loaded.sysHidden === true);
  check("opens on the Context tab", loaded.activeTab === "context");

  // tab switching
  await js(`document.querySelector('.tab-btn[data-tab="audio"]').click()`);
  await settle();
  const tabbed = await js(`({
    active: document.querySelector(".tab-btn.active").dataset.tab,
    pane: document.querySelector(".tab-content.active").dataset.tab,
  })`);
  check("tabs switch panes", tabbed.active === "audio" && tabbed.pane === "audio", JSON.stringify(tabbed));

  // switching to mic-only should hide the interviewer-audio fields
  await js(`(() => { const s = document.getElementById("set-audio-source"); s.value = "mic"; s.dispatchEvent(new Event("change")); })()`);
  await settle();
  const micOnly = await js(`({
    sys: document.getElementById("sys-device-label").hidden,
    mic: document.getElementById("set-mic-device").closest("label").hidden,
  })`);
  check("mic-only hides the system-audio picker and keeps the mic picker", micOnly.sys === true && micOnly.mic === false, JSON.stringify(micOnly));

  // ---------- responsive ----------
  for (const [w, h, cls] of [[900, 420, "wide"], [560, 240, "compact"], [400, 190, "tiny"]]) {
    win.setBounds({ x: 40, y: 40, width: w, height: h });
    await new Promise((r) => setTimeout(r, 350));
    const body = await js(`({ c: document.body.className, w: innerWidth, h: innerHeight })`);
    if (cls === "wide") check("wide overlay uses the full layout", body.c === "", `"${body.c}" at ${body.w}x${body.h}`);
    if (cls === "compact") check("medium overlay switches to compact", body.c.includes("compact"), `"${body.c}" at ${body.w}x${body.h}`);
    if (cls === "tiny") check("small overlay switches to tiny", body.c.includes("tiny"), `"${body.c}" at ${body.w}x${body.h}`);
  }

  // ---------- transcript toggle ----------
  win.setBounds({ x: 40, y: 40, width: 900, height: 420 });
  send({ type: "transcript", on: false });
  await settle();
  s = await snap();
  check("transcript strip can be hidden", s.tboxHidden === true);

  check("no renderer console errors", consoleErrors.length === 0, consoleErrors.join("\n      "));

  console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
  for (const f of fails) console.log(`  ✗ ${f}\n`);
  app.exit(fails.length ? 1 : 0);
});
