const status = document.getElementById("status");

function setStatus(msg, type = "") {
  status.textContent = msg;
  status.className = "status " + type;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("readBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  setStatus("Reading...");
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { action: "readPage" });
    setStatus("✅ Page text read successfully", "success");
  } catch (e) {
    setStatus("❌ Refresh page and try again", "error");
  }
});

document.getElementById("toggleBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { action: "togglePanel" });
    setStatus(r?.visible ? "✅ Panel shown" : "✅ Panel hidden", "success");
  } catch (e) {
    setStatus("❌ Refresh page and try again", "error");
  }
});
