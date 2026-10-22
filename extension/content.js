// src/content.js
if (window.__meetAssistant) throw new Error("already running");
window.__meetAssistant = true;
var POLL_MS = 500;
var STABLE_MS = 1200;
var lastSeen = "";
var lastChange = 0;
var emitted = "";
var lastStatus = null;
var CAPTION_SELECTORS = [
  '[role="region"][aria-label*="caption" i]',
  '[aria-live][aria-label*="caption" i]',
  '[role="region"][aria-label*="subtitle" i]',
  'div[jsname="dsyhDe"]',
  "div.a4cQT",
  "div.iOzk7"
];
function findCaptionRegion() {
  for (const sel of CAPTION_SELECTORS) {
    const el = document.querySelector(sel);
    if (el?.innerText.trim() || el?.childElementCount) return el;
  }
  return null;
}
function clean(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
}
function newTextSince(prev, curr) {
  if (!prev) return curr;
  if (curr.startsWith(prev)) return curr.slice(prev.length);
  for (let n = Math.min(60, prev.length); n >= 12; n -= 4) {
    const i = curr.lastIndexOf(prev.slice(-n));
    if (i !== -1) return curr.slice(i + n);
  }
  return curr;
}
function send(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
    });
  } catch {
    clearInterval(timer);
  }
}
function tick() {
  const region = findCaptionRegion();
  const captionsOn = Boolean(region);
  if (captionsOn !== lastStatus) {
    lastStatus = captionsOn;
    send({ type: "status", captionsOn });
  }
  const text = region ? clean(region.innerText) : "";
  const now = Date.now();
  if (text !== lastSeen) {
    lastSeen = text;
    lastChange = now;
    send({ type: "partial", text: newTextSince(emitted, text).trim() });
    return;
  }
  if (text && text !== emitted && now - lastChange >= STABLE_MS) {
    const chunk = newTextSince(emitted, text).trim();
    emitted = text;
    if (chunk) send({ type: "utterance", text: chunk, at: now });
  }
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "ping") reply({ captionsOn: Boolean(findCaptionRegion()) });
});
var timer = setInterval(tick, POLL_MS);
