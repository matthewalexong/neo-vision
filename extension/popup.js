const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const wsUrlInput = document.getElementById("wsUrl");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");

function updateUI(status) {
  if (status.connected) {
    statusDot.className = "dot on";
    statusText.textContent = `Connected (Tab: ${status.managedTabId || "none"})`;
  } else {
    statusDot.className = "dot off";
    statusText.textContent = "Disconnected";
  }
}

// Get current status
chrome.runtime.sendMessage({ type: "status" }, (resp) => {
  if (resp) updateUI(resp);
});

connectBtn.addEventListener("click", () => {
  const wsUrl = wsUrlInput.value.trim() || "ws://localhost:7665";
  chrome.runtime.sendMessage({ type: "connect", wsUrl }, (resp) => {
    statusText.textContent = "Connecting...";
    // Recheck after a moment
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "status" }, updateUI);
    }, 2000);
  });
});

disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" }, (resp) => {
    updateUI({ connected: false });
  });
});
