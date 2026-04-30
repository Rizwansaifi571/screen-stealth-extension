// Screen Reader Extension - Stealth Mode
(function () {
  if (window.__screenReaderExtensionLoaded) return;
  window.__screenReaderExtensionLoaded = true;

  const GROQ_API_KEYS = [
    
    // Add more keys below. Empty strings are ignored.
    // "gsk_your_second_key_here",
    // "gsk_your_third_key_here",
  ].filter(Boolean);
  let activeGroqKeyIndex = 0;
  const UI_STATE_KEY = "__sr_widget_ui_state_v1";
  const TOGGLE_HOTKEY_KEY = "H";

  // ── Persistent state — survives minimize/expand cycles ──
  const STATE = {
    answerText: "",
    answerClass: "sr-answer",
    isLoading: false,
    tabPosition: null,
    panelPosition: null,
    isWidgetHidden: false,
  };

  function loadUiState() {
    try {
      const raw = localStorage.getItem(UI_STATE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);

      if (saved?.tabPosition && Number.isFinite(saved.tabPosition.left) && Number.isFinite(saved.tabPosition.top)) {
        STATE.tabPosition = { left: saved.tabPosition.left, top: saved.tabPosition.top };
      }
      if (saved?.panelPosition && Number.isFinite(saved.panelPosition.left) && Number.isFinite(saved.panelPosition.top)) {
        STATE.panelPosition = { left: saved.panelPosition.left, top: saved.panelPosition.top };
      }
      STATE.isWidgetHidden = Boolean(saved?.isWidgetHidden);
    } catch {
      // Ignore malformed persisted state
    }
  }

  function persistUiState() {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify({
        tabPosition: STATE.tabPosition,
        panelPosition: STATE.panelPosition,
        isWidgetHidden: STATE.isWidgetHidden,
      }));
    } catch {
      // Ignore storage write failures
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function applyFixedPosition(el, position, fallbackLeft, fallbackTop) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);

    const desiredLeft = Number.isFinite(position?.left) ? position.left : fallbackLeft;
    const desiredTop = Number.isFinite(position?.top) ? position.top : fallbackTop;

    el.style.position = "fixed";
    el.style.left = `${clamp(desiredLeft, 0, maxLeft)}px`;
    el.style.top = `${clamp(desiredTop, 0, maxTop)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = "none";
  }

  function makeDraggable(handleEl, targetEl, onDragEnd, onClickIfNotDragged) {
    if (!handleEl || !targetEl) return;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;
    let moved = false;

    const onMove = (e) => {
      if (!dragging) return;
      const rect = targetEl.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const nextLeft = clamp(startLeft + (e.clientX - startX), 0, maxLeft);
      const nextTop = clamp(startTop + (e.clientY - startY), 0, maxTop);

      if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) {
        moved = true;
      }

      targetEl.style.left = `${nextLeft}px`;
      targetEl.style.top = `${nextTop}px`;
      targetEl.style.right = "auto";
      targetEl.style.bottom = "auto";
      targetEl.style.transform = "none";
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (moved) {
        onDragEnd?.({
          left: parseFloat(targetEl.style.left) || 0,
          top: parseFloat(targetEl.style.top) || 0,
        });
      } else {
        onClickIfNotDragged?.();
      }
    };

    handleEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const rect = targetEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      dragging = true;
      moved = false;

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function setWidgetHidden(hidden) {
    STATE.isWidgetHidden = hidden;
    const tab = document.getElementById("__sr-tab");
    const panel = document.getElementById("__sr-panel");

    if (hidden) {
      if (panel) {
        document.removeEventListener("click", outsideClickHandler);
        panel.remove();
      }
      if (tab) tab.style.display = "none";
    } else if (tab) {
      tab.style.display = "block";
    }

    persistUiState();
  }

  function detectCodeLanguage(text) {
    const value = String(text || "").trim();
    if (!value) return null;

    const fenced = value.match(/```\s*([a-zA-Z0-9#+._-]+)?\s*\n[\s\S]*?```/);
    if (fenced?.[1]) {
      const lang = fenced[1].toLowerCase();
      if (["c++", "cpp", "cc", "cxx"].includes(lang)) return "cpp";
      if (["js", "javascript", "node"].includes(lang)) return "javascript";
      if (["py", "python"].includes(lang)) return "python";
      if (["java"].includes(lang)) return "java";
      if (["sql", "postgres", "mysql", "sqlite"].includes(lang)) return "sql";
      return lang;
    }

    if (/(#include\s*<|\bstd::|\bint\s+main\s*\(|\bcout\s*<<|\bcin\s*>>|\busing\s+namespace\s+std\b|\bvector\s*<|\bclass\s+Solution\b|\bpublic:\b|\bprivate:\b|\bListNode\b|\bTreeNode\b)/.test(value)) {
      return "cpp";
    }
    if (/(\bpublic\s+class\b|\bSystem\.out\.print|\bpublic\s+static\s+void\s+main\s*\(|\bArrayList\s*<|\bHashMap\s*<)/.test(value)) {
      return "java";
    }
    if (/(^\s*def\s+\w+\s*\(|^\s*class\s+\w+\s*:\s*$|\bimport\s+\w+|\bprint\s*\()/m.test(value)) {
      return "python";
    }
    if (/(\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=|\blet\s+\w+\s*=|=>|\bconsole\.log\s*\()/.test(value)) {
      return "javascript";
    }
    if (/(\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b[\s\S]*\bSET\b|\bDELETE\s+FROM\b|\bCREATE\s+TABLE\b)/i.test(value)) {
      return "sql";
    }

    if (/```\s*[\s\S]*?```/.test(value)) return "code";
    return null;
  }

  function extractCodeForCopy(text) {
    const value = String(text || "");
    const fencedWithLang = value.match(/```\s*([a-zA-Z0-9#+._-]+)?\s*\n([\s\S]*?)```/);
    if (fencedWithLang?.[2]) return fencedWithLang[2].trim();

    const fenced = value.match(/```\s*\n?([\s\S]*?)```/);
    if (fenced?.[1]) return fenced[1].trim();

    return value.trim();
  }

  function classifyGroqError(status, message) {
    const text = String(message || "").toLowerCase();
    const isRateOrQuota = status === 429 || text.includes("rate") || text.includes("quota") || text.includes("limit") || text.includes("too many requests");
    const isInvalidKey = (status === 401 || status === 403) && (text.includes("key") || text.includes("auth") || text.includes("unauthorized") || text.includes("forbidden") || text.includes("invalid"));
    const isBadRequestOrModel = status === 400 || text.includes("model") || text.includes("invalid_request_error") || text.includes("malformed");
    return { isRateOrQuota, isInvalidKey, isBadRequestOrModel };
  }

  function getBodyText() {
    return (document.body?.innerText || "").trim();
  }

  function logBodyText() {
    const text = getBodyText();
    return text;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  function updateCopyButton(panel, answerText, answerClass) {
    if (!panel) return;
    const copyBtn = panel.querySelector("#sr-copy-btn");
    if (!copyBtn) return;

    const language = detectCodeLanguage(answerText);
    const canShow = answerClass === "sr-answer" && Boolean(language);
    if (!canShow) {
      copyBtn.style.display = "none";
      copyBtn.dataset.copyText = "";
      copyBtn.dataset.copyLang = "";
      copyBtn.textContent = "copy";
      return;
    }

    copyBtn.style.display = "inline-block";
    copyBtn.dataset.copyText = extractCodeForCopy(answerText);
    copyBtn.dataset.copyLang = language;
  }

  async function requestGroqWithKeyRotation(bodyText) {
    if (!GROQ_API_KEYS.length) {
      throw new Error("No GROQ API keys configured.");
    }

    if (activeGroqKeyIndex >= GROQ_API_KEYS.length) {
      activeGroqKeyIndex = 0;
    }

    let lastError = null;

    for (let attempt = 0; attempt < GROQ_API_KEYS.length; attempt += 1) {
      const keyIndex = (activeGroqKeyIndex + attempt) % GROQ_API_KEYS.length;
      const apiKey = GROQ_API_KEYS[keyIndex];

      let res;
      try {
        res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            // Using a powerful reasoning model on Groq for better MCQ accuracy
            //model: "llama-3.3-70b-versatile", // max 55 req/day
            model: "meta-llama/llama-4-scout-17b-16e-instruct",  // max = 277 req/day because of token size
            messages: [
              {
                role: "system",
                content: "You are an expert test-taker and problem solver. Your task is to find the main question in the text and output ONLY the correct answer. If it's a Multiple Choice Question (MCQ), strictly evaluate the choices and output ONLY the correct option text or letter. If it's a coding question, output ONLY the raw code. Provide NO reasoning, NO greetings, NO conversational text, and NO markdown blocks."
              },
              {
                role: "user",
                content: `Here is the extracted text from a webpage:\n\n${bodyText}\n\nPlease identify the main question and provide the final answer strictly following the system instructions.`
              }
            ],
            max_tokens: 1000,
            temperature: 0.3
          })
        });
      } catch (error) {
        throw new Error(`Network error while contacting Groq: ${error?.message || "Request failed"}`);
      }

      if (res.ok) {
        activeGroqKeyIndex = keyIndex;
        return res.json();
      }

      const err = await res.json().catch(() => ({}));
      const message = err?.error?.message || `API error ${res.status}`;
      const kind = classifyGroqError(res.status, message);

      if (kind.isRateOrQuota || kind.isInvalidKey) {
        lastError = new Error(`Key ${keyIndex + 1} failed: ${message}`);
        if (attempt < GROQ_API_KEYS.length - 1) {
          activeGroqKeyIndex = (keyIndex + 1) % GROQ_API_KEYS.length;
          continue;
        }
        throw new Error(`All configured keys are exhausted or invalid. Last error: ${message}`);
      }

      if (kind.isBadRequestOrModel) {
        throw new Error(`Request configuration error (no key switch): ${message}`);
      }

      throw new Error(`Groq request failed on key ${keyIndex + 1}: ${message}`);
    }

    throw new Error(lastError?.message || "All configured Groq keys failed.");
  }

  loadUiState();
  logBodyText();

  // ── Minimise helper (shared by button + outside click) ──
  function minimisePanel() {
    const panel = document.getElementById("__sr-panel");
    const tab   = document.getElementById("__sr-tab");
    if (!panel) return;

    panel.style.opacity   = "0";
    panel.style.transform = "translateX(110%)";
    setTimeout(() => {
      panel.remove();
      if (tab && !STATE.isWidgetHidden) tab.style.display = "block";
    }, 300);
  }

  // ── Inject stealth tab ───────────────────────────────────
  function injectTab() {
    if (document.getElementById("__sr-tab")) return;
    const tab = document.createElement("div");
    tab.id = "__sr-tab";
    tab.textContent = "ask";
    document.body.appendChild(tab);

    const fallbackLeft = Math.max(0, window.innerWidth - tab.getBoundingClientRect().width);
    const fallbackTop = Math.max(0, (window.innerHeight / 2) - 24);
    applyFixedPosition(tab, STATE.tabPosition, fallbackLeft, fallbackTop);

    makeDraggable(tab, tab, (pos) => {
      STATE.tabPosition = pos;
      persistUiState();
    }, () => {
      expandPanel();
    });

    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      setWidgetHidden(true);
    });

    if (STATE.isWidgetHidden) {
      tab.style.display = "none";
    }
  }

  // ── Expand panel, restore previous answer ───────────────
  function expandPanel() {
    const tab = document.getElementById("__sr-tab");
    if (document.getElementById("__sr-panel")) return;

    if (tab) tab.style.display = "none";

    const panel = document.createElement("div");
    panel.id = "__sr-panel";
    panel.innerHTML = `
      <div class="sr-drag-handle" title="Drag">ask assistant</div>
      <button class="sr-minimize" id="sr-minimize" title="Minimize">−</button>
      <div class="sr-body">
        <div class="sr-answer ${STATE.answerClass}" id="sr-answer"></div>
      </div>
      <div class="sr-footer">
        <button class="sr-copy-btn" id="sr-copy-btn" style="display:none;">copy</button>
        <button class="sr-ask-btn" id="sr-ask-btn">ask</button>
      </div>
    `;
    document.body.appendChild(panel);

    const fallbackLeft = Math.max(0, window.innerWidth - panel.getBoundingClientRect().width - 8);
    const fallbackTop = Math.max(0, (window.innerHeight / 2) - (panel.getBoundingClientRect().height / 2));
    applyFixedPosition(panel, STATE.panelPosition, fallbackLeft, fallbackTop);

    makeDraggable(panel.querySelector(".sr-drag-handle"), panel, (pos) => {
      STATE.panelPosition = pos;
      persistUiState();
    });

    // Restore previous answer text
    const answerEl = panel.querySelector("#sr-answer");
    if (STATE.answerText) answerEl.textContent = STATE.answerText;
    updateCopyButton(panel, STATE.answerText, STATE.answerClass);

    // If we were mid-loading when minimised, restore loading state
    if (STATE.isLoading) {
      answerEl.className = "sr-answer sr-loading";
      panel.querySelector("#sr-ask-btn").disabled = true;
      panel.querySelector("#sr-ask-btn").textContent = "...";
      updateCopyButton(panel, "", "sr-answer sr-loading");
    }

    // Minimize button
    panel.querySelector("#sr-minimize").addEventListener("click", (e) => {
      e.stopPropagation();
      minimisePanel();
    });

    panel.querySelector("#sr-copy-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const copyBtn = panel.querySelector("#sr-copy-btn");
      const textToCopy = copyBtn?.dataset?.copyText || "";
      if (!textToCopy) return;

      try {
        await copyTextToClipboard(textToCopy);
        copyBtn.textContent = "copied";
        setTimeout(() => {
          const liveCopyBtn = document.getElementById("sr-copy-btn");
          if (liveCopyBtn) liveCopyBtn.textContent = "copy";
        }, 900);
      } catch {
        copyBtn.textContent = "fail";
        setTimeout(() => {
          const liveCopyBtn = document.getElementById("sr-copy-btn");
          if (liveCopyBtn) liveCopyBtn.textContent = "copy";
        }, 900);
      }
    });

    // Outside-click listener — added with a tiny delay so the
    // "expand" click itself doesn't immediately re-trigger it
    setTimeout(() => {
      document.addEventListener("click", outsideClickHandler);
    }, 50);

    // Ask button
    panel.querySelector("#sr-ask-btn").addEventListener("click", async (e) => {
      e.stopPropagation(); // don't let this bubble to outside-click handler
      const btn = panel.querySelector("#sr-ask-btn");
      const answerEl = panel.querySelector("#sr-answer");

      btn.disabled = true;
      btn.textContent = "...";
      answerEl.textContent = "";
      answerEl.className = "sr-answer sr-loading";
      STATE.answerText  = "";
      STATE.answerClass = "sr-answer sr-loading";
      STATE.isLoading   = true;
      updateCopyButton(panel, "", "sr-answer sr-loading");

      const bodyText = getBodyText().slice(0, 6000);

      try {
        const data = await requestGroqWithKeyRotation(bodyText);
        let reply = data.choices?.[0]?.message?.content || "No response.";
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        // Re-query elements in case panel was re-mounted
        const liveAnswerEl = document.getElementById("sr-answer");
        if (liveAnswerEl) {
          liveAnswerEl.className = "sr-answer";
          liveAnswerEl.textContent = reply;
        }
        STATE.answerText  = reply;
        STATE.answerClass = "sr-answer";
        updateCopyButton(document.getElementById("__sr-panel"), reply, "sr-answer");

      } catch (e) {
        const liveAnswerEl = document.getElementById("sr-answer");
        if (liveAnswerEl) {
          liveAnswerEl.className = "sr-answer sr-error";
          liveAnswerEl.textContent = "Error: " + e.message;
        }
        STATE.answerText  = "Error: " + e.message;
        STATE.answerClass = "sr-answer sr-error";
        updateCopyButton(document.getElementById("__sr-panel"), "", "sr-answer sr-error");
      }

      STATE.isLoading = false;
      const liveBtn = document.getElementById("sr-ask-btn");
      if (liveBtn) { liveBtn.disabled = false; liveBtn.textContent = "ask"; }
    });
  }

  // ── Outside-click handler ────────────────────────────────
  function outsideClickHandler(e) {
    const panel = document.getElementById("__sr-panel");
    const tab   = document.getElementById("__sr-tab");
    if (!panel) {
      document.removeEventListener("click", outsideClickHandler);
      return;
    }
    // If click is outside panel AND outside the tab itself
    if (!panel.contains(e.target) && e.target !== tab) {
      document.removeEventListener("click", outsideClickHandler);
      minimisePanel();
    }
  }

  injectTab();

  // Alt+Shift+H toggles full hide/show without touching mouse.
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && String(e.key || "").toUpperCase() === TOGGLE_HOTKEY_KEY) {
      e.preventDefault();
      setWidgetHidden(!STATE.isWidgetHidden);
    }
  });

  // ── Popup messages ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "readPage") {
      const text = logBodyText();
      sendResponse({ success: true, bodyText: text.slice(0, 300) });
    }
    if (msg.action === "togglePanel") {
      const panel = document.getElementById("__sr-panel");
      const tab   = document.getElementById("__sr-tab");
      if (panel) {
        document.removeEventListener("click", outsideClickHandler);
        minimisePanel();
        sendResponse({ visible: false });
      } else {
        if (STATE.isWidgetHidden) setWidgetHidden(false);
        expandPanel();
        sendResponse({ visible: true });
      }
    }
    return true;
  });
})();
