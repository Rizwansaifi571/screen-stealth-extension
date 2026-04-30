// Screen Reader Extension - Personal Study/Coding Assistant
(function () {
  if (window.__screenReaderExtensionLoaded) return;
  window.__screenReaderExtensionLoaded = true;

  const GROQ_API_KEYS = [
    "", 
    // Add more keys below. Empty strings are ignored.
  ].filter(Boolean);

  const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
  // For max accuracy but lower practical daily usage:
  // const GROQ_MODEL = "llama-3.3-70b-versatile";

  let activeGroqKeyIndex = 0;

  const UI_STATE_KEY = "__sr_widget_ui_state_v2";
  const TOGGLE_HOTKEY_KEY = "H";
  const MAX_HISTORY_ITEMS = 6;

  const STATE = {
    answerText: "",
    answerClass: "sr-answer",
    isLoading: false,
    tabPosition: null,
    panelPosition: null,
    isWidgetHidden: false,
    questionText: "",
    mode: "code",
    usePageContext: true,
    chatHistory: [],
  };

  function loadUiState() {
    try {
      const raw = localStorage.getItem(UI_STATE_KEY);
      if (!raw) return;

      const saved = JSON.parse(raw);

      if (
        saved?.tabPosition &&
        Number.isFinite(saved.tabPosition.left) &&
        Number.isFinite(saved.tabPosition.top)
      ) {
        STATE.tabPosition = {
          left: saved.tabPosition.left,
          top: saved.tabPosition.top,
        };
      }

      if (
        saved?.panelPosition &&
        Number.isFinite(saved.panelPosition.left) &&
        Number.isFinite(saved.panelPosition.top)
      ) {
        STATE.panelPosition = {
          left: saved.panelPosition.left,
          top: saved.panelPosition.top,
        };
      }

      STATE.isWidgetHidden = Boolean(saved?.isWidgetHidden);
      STATE.questionText = typeof saved?.questionText === "string" ? saved.questionText : "";
      STATE.mode = typeof saved?.mode === "string" ? saved.mode : "code";
      STATE.usePageContext = saved?.usePageContext !== false;

      if (Array.isArray(saved?.chatHistory)) {
        STATE.chatHistory = saved.chatHistory.slice(-MAX_HISTORY_ITEMS);
      }
    } catch {
      // Ignore malformed persisted state
    }
  }

  function persistUiState() {
    try {
      localStorage.setItem(
        UI_STATE_KEY,
        JSON.stringify({
          tabPosition: STATE.tabPosition,
          panelPosition: STATE.panelPosition,
          isWidgetHidden: STATE.isWidgetHidden,
          questionText: STATE.questionText,
          mode: STATE.mode,
          usePageContext: STATE.usePageContext,
          chatHistory: STATE.chatHistory.slice(-MAX_HISTORY_ITEMS),
        })
      );
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

  function getBodyText() {
    return (document.body?.innerText || "").trim();
  }

  function logBodyText() {
    return getBodyText();
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

    if (
      /(#include\s*<|\bstd::|\bint\s+main\s*\(|\bcout\s*<<|\bcin\s*>>|\busing\s+namespace\s+std\b|\bvector\s*<|\bclass\s+Solution\b|\bpublic:\b|\bprivate:\b|\bListNode\b|\bTreeNode\b)/.test(
        value
      )
    ) {
      return "cpp";
    }

    if (
      /(\bpublic\s+class\b|\bSystem\.out\.print|\bpublic\s+static\s+void\s+main\s*\(|\bArrayList\s*<|\bHashMap\s*<)/.test(
        value
      )
    ) {
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

    const hasAnswer = answerClass === "sr-answer" && String(answerText || "").trim();

    if (!hasAnswer) {
      copyBtn.style.display = "none";
      copyBtn.dataset.copyText = "";
      copyBtn.textContent = "copy";
      return;
    }

    const language = detectCodeLanguage(answerText);
    const copyText = language ? extractCodeForCopy(answerText) : answerText.trim();

    copyBtn.style.display = "inline-block";
    copyBtn.dataset.copyText = copyText;
    copyBtn.dataset.copyLang = language || "answer";
    copyBtn.textContent = language ? "copy code" : "copy";
  }

  function classifyGroqError(status, message) {
    const text = String(message || "").toLowerCase();

    const isRateOrQuota =
      status === 429 ||
      text.includes("rate") ||
      text.includes("quota") ||
      text.includes("limit") ||
      text.includes("too many requests");

    const isInvalidKey =
      (status === 401 || status === 403) &&
      (text.includes("key") ||
        text.includes("auth") ||
        text.includes("unauthorized") ||
        text.includes("forbidden") ||
        text.includes("invalid"));

    const isBadRequestOrModel =
      status === 400 ||
      text.includes("model") ||
      text.includes("invalid_request_error") ||
      text.includes("malformed");

    return { isRateOrQuota, isInvalidKey, isBadRequestOrModel };
  }

  function getSystemPrompt(mode) {
    if (mode === "code") {
      return [
        "You are a coding assistant.",
        "Follow the user's latest instruction exactly.",
        "If the user asks for code, output ONLY raw code.",
        "Do not use markdown fences.",
        "Do not add explanations unless the user explicitly asks for explanation.",
        "If the user asks to fix code, return the corrected code only.",
      ].join(" ");
    }

    if (mode === "explain") {
      return [
        "You are a clear study and coding assistant.",
        "Answer the user's latest question using the page context and previous relevant chat if helpful.",
        "Explain briefly and clearly.",
        "Avoid unnecessary long answers.",
      ].join(" ");
    }

    return [
      "You are a concise study and coding assistant.",
      "Answer the user's latest question using the page context and previous relevant chat if helpful.",
      "Keep the answer short and direct.",
      "If the user requests code only, provide only raw code without markdown.",
    ].join(" ");
  }

  function buildMessages({ bodyText, customQuestion, mode, usePageContext }) {
    const messages = [
      {
        role: "system",
        content: getSystemPrompt(mode),
      },
    ];

    const recentHistory = STATE.chatHistory.slice(-MAX_HISTORY_ITEMS);

    for (const item of recentHistory) {
      if (item?.question) {
        messages.push({
          role: "user",
          content: item.question,
        });
      }

      if (item?.answer) {
        messages.push({
          role: "assistant",
          content: item.answer,
        });
      }
    }

    const cleanQuestion = String(customQuestion || "").trim();
    const cleanPageText = String(bodyText || "").trim();

    let finalUserMessage = "";

    if (cleanQuestion) {
      finalUserMessage += `Latest user question/instruction:\n${cleanQuestion}\n\n`;
    } else {
      finalUserMessage += "No typed question was provided. Identify the main useful question from the page context and answer it.\n\n";
    }

    if (usePageContext && cleanPageText) {
      finalUserMessage += `Current webpage context:\n${cleanPageText}\n\n`;
    }

    if (mode === "code") {
      finalUserMessage += "Output format: raw final code only when code is needed. No explanation. No markdown.";
    } else if (mode === "answer") {
      finalUserMessage += "Output format: short final answer only.";
    } else {
      finalUserMessage += "Output format: brief explanation.";
    }

    messages.push({
      role: "user",
      content: finalUserMessage,
    });

    return messages;
  }

  async function requestGroqWithKeyRotation(messages) {
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
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            max_tokens: 1200,
            temperature: 0.2,
          }),
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

  function addToChatHistory(question, answer) {
    const cleanQuestion = String(question || "").trim();
    const cleanAnswer = String(answer || "").trim();

    if (!cleanQuestion && !cleanAnswer) return;

    STATE.chatHistory.push({
      question: cleanQuestion || "Page-context question",
      answer: cleanAnswer,
      timestamp: Date.now(),
    });

    STATE.chatHistory = STATE.chatHistory.slice(-MAX_HISTORY_ITEMS);
    persistUiState();
  }

  function clearConversation(panel) {
    STATE.answerText = "";
    STATE.answerClass = "sr-answer";
    STATE.chatHistory = [];
    STATE.questionText = "";

    persistUiState();

    const answerEl = panel?.querySelector("#sr-answer");
    const inputEl = panel?.querySelector("#sr-question-input");

    if (answerEl) {
      answerEl.className = "sr-answer";
      answerEl.textContent = "";
    }

    if (inputEl) inputEl.value = "";

    updateCopyButton(panel, "", "sr-answer");
  }

  async function runAsk(panel) {
    if (!panel || STATE.isLoading) return;

    const btn = panel.querySelector("#sr-ask-btn");
    const answerEl = panel.querySelector("#sr-answer");
    const inputEl = panel.querySelector("#sr-question-input");
    const modeEl = panel.querySelector("#sr-mode-select");
    const usePageEl = panel.querySelector("#sr-use-page-context");

    const customQuestion = String(inputEl?.value || "").trim();
    const mode = String(modeEl?.value || "code");
    const usePageContext = Boolean(usePageEl?.checked);

    STATE.questionText = customQuestion;
    STATE.mode = mode;
    STATE.usePageContext = usePageContext;
    STATE.isLoading = true;
    STATE.answerText = "";
    STATE.answerClass = "sr-answer sr-loading";

    persistUiState();

    if (btn) {
      btn.disabled = true;
      btn.textContent = "...";
    }

    if (answerEl) {
      answerEl.textContent = "";
      answerEl.className = "sr-answer sr-loading";
    }

    updateCopyButton(panel, "", "sr-answer sr-loading");

    const bodyText = usePageContext ? getBodyText().slice(0, 7000) : "";
    const messages = buildMessages({
      bodyText,
      customQuestion,
      mode,
      usePageContext,
    });

    try {
      const data = await requestGroqWithKeyRotation(messages);

      let reply = data.choices?.[0]?.message?.content || "No response.";
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

      const liveAnswerEl = document.getElementById("sr-answer");

      if (liveAnswerEl) {
        liveAnswerEl.className = "sr-answer";
        liveAnswerEl.textContent = reply;
      }

      STATE.answerText = reply;
      STATE.answerClass = "sr-answer";

      addToChatHistory(customQuestion || "Use current webpage context", reply);
      updateCopyButton(document.getElementById("__sr-panel"), reply, "sr-answer");
    } catch (e) {
      const errorMessage = "Error: " + (e?.message || "Something went wrong.");
      const liveAnswerEl = document.getElementById("sr-answer");

      if (liveAnswerEl) {
        liveAnswerEl.className = "sr-answer sr-error";
        liveAnswerEl.textContent = errorMessage;
      }

      STATE.answerText = errorMessage;
      STATE.answerClass = "sr-answer sr-error";

      updateCopyButton(document.getElementById("__sr-panel"), "", "sr-answer sr-error");
    } finally {
      STATE.isLoading = false;
      persistUiState();

      const liveBtn = document.getElementById("sr-ask-btn");

      if (liveBtn) {
        liveBtn.disabled = false;
        liveBtn.textContent = "ask";
      }
    }
  }

  function minimisePanel() {
    const panel = document.getElementById("__sr-panel");
    const tab = document.getElementById("__sr-tab");

    if (!panel) return;

    panel.style.opacity = "0";
    panel.style.transform = "translateX(110%)";

    setTimeout(() => {
      panel.remove();
      if (tab && !STATE.isWidgetHidden) tab.style.display = "block";
    }, 250);
  }

  function injectTab() {
    if (document.getElementById("__sr-tab")) return;

    const tab = document.createElement("div");
    tab.id = "__sr-tab";
    tab.textContent = "ask";
    document.body.appendChild(tab);

    const fallbackLeft = Math.max(0, window.innerWidth - tab.getBoundingClientRect().width);
    const fallbackTop = Math.max(0, window.innerHeight / 2 - 24);

    applyFixedPosition(tab, STATE.tabPosition, fallbackLeft, fallbackTop);

    makeDraggable(
      tab,
      tab,
      (pos) => {
        STATE.tabPosition = pos;
        persistUiState();
      },
      () => {
        expandPanel();
      }
    );

    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      setWidgetHidden(true);
    });

    if (STATE.isWidgetHidden) {
      tab.style.display = "none";
    }
  }

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

      <div class="sr-input-wrap">
        <textarea
          id="sr-question-input"
          class="sr-question-input"
          rows="3"
          placeholder="Ask specific question, paste code, or write instruction..."
        ></textarea>

        <div class="sr-options-row">
          <label class="sr-check-label">
            <input type="checkbox" id="sr-use-page-context" />
            page
          </label>

          <select id="sr-mode-select" class="sr-mode-select" title="Answer mode">
            <option value="code">code only</option>
            <option value="answer">short answer</option>
            <option value="explain">explain</option>
          </select>
        </div>
      </div>

      <div class="sr-footer">
        <button class="sr-copy-btn" id="sr-copy-btn" style="display:none;">copy</button>
        <button class="sr-clear-btn" id="sr-clear-btn">clear</button>
        <button class="sr-ask-btn" id="sr-ask-btn">ask</button>
      </div>
    `;

    document.body.appendChild(panel);

    panel.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    const fallbackLeft = Math.max(0, window.innerWidth - panel.getBoundingClientRect().width - 8);
    const fallbackTop = Math.max(0, window.innerHeight / 2 - panel.getBoundingClientRect().height / 2);

    applyFixedPosition(panel, STATE.panelPosition, fallbackLeft, fallbackTop);

    makeDraggable(panel.querySelector(".sr-drag-handle"), panel, (pos) => {
      STATE.panelPosition = pos;
      persistUiState();
    });

    const answerEl = panel.querySelector("#sr-answer");
    const inputEl = panel.querySelector("#sr-question-input");
    const modeEl = panel.querySelector("#sr-mode-select");
    const usePageEl = panel.querySelector("#sr-use-page-context");

    if (answerEl && STATE.answerText) answerEl.textContent = STATE.answerText;
    if (inputEl) inputEl.value = STATE.questionText || "";
    if (modeEl) modeEl.value = STATE.mode || "code";
    if (usePageEl) usePageEl.checked = STATE.usePageContext !== false;

    updateCopyButton(panel, STATE.answerText, STATE.answerClass);

    if (STATE.isLoading) {
      if (answerEl) answerEl.className = "sr-answer sr-loading";

      const askBtn = panel.querySelector("#sr-ask-btn");
      if (askBtn) {
        askBtn.disabled = true;
        askBtn.textContent = "...";
      }

      updateCopyButton(panel, "", "sr-answer sr-loading");
    }

    panel.querySelector("#sr-minimize")?.addEventListener("click", (e) => {
      e.stopPropagation();
      minimisePanel();
    });

    panel.querySelector("#sr-copy-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();

      const copyBtn = panel.querySelector("#sr-copy-btn");
      const textToCopy = copyBtn?.dataset?.copyText || "";

      if (!textToCopy) return;

      try {
        await copyTextToClipboard(textToCopy);
        copyBtn.textContent = "copied";

        setTimeout(() => {
          const liveCopyBtn = document.getElementById("sr-copy-btn");
          if (liveCopyBtn) {
            liveCopyBtn.textContent = liveCopyBtn.dataset.copyLang === "answer" ? "copy" : "copy code";
          }
        }, 900);
      } catch {
        copyBtn.textContent = "fail";

        setTimeout(() => {
          const liveCopyBtn = document.getElementById("sr-copy-btn");
          if (liveCopyBtn) {
            liveCopyBtn.textContent = liveCopyBtn.dataset.copyLang === "answer" ? "copy" : "copy code";
          }
        }, 900);
      }
    });

    panel.querySelector("#sr-clear-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearConversation(panel);
    });

    panel.querySelector("#sr-ask-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runAsk(panel);
    });

    inputEl?.addEventListener("input", () => {
      STATE.questionText = inputEl.value;
      persistUiState();
    });

    modeEl?.addEventListener("change", () => {
      STATE.mode = modeEl.value;
      persistUiState();
    });

    usePageEl?.addEventListener("change", () => {
      STATE.usePageContext = usePageEl.checked;
      persistUiState();
    });

    inputEl?.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        await runAsk(panel);
      }
    });

    setTimeout(() => {
      document.addEventListener("click", outsideClickHandler);
    }, 50);
  }

  function outsideClickHandler(e) {
    const panel = document.getElementById("__sr-panel");
    const tab = document.getElementById("__sr-tab");

    if (!panel) {
      document.removeEventListener("click", outsideClickHandler);
      return;
    }

    if (!panel.contains(e.target) && e.target !== tab) {
      document.removeEventListener("click", outsideClickHandler);
      minimisePanel();
    }
  }

  loadUiState();
  injectTab();
  logBodyText();

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && String(e.key || "").toUpperCase() === TOGGLE_HOTKEY_KEY) {
      e.preventDefault();
      setWidgetHidden(!STATE.isWidgetHidden);
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "readPage") {
      const text = logBodyText();
      sendResponse({ success: true, bodyText: text.slice(0, 300) });
    }

    if (msg.action === "togglePanel") {
      const panel = document.getElementById("__sr-panel");

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