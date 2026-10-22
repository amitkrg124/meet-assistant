const listen = document.getElementById("listen");
const answerNow = document.getElementById("answer-now");
const capture = document.getElementById("capture");
const panelToggle = document.getElementById("panel-toggle");

function flash(el) {
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 550);
}

listen.addEventListener("click", () => window.overlay.toggleListening());

answerNow.addEventListener("click", () => {
  window.overlay.answerNow();
  flash(answerNow);
});

capture.addEventListener("click", async () => {
  const res = await window.overlay.captureScreen();
  if (res?.success) flash(capture);
});

panelToggle.addEventListener("click", () => window.overlay.togglePanel());

window.overlay.onMessage((msg) => {
  if (msg.type === "listen") {
    listen.textContent = msg.on ? "Stop" : "Start";
    listen.classList.toggle("on", msg.on);
  }
  if (msg.type === "captured") flash(capture);
  if (msg.type === "panel") panelToggle.classList.toggle("active", msg.on);
});
