// src/permission.js
var status = document.getElementById("status");
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  status.textContent = "Microphone allowed. This tab will close.";
  await chrome.runtime.sendMessage({ type: "mic-granted" }).catch(() => {
  });
  const tab = await chrome.tabs.getCurrent();
  setTimeout(() => chrome.tabs.remove(tab.id), 1200);
} catch (err) {
  status.className = "error";
  status.textContent = err.name === "NotAllowedError" ? "Microphone was blocked. Click the icon at the right end of the address bar, allow the microphone, then reload this tab." : `Couldn't open the microphone: ${err.message}`;
}
