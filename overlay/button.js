const listen = document.getElementById("listen");
const answerNow = document.getElementById("answer-now");
const capture = document.getElementById("capture");
const panelToggle = document.getElementById("panel-toggle");
const grip = document.getElementById("grip");

function attachDrag(el) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    window.overlay.startDrag();
    const move = () => window.overlay.dragMove();
    const up = () => {
      window.overlay.endDrag();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}
attachDrag(grip);

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
document.getElementById("quit").addEventListener("click", () => window.overlay.quit());

window.overlay.onMessage((msg) => {
  if (msg.type === "listen") {
    listen.textContent = msg.on ? "Stop" : "Start";
    listen.classList.toggle("on", msg.on);
  }
  if (msg.type === "captured") flash(capture);
  if (msg.type === "panel") panelToggle.classList.toggle("active", msg.on);
});
