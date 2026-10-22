const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  // audio capture
  audioSource: "both",
  micDeviceId: "default",
  sysDeviceId: "",
  echoCancel: true,
  vadSensitivity: 3, // 1 = least sensitive … 5 = most sensitive
  phrasePauseMs: 700, // silence that ends a phrase

  // models
  model: "",
  transcribeModel: "",
  transcribeLanguage: "en",

  // behaviour
  autoAnswer: true,
  answerOnlyInterviewer: true,
  answerCooldownSec: 1,

  // appearance
  opacity: 0.8,
  showTranscript: true,

  // context
  meetingPurpose: "",
  jobRole: "",
  jobDescription: "",
  resume: "",
};

let settings = { ...DEFAULTS };
const file = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), "utf8"));
    settings = { ...DEFAULTS, ...data };
  } catch {
    settings = { ...DEFAULTS };
  }
  return settings;
}

function saveSettings(partial) {
  Object.assign(settings, partial);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(settings, null, 2));
  return settings;
}

function getSettings() {
  return { ...settings };
}

module.exports = { loadSettings, saveSettings, getSettings, DEFAULTS };
