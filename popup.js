const status = document.getElementById("status");
const groqKeysEl = document.getElementById("groqKeys");
const geminiKeysEl = document.getElementById("geminiKeys");

function setStatus(msg, type = "") {
  status.textContent = msg;
  status.className = "status " + type;
}

function normalizeKeyLines(text) {
  return String(text || "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatKeyLines(keys) {
  return Array.isArray(keys) ? keys.join("\n") : "";
}

function readStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

function writeStorage(payload) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function loadKeysIntoForm() {
  try {
    const saved = await readStorage(["groqApiKeys", "geminiApiKeys", "groqApiKey", "geminiApiKey"]);
    const groqKeys = saved.groqApiKeys || saved.groqApiKey || [];
    const geminiKeys = saved.geminiApiKeys || saved.geminiApiKey || [];

    groqKeysEl.value = formatKeyLines(Array.isArray(groqKeys) ? groqKeys : normalizeKeyLines(groqKeys));
    geminiKeysEl.value = formatKeyLines(Array.isArray(geminiKeys) ? geminiKeys : normalizeKeyLines(geminiKeys));
  } catch {
    setStatus("Could not load saved keys", "error");
  }
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

document.getElementById("saveKeysBtn").addEventListener("click", async () => {
  const groqApiKeys = normalizeKeyLines(groqKeysEl.value);
  const geminiApiKeys = normalizeKeyLines(geminiKeysEl.value);

  try {
    await writeStorage({ groqApiKeys, geminiApiKeys });
    setStatus("✅ API keys saved locally", "success");
  } catch (error) {
    setStatus("❌ Failed to save keys", "error");
  }
});

loadKeysIntoForm();
