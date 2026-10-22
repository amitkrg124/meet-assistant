// src/background.js
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.commands.onCommand.addListener((command) => {
  chrome.runtime.sendMessage({ type: "command", command }).catch(() => {
  });
});
