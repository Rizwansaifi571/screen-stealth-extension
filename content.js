// Screen Reader Extension - Personal Study/Coding Assistant
(function () {
  if (window.__screenReaderExtensionLoaded) return;
  window.__screenReaderExtensionLoaded = true;

  const GROQ_API_KEYS = (window.ENV?.GROQ_API_KEYS || []).filter(Boolean);

  const GROQ_MODELS = [
    // Try stronger model first for better medium/hard question solving.
    "llama-3.3-70b-versatile",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ];

  const GEMINI_API_KEYS = (window.ENV?.GEMINI_API_KEYS || []).filter(Boolean);

  const GEMINI_MODELS = [
    // Prioritize strongest reasoning model first, then faster/cheaper fallbacks.
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ];

  let activeGroqKeyIndex = 0;
  let activeGroqModelIndex = 0;
  let activeGeminiKeyIndex = 0;
  let activeGeminiModelIndex = 0;

  const UI_STATE_KEY = "__sr_widget_ui_state_v2";
  const TOGGLE_HOTKEY_KEY = "H";
  const MAX_HISTORY_ITEMS = 6;
  const MAX_RAW_PAGE_TEXT_CHARS = 50000;
  const MAX_PAGE_CONTEXT_CHARS = 10000;
  const MAX_SELECTED_TEXT_CHARS = 1400;
  const STOPWORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "that",
    "the",
    "their",
    "them",
    "there",
    "they",
    "this",
    "to",
    "was",
    "we",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "you",
    "your",
  ]);

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
    deepSolve: true,
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
      STATE.deepSolve = saved?.deepSolve !== false;

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
          deepSolve: STATE.deepSolve,
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

  function normalizeWhitespace(text) {
    return String(text || "")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getSelectedText() {
    const selected = window.getSelection?.()?.toString() || "";
    return normalizeWhitespace(selected).slice(0, MAX_SELECTED_TEXT_CHARS);
  }

  function tokenizeForRetrieval(text) {
    if (!text) return [];

    const rawTokens = String(text)
      .toLowerCase()
      .replace(/[^a-z0-9#+._-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    const unique = [];
    const seen = new Set();

    for (const token of rawTokens) {
      if (seen.has(token)) continue;
      if (!/\d/.test(token) && token.length < 3) continue;
      if (STOPWORDS.has(token)) continue;
      seen.add(token);
      unique.push(token);
      if (unique.length >= 30) break;
    }

    return unique;
  }

  function splitContextCandidates(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return [];

    const blocks = normalized.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    const candidates = [];

    for (const block of blocks) {
      if (block.length <= 850) {
        candidates.push(block);
        continue;
      }

      const lines = block.split(/\n+/).map((x) => x.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.length <= 500) {
          candidates.push(line);
          continue;
        }

        for (let i = 0; i < line.length; i += 500) {
          candidates.push(line.slice(i, i + 500));
        }
      }
    }

    return candidates;
  }

  function scoreContextCandidate(candidate, queryTokens) {
    if (!candidate || !queryTokens.length) return 0;

    const text = candidate.toLowerCase();
    let score = 0;
    let hitCount = 0;

    for (const token of queryTokens) {
      if (text.includes(token)) {
        hitCount += 1;
        score += token.length >= 6 ? 2.2 : 1.2;
      }
    }

    score += Math.min(hitCount, 6) * 0.8;

    if (/[?]/.test(candidate)) score += 1.1;
    if (/\b(a|b|c|d|e)\s*[).:-]/i.test(candidate)) score += 0.7;
    if (/\b(input|output|constraint|example|approach|edge case|complexity|proof|derive|equation)\b/i.test(text)) {
      score += 1.3;
    }
    if (/\d/.test(candidate)) score += 0.35;
    if (candidate.length > 700) score -= 0.6;

    return score;
  }

  function buildRelevantPageContext(rawBodyText, customQuestion, selectedText) {
    const cleanBody = normalizeWhitespace(String(rawBodyText || "").slice(0, MAX_RAW_PAGE_TEXT_CHARS));
    const cleanSelected = normalizeWhitespace(selectedText).slice(0, MAX_SELECTED_TEXT_CHARS);
    if (!cleanBody && !cleanSelected) return "";

    const tokens = tokenizeForRetrieval(customQuestion);
    let coreContext = cleanBody.slice(0, MAX_PAGE_CONTEXT_CHARS);

    if (tokens.length && cleanBody) {
      const candidates = splitContextCandidates(cleanBody);
      const scored = candidates
        .map((chunk, index) => ({ chunk, index, score: scoreContextCandidate(chunk, tokens) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);

      if (scored.length) {
        const chosen = [];
        const seen = new Set();
        let usedChars = 0;

        for (const item of scored) {
          const key = item.chunk.toLowerCase();
          if (seen.has(key)) continue;

          const nextCost = item.chunk.length + 2;
          if (usedChars + nextCost > MAX_PAGE_CONTEXT_CHARS) continue;

          seen.add(key);
          chosen.push(item);
          usedChars += nextCost;

          if (chosen.length >= 18 || usedChars >= MAX_PAGE_CONTEXT_CHARS * 0.92) break;
        }

        if (chosen.length) {
          chosen.sort((a, b) => a.index - b.index);
          coreContext = chosen.map((x) => x.chunk).join("\n\n").trim();
        }
      }
    }

    if (!cleanSelected) return coreContext.slice(0, MAX_PAGE_CONTEXT_CHARS);

    const wrapped = [
      "Selected text (highest priority):",
      cleanSelected,
      "",
      "Other relevant page context:",
      coreContext,
    ].join("\n");

    return wrapped.slice(0, MAX_PAGE_CONTEXT_CHARS);
  }

  function inferDifficulty(customQuestion, mode, bodyText) {
    const q = String(customQuestion || "");
    const t = `${q}\n${String(bodyText || "").slice(0, 2200)}`.toLowerCase();
    let score = 0;

    if (mode === "code") score += 2;
    if (q.split(/\s+/).filter(Boolean).length >= 18) score += 2;
    if ((t.match(/\b(if|else|for|while|class|function|return|import|#include)\b/g) || []).length >= 4) score += 1;
    if ((t.match(/\n/g) || []).length >= 18) score += 1;
    if (/\b(hard|difficult|medium|optimi[sz]e|dynamic programming|dp|graph|dfs|bfs|backtracking|proof|derive|complexity|edge case)\b/.test(t)) {
      score += 3;
    }

    if (score >= 6) return "hard";
    if (score >= 3) return "medium";
    return "easy";
  }

  function shouldRunDeepSolve({ deepSolve, mode, customQuestion, difficulty }) {
    if (!deepSolve) return false;
    if (mode === "code") return true;
    if (difficulty === "hard" || difficulty === "medium") return true;
    if (String(customQuestion || "").split(/\s+/).filter(Boolean).length >= 20) return true;
    return false;
  }

  function isLowConfidenceReply(reply, mode) {
    const clean = String(reply || "").trim();
    if (!clean) return true;

    if (/i (am )?(not sure|cannot|can't|unable|don't know|insufficient)/i.test(clean)) {
      return true;
    }

    if (mode === "code" && clean.length < 20) return true;
    if (mode === "code" && !isCodeOnlyReplyValid(clean)) return true;
    if (mode !== "code" && clean.length < 16) return true;

    return false;
  }

  function getBracketDelta(text, openChar, closeChar) {
    let delta = 0;
    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === openChar) delta += 1;
      if (ch === closeChar) delta -= 1;
    }
    return delta;
  }

  function isCodeOnlyReplyValid(reply) {
    const clean = String(reply || "").trim();
    if (!clean) return false;

    if (/```/.test(clean)) return false;

    if (
      /^(the problem asks|this problem asks|we need to|to solve|here'?s|let'?s|approach|algorithm|intuition)\b/i.test(
        clean
      )
    ) {
      return false;
    }

    if (
      /\b(the problem asks|we can solve|we need to|algorithm is|intuition|time complexity|space complexity)\b/i.test(
        clean
      )
    ) {
      return false;
    }

    const lines = clean.split("\n").map((x) => x.trim()).filter(Boolean);
    const commentLines = lines.filter((line) => {
      return (
        line.startsWith("//") ||
        line.startsWith("/*") ||
        line.startsWith("*") ||
        line.startsWith("# ")
      );
    }).length;

    if (lines.length > 0 && commentLines / lines.length > 0.25) {
      return false;
    }

    const language = detectCodeLanguage(clean);
    if (!language) return false;

    if (["cpp", "java", "javascript", "c", "c++"].includes(language)) {
      if (getBracketDelta(clean, "{", "}") !== 0) return false;
      if (getBracketDelta(clean, "(", ")") !== 0) return false;
      if (getBracketDelta(clean, "[", "]") !== 0) return false;
    }

    if (language === "cpp") {
      const hasSolutionClass = /\bclass\s+Solution\b/.test(clean);
      const hasMain = /\bint\s+main\s*\(/.test(clean);

      if (!hasSolutionClass && !hasMain) return false;
      if (hasSolutionClass && !/\bpublic\s*:/.test(clean)) return false;
    }

    if (language === "java") {
      if (!/\bclass\s+\w+/.test(clean)) return false;
    }

    if (language === "python") {
      if (!/\b(def|class)\s+\w+/.test(clean)) return false;
    }

    return true;
  }

  function sanitizeReply(reply, mode) {
    let clean = String(reply || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    if (mode === "code") {
      const fencedAnywhere = clean.match(/```[a-zA-Z0-9#+._-]*\s*\n([\s\S]*?)```/i);
      if (fencedAnywhere?.[1]) {
        clean = fencedAnywhere[1].trim();
      } else {
        clean = clean.replace(/^```[a-zA-Z0-9#+._-]*\s*\n?/i, "");
        clean = clean.replace(/```$/, "").trim();
      }
    }

    return clean;
  }

  function getMaxCompletionTokens(mode, difficulty, isVerificationPass = false) {
    if (mode === "code") {
      if (difficulty === "hard") return isVerificationPass ? 8192 : 6144;
      if (difficulty === "medium") return isVerificationPass ? 6144 : 4096;
      return isVerificationPass ? 4096 : 3072;
    }

    if (mode === "explain") {
      if (difficulty === "hard") return isVerificationPass ? 2200 : 1700;
      if (difficulty === "medium") return isVerificationPass ? 1700 : 1300;
      return isVerificationPass ? 1200 : 900;
    }

    if (difficulty === "hard") return isVerificationPass ? 1600 : 1200;
    if (difficulty === "medium") return isVerificationPass ? 1200 : 900;
    return isVerificationPass ? 900 : 700;
  }

  function getGeminiThinkingBudget(difficulty, mode, isVerificationPass = false) {
    if (mode === "code") {
      if (difficulty === "hard") return isVerificationPass ? 24576 : 20480;
      if (difficulty === "medium") return isVerificationPass ? 12288 : 8192;
      return isVerificationPass ? 6144 : 4096;
    }

    if (difficulty === "hard") return isVerificationPass ? 12288 : 8192;
    if (difficulty === "medium") return isVerificationPass ? 6144 : 4096;
    return isVerificationPass ? 2048 : 1024;
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

  // Force-insert text into any element (input, textarea, contenteditable, code editors)
  function forceInsertText(el, text) {
    if (!el || !text) return false;

    // Standard input/textarea
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);

      // Use native setter to bypass React/Angular controlled input guards
      const nativeSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el).__proto__, "value"
      )?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

      if (nativeSetter) {
        nativeSetter.call(el, before + text + after);
      } else {
        el.value = before + text + after;
      }

      const newCursor = start + text.length;
      el.selectionStart = newCursor;
      el.selectionEnd = newCursor;

      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      return true;
    }

    // ContentEditable elements (rich text editors, CodeMirror, Monaco, etc.)
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      el.focus();

      // Try execCommand first
      try {
        const success = document.execCommand("insertText", false, text);
        if (success) return true;
      } catch (_) {}

      // Fallback: Selection API
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
        el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        return true;
      }

      el.textContent += text;
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      return true;
    }

    // For CodeMirror / Monaco – try to find the underlying editor instance
    // CodeMirror 6
    const cmView = el.closest && el.closest(".cm-editor");
    if (cmView && cmView.cmView?.view) {
      try {
        const view = cmView.cmView.view;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: text } });
        return true;
      } catch (_) {}
    }

    // Monaco editor
    const monacoEl = el.closest && el.closest(".monaco-editor");
    if (monacoEl) {
      try {
        const monacoWidget = monacoEl.querySelector(".inputarea, textarea");
        if (monacoWidget) {
          monacoWidget.focus();
          const success = document.execCommand("insertText", false, text);
          if (success) return true;
        }
      } catch (_) {}
    }

    return false;
  }

  // Find the best element to paste code into on OA platforms
  function findBestPasteTarget() {
    // Helper to get active element even inside shadow DOMs
    function getDeepActiveElement() {
      let active = document.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    }

    // 1. Check if activeElement is a valid target (user clicked into an editor)
    const active = getDeepActiveElement();
    if (active && active.id !== "__sr-panel" && !active.closest("#__sr-panel")) {
      if (
        active.tagName === "TEXTAREA" ||
        (active.tagName === "INPUT" && active.type !== "hidden") ||
        active.isContentEditable
      ) {
        return active;
      }
    }

    // Traverse shadow DOMs to find editors
    function queryDeep(selector) {
      let found = document.querySelector(selector);
      if (found) return found;
      
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          found = el.shadowRoot.querySelector(selector);
          if (found) return found;
        }
      }
      return null;
    }

    // 2. CodeMirror 6 (e.g., LeetCode, HackerRank)
    const cm6 = queryDeep(".cm-editor .cm-content[contenteditable]");
    if (cm6) return cm6;

    // 3. CodeMirror 5
    const cm5 = queryDeep(".CodeMirror textarea");
    if (cm5) return cm5;

    // 4. Monaco editor (e.g., some coding platforms)
    const monaco = queryDeep(".monaco-editor .inputarea, .monaco-editor textarea");
    if (monaco) return monaco;

    // 5. ACE editor
    const ace = queryDeep(".ace_editor textarea");
    if (ace) return ace;

    // 6. Any large textarea (likely the code input)
    let largeTA = null;
    let maxSize = 0;
    
    function scanForLargeTextareas(root) {
      const textareas = root.querySelectorAll("textarea:not(#sr-question-input)");
      for (const ta of textareas) {
        if (ta.closest && ta.closest("#__sr-panel")) continue;
        const size = ta.offsetHeight * ta.offsetWidth;
        if (size > maxSize) {
          maxSize = size;
          largeTA = ta;
        }
      }
      
      // Check shadow roots
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          scanForLargeTextareas(el.shadowRoot);
        }
      }
    }
    
    scanForLargeTextareas(document);
    if (largeTA) return largeTA;

    // 7. Any contenteditable element
    function scanForContentEditable(root) {
      const editables = root.querySelectorAll("[contenteditable=true]");
      for (const el of editables) {
        if (!el.closest || !el.closest("#__sr-panel")) return el;
      }
      
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = scanForContentEditable(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    return scanForContentEditable(document);
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
    const pasteBtn = panel.querySelector("#sr-paste-btn");
    if (!copyBtn) return;

    const hasAnswer = answerClass === "sr-answer" && String(answerText || "").trim();

    if (!hasAnswer) {
      copyBtn.style.display = "none";
      if (pasteBtn) pasteBtn.style.display = "none";
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

    // Show paste button for code answers
    if (pasteBtn && language) {
      pasteBtn.style.display = "inline-block";
      pasteBtn.dataset.pasteText = copyText;
    } else if (pasteBtn) {
      pasteBtn.style.display = "none";
    }
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

    const isModelUnavailable =
      text.includes("model") &&
      (text.includes("decommissioned") ||
        text.includes("no longer supported") ||
        text.includes("not found") ||
        text.includes("not available") ||
        text.includes("unknown model") ||
        text.includes("unsupported"));

    const isBadRequest =
      status === 400 || text.includes("invalid_request_error") || text.includes("malformed");

    return { isRateOrQuota, isInvalidKey, isModelUnavailable, isBadRequest };
  }

  function getSystemPrompt(mode, deepSolve) {
    if (mode === "code") {
      return [
        "You are an expert competitive programming assistant.",
        "The user needs accepted-level code for DSA medium/hard problems.",
        "Think silently. Do not reveal reasoning.",
        "Before final answer, internally verify constraints, edge cases, overflow, and time complexity.",
        "Output ONLY complete final source code.",
        "No markdown fences.",
        "No explanations.",
        "No comments.",
        "No pseudo-code.",
        "No incomplete functions.",
        "No placeholders.",
        "No text before or after code.",
        "If the platform provides a class Solution template, return the complete class Solution implementation only.",
        "If the user asks to fix code, return only the corrected complete code.",
        deepSolve ? "Prefer correctness and edge-case safety over short code." : "",
      ].join(" ");
    }

    if (mode === "explain") {
      return [
        "You are a clear and accurate study and coding assistant.",
        "Answer the user's latest question using the page context and previous relevant chat if helpful.",
        "Think through the problem internally before answering.",
        "Explain clearly with only the essential steps.",
        deepSolve ? "Double-check the result before finalizing." : "",
      ].join(" ");
    }

    return [
      "You are a concise and accurate study and coding assistant.",
      "Answer the user's latest question using the page context and previous relevant chat if helpful.",
      "Think through the problem internally before answering.",
      "Keep the answer concise but complete.",
      "If the user requests code only, provide only raw code without markdown.",
      deepSolve ? "Verify the final answer before output." : "",
    ].join(" ");
  }

  function buildMessages({ bodyText, customQuestion, mode, usePageContext, deepSolve, difficulty }) {
    const messages = [
      {
        role: "system",
        content: getSystemPrompt(mode, deepSolve),
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
      finalUserMessage += "No typed question was provided. Identify the main coding problem from the page context and solve it.\n\n";
    }

    if (usePageContext && cleanPageText) {
      finalUserMessage += `Current webpage context:\n${cleanPageText}\n\n`;
    }

    finalUserMessage += `Estimated difficulty: ${difficulty}.\n\n`;

    if (mode === "code") {
      finalUserMessage += [
        "Task:",
        "Return the final accepted solution code only.",
        "The code must be complete and directly submittable.",
        "Do not include comments.",
        "Do not include explanation.",
        "Do not include markdown.",
        "Do not include dry run.",
        "Do not include algorithm description.",
        "Do not include incomplete helper functions.",
        "Use the correct language/template from the problem context.",
        "For LeetCode-style C++ problems, return only complete class Solution code.",
        "For normal input/output problems, return a complete program with main().",
      ].join("\n");
    } else if (mode === "answer") {
      finalUserMessage += "Output format: final answer first, then short key reasoning only if needed.";
    } else {
      finalUserMessage += "Output format: brief but complete explanation.";
    }

    messages.push({
      role: "user",
      content: finalUserMessage,
    });

    return messages;
  }

  function buildCodeOnlyRepairMessages({ bodyText, customQuestion, usePageContext, draftReply }) {
    const cleanQuestion = String(customQuestion || "").trim();
    const cleanPageText = String(bodyText || "").trim();
    const cleanDraft = String(draftReply || "").trim();

    const userPrompt = [
      cleanQuestion
        ? `Question/instruction:\n${cleanQuestion}`
        : "Question/instruction:\nUse webpage context to infer the main DSA problem.",
      usePageContext && cleanPageText ? `Relevant page context:\n${cleanPageText}` : "",
      cleanDraft ? `Previous bad/incomplete/comment-heavy draft:\n${cleanDraft}` : "",
      [
        "Rewrite the answer now.",
        "Return ONLY complete final source code.",
        "No comments.",
        "No explanation.",
        "No markdown.",
        "No pseudo-code.",
        "No placeholders.",
        "No incomplete code.",
        "Code must compile.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");

    return [
      {
        role: "system",
        content: [
          "You are a strict competitive-programming code generator.",
          "Output only complete final code.",
          "Never output comments or explanation.",
          "Never output markdown.",
        ].join(" "),
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  function buildVerificationMessages({ bodyText, customQuestion, mode, usePageContext, draftReply }) {
    const cleanQuestion = String(customQuestion || "").trim();
    const cleanPageText = String(bodyText || "").trim();
    const cleanDraft = String(draftReply || "").trim();

    const verificationTask =
      mode === "code"
        ? [
            "Verify correctness, edge cases, overflow, and constraints.",
            "If the draft is wrong, incomplete, or comment-heavy, rewrite it fully.",
            "Return ONLY final complete source code.",
            "No comments.",
            "No markdown.",
            "No explanation.",
          ].join("\n")
        : "Verify the draft answer carefully. Correct any mistakes and return a concise but complete final answer.";

    const userPrompt = [
      cleanQuestion
        ? `Question/instruction:\n${cleanQuestion}`
        : "Question/instruction:\nUse webpage context to infer the main problem.",
      usePageContext && cleanPageText ? `Relevant page context:\n${cleanPageText}` : "",
      `Draft answer to review:\n${cleanDraft}`,
      verificationTask,
    ]
      .filter(Boolean)
      .join("\n\n");

    return [
      {
        role: "system",
        content:
          mode === "code"
            ? [
                "You are a senior competitive-programming reviewer.",
                "Think silently.",
                "Return only the corrected final code.",
                "No comments.",
                "No explanation.",
                "No markdown.",
              ].join(" ")
            : [
                "You are a strict answer verifier.",
                "Reason silently to catch mistakes, then output the corrected final answer only.",
              ].join(" "),
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  function classifyGeminiError(status, message) {
    const text = String(message || "").toLowerCase();

    const isRateOrQuota =
      status === 429 ||
      text.includes("resource_exhausted") ||
      text.includes("quota") ||
      text.includes("rate") ||
      text.includes("too many requests");

    const isInvalidKey =
      (status === 400 || status === 401 || status === 403) &&
      (text.includes("api key") ||
        text.includes("key not valid") ||
        text.includes("permission denied") ||
        text.includes("unauthenticated") ||
        text.includes("forbidden") ||
        text.includes("auth"));

    const isModelUnavailable =
      (status === 400 || status === 404) &&
      (text.includes("model") &&
        (text.includes("not found") ||
          text.includes("not supported") ||
          text.includes("not available") ||
          text.includes("unknown")));

    const isBadRequest = status === 400 || text.includes("invalid argument");

    return { isRateOrQuota, isInvalidKey, isModelUnavailable, isBadRequest };
  }

  function convertMessagesToGeminiPayload(
    messages,
    {
      temperature = 0.2,
      maxCompletionTokens = 1200,
      thinkingBudget = -1,
      enableThinkingConfig = true,
    } = {}
  ) {
    const systemMessages = [];
    const contents = [];

    for (const item of Array.isArray(messages) ? messages : []) {
      const role = String(item?.role || "").toLowerCase();
      const text = String(item?.content || "").trim();
      if (!text) continue;

      if (role === "system") {
        systemMessages.push(text);
        continue;
      }

      if (role === "assistant") {
        contents.push({
          role: "model",
          parts: [{ text }],
        });
        continue;
      }

      contents.push({
        role: "user",
        parts: [{ text }],
      });
    }

    if (!contents.length) {
      contents.push({
        role: "user",
        parts: [{ text: "Respond to the latest user question." }],
      });
    }

    const generationConfig = {
      temperature,
      maxOutputTokens: maxCompletionTokens,
    };

    if (enableThinkingConfig) {
      generationConfig.thinkingConfig = {
        thinkingBudget,
      };
    }

    const payload = {
      contents,
      generationConfig,
    };

    if (systemMessages.length) {
      payload.systemInstruction = {
        parts: [{ text: systemMessages.join("\n\n") }],
      };
    }

    return payload;
  }

  function extractGeminiText(data) {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    if (!candidates.length) return "";

    const parts = Array.isArray(candidates[0]?.content?.parts) ? candidates[0].content.parts : [];
    const text = parts
      .map((part) => String(part?.text || ""))
      .join("")
      .trim();

    return text;
  }

  function extractGroqText(data) {
    return String(data?.choices?.[0]?.message?.content || "").trim();
  }

  function extractProviderText(provider, data) {
    if (provider === "gemini") return extractGeminiText(data);
    return extractGroqText(data);
  }

  async function requestGeminiWithKeyRotation(
    messages,
    { temperature = 0.2, maxCompletionTokens = 1200, thinkingBudget = -1 } = {}
  ) {
    if (!GEMINI_API_KEYS.length) {
      throw new Error("No GEMINI API keys configured.");
    }

    if (!GEMINI_MODELS.length) {
      throw new Error("No GEMINI models configured.");
    }

    if (activeGeminiKeyIndex >= GEMINI_API_KEYS.length) {
      activeGeminiKeyIndex = 0;
    }

    if (activeGeminiModelIndex >= GEMINI_MODELS.length) {
      activeGeminiModelIndex = 0;
    }

    let lastError = null;
    const modelAttempts = GEMINI_MODELS.length;
    const keyAttempts = GEMINI_API_KEYS.length;

    for (let m = 0; m < modelAttempts; m += 1) {
      const modelIndex = (activeGeminiModelIndex + m) % GEMINI_MODELS.length;
      const modelName = GEMINI_MODELS[modelIndex];

      for (let k = 0; k < keyAttempts; k += 1) {
        const keyIndex = (activeGeminiKeyIndex + k) % GEMINI_API_KEYS.length;
        const apiKey = GEMINI_API_KEYS[keyIndex];

        const payload = convertMessagesToGeminiPayload(messages, {
          temperature,
          maxCompletionTokens,
          thinkingBudget,
          enableThinkingConfig: /gemini-(2\.5|3)/.test(modelName),
        });

        let res;

        try {
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
              modelName
            )}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify(payload),
            }
          );
        } catch (error) {
          throw new Error(`Network error while contacting Gemini: ${error?.message || "Request failed"}`);
        }

        if (res.ok) {
          activeGeminiKeyIndex = keyIndex;
          activeGeminiModelIndex = modelIndex;
          const data = await res.json();
          return { data, modelName };
        }

        const err = await res.json().catch(() => ({}));
        const message = err?.error?.message || `API error ${res.status}`;
        const kind = classifyGeminiError(res.status, message);
        lastError = new Error(`Gemini model ${modelName}, key ${keyIndex + 1} failed: ${message}`);

        if (kind.isRateOrQuota || kind.isInvalidKey) {
          activeGeminiKeyIndex = (keyIndex + 1) % GEMINI_API_KEYS.length;
          continue;
        }

        if (kind.isModelUnavailable) {
          activeGeminiModelIndex = (modelIndex + 1) % GEMINI_MODELS.length;
          break;
        }

        if (kind.isBadRequest) {
          throw new Error(`Gemini request configuration error for model ${modelName}: ${message}`);
        }

        throw new Error(`Gemini request failed for model ${modelName}, key ${keyIndex + 1}: ${message}`);
      }
    }

    throw new Error(lastError?.message || "All configured Gemini keys/models failed.");
  }

  async function requestGroqWithKeyRotation(
    messages,
    { temperature = 0.2, maxCompletionTokens = 1200 } = {}
  ) {
    if (!GROQ_API_KEYS.length) {
      throw new Error("No GROQ API keys configured.");
    }

    if (!GROQ_MODELS.length) {
      throw new Error("No GROQ models configured.");
    }

    if (activeGroqKeyIndex >= GROQ_API_KEYS.length) {
      activeGroqKeyIndex = 0;
    }

    if (activeGroqModelIndex >= GROQ_MODELS.length) {
      activeGroqModelIndex = 0;
    }

    let lastError = null;
    const modelAttempts = GROQ_MODELS.length;
    const keyAttempts = GROQ_API_KEYS.length;

    for (let m = 0; m < modelAttempts; m += 1) {
      const modelIndex = (activeGroqModelIndex + m) % GROQ_MODELS.length;
      const modelName = GROQ_MODELS[modelIndex];

      for (let k = 0; k < keyAttempts; k += 1) {
        const keyIndex = (activeGroqKeyIndex + k) % GROQ_API_KEYS.length;
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
              model: modelName,
              messages,
              max_completion_tokens: maxCompletionTokens,
              temperature,
            }),
          });
        } catch (error) {
          throw new Error(`Network error while contacting Groq: ${error?.message || "Request failed"}`);
        }

        if (res.ok) {
          activeGroqKeyIndex = keyIndex;
          activeGroqModelIndex = modelIndex;
          const data = await res.json();
          return { data, modelName };
        }

        const err = await res.json().catch(() => ({}));
        const message = err?.error?.message || `API error ${res.status}`;
        const kind = classifyGroqError(res.status, message);
        lastError = new Error(`Model ${modelName}, key ${keyIndex + 1} failed: ${message}`);

        if (kind.isRateOrQuota || kind.isInvalidKey) {
          activeGroqKeyIndex = (keyIndex + 1) % GROQ_API_KEYS.length;
          continue;
        }

        if (kind.isModelUnavailable) {
          activeGroqModelIndex = (modelIndex + 1) % GROQ_MODELS.length;
          break;
        }

        if (kind.isBadRequest) {
          throw new Error(`Request configuration error for model ${modelName}: ${message}`);
        }

        throw new Error(`Groq request failed for model ${modelName}, key ${keyIndex + 1}: ${message}`);
      }
    }

    throw new Error(lastError?.message || "All configured Groq keys/models failed.");
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

  function isLikelyIncompleteCode(reply) {
    const clean = String(reply || "").trim();
    if (!clean) return true;

    if (clean.endsWith("//")) return true;
    if (clean.endsWith("/*")) return true;
    if (clean.endsWith(",")) return true;
    if (clean.endsWith("=")) return true;
    if (clean.endsWith("return")) return true;
    if (clean.endsWith("if")) return true;
    if (clean.endsWith("for")) return true;
    if (clean.endsWith("while")) return true;

    if (detectCodeLanguage(clean) === "cpp") {
      if (getBracketDelta(clean, "{", "}") !== 0) return true;
      if (/\bclass\s+Solution\b/.test(clean) && !clean.includes("};")) return true;
    }

    return false;
  }

  function isGeminiOutputCutOff(data) {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    const reason = String(candidates?.[0]?.finishReason || "").toUpperCase();
    return reason === "MAX_TOKENS";
  }

  async function runAsk(panel) {
    if (!panel || STATE.isLoading) return;

    const btn = panel.querySelector("#sr-ask-btn");
    const answerEl = panel.querySelector("#sr-answer");
    const inputEl = panel.querySelector("#sr-question-input");
    const modeEl = panel.querySelector("#sr-mode-select");
    const usePageEl = panel.querySelector("#sr-use-page-context");
    const deepSolveEl = panel.querySelector("#sr-deep-solve");

    const customQuestion = String(inputEl?.value || "").trim();
    const mode = String(modeEl?.value || "code");
    const usePageContext = Boolean(usePageEl?.checked);
    const deepSolve = deepSolveEl?.checked !== false;

    STATE.questionText = customQuestion;
    STATE.mode = mode;
    STATE.usePageContext = usePageContext;
    STATE.deepSolve = deepSolve;
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

    const rawBodyText = usePageContext ? getBodyText() : "";
    const selectedText = usePageContext ? getSelectedText() : "";
    const bodyText = usePageContext
      ? buildRelevantPageContext(rawBodyText, customQuestion, selectedText)
      : "";
    const difficulty = inferDifficulty(customQuestion, mode, bodyText);
    const runVerificationPass = shouldRunDeepSolve({
      deepSolve,
      mode,
      customQuestion,
      difficulty,
    });
    const provider = deepSolve ? "gemini" : "groq";

    const messages = buildMessages({
      bodyText,
      customQuestion,
      mode,
      usePageContext,
      deepSolve,
      difficulty,
    });

    try {
      if (provider === "gemini" && !GEMINI_API_KEYS.length) {
        throw new Error("Deep mode is set to Gemini, but no GEMINI API keys are configured.");
      }

      const firstPass =
        provider === "gemini"
          ? await requestGeminiWithKeyRotation(messages, {
              temperature: mode === "code" ? 0.1 : 0.2,
              maxCompletionTokens: getMaxCompletionTokens(mode, difficulty, false),
              thinkingBudget: getGeminiThinkingBudget(difficulty, mode, false),
            })
          : await requestGroqWithKeyRotation(messages, {
              temperature: mode === "code" ? 0.1 : 0.2,
              maxCompletionTokens: getMaxCompletionTokens(mode, difficulty, false),
            });

      let reply = sanitizeReply(
        extractProviderText(provider, firstPass.data) || "No response.",
        mode
      );

      const firstPassCutOff =
        provider === "gemini" && isGeminiOutputCutOff(firstPass.data);

      if (
        runVerificationPass ||
        firstPassCutOff ||
        isLowConfidenceReply(reply, mode) ||
        (mode === "code" && isLikelyIncompleteCode(reply))
      ) {
        const verifyMessages = buildVerificationMessages({
          bodyText,
          customQuestion,
          mode,
          usePageContext,
          draftReply: reply,
        });

        const secondPass =
          provider === "gemini"
            ? await requestGeminiWithKeyRotation(verifyMessages, {
                temperature: 0.1,
                maxCompletionTokens: getMaxCompletionTokens(mode, difficulty, true),
                thinkingBudget: getGeminiThinkingBudget(difficulty, mode, true),
              })
            : await requestGroqWithKeyRotation(verifyMessages, {
                temperature: 0.1,
                maxCompletionTokens: getMaxCompletionTokens(mode, difficulty, true),
              });

        const verifiedReply = sanitizeReply(extractProviderText(provider, secondPass.data) || "", mode);

        if (verifiedReply) {
          reply = verifiedReply;
        }
      }

      if (mode === "code" && !isCodeOnlyReplyValid(reply)) {
        const repairMessages = buildCodeOnlyRepairMessages({
          bodyText,
          customQuestion,
          usePageContext,
          draftReply: reply,
        });

        const repairPass =
          provider === "gemini"
            ? await requestGeminiWithKeyRotation(repairMessages, {
                temperature: 0.1,
                maxCompletionTokens: Math.max(1800, getMaxCompletionTokens(mode, difficulty, true)),
                thinkingBudget: getGeminiThinkingBudget(difficulty, mode, true),
              })
            : await requestGroqWithKeyRotation(repairMessages, {
                temperature: 0.1,
                maxCompletionTokens: Math.max(1800, getMaxCompletionTokens(mode, difficulty, true)),
              });

        const repairedReply = sanitizeReply(
          extractProviderText(provider, repairPass.data) || "",
          mode
        );

        if (repairedReply && isCodeOnlyReplyValid(repairedReply) && !isLikelyIncompleteCode(repairedReply)) {
          reply = repairedReply;
        }
      }

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

          <label class="sr-check-label" title="Use Gemini deep reasoning for medium/hard questions">
            <input type="checkbox" id="sr-deep-solve" />
            deep (gemini)
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
        <button class="sr-copy-btn" id="sr-paste-btn" style="display:none;" title="Force-paste code into the active editor field">paste code</button>
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
    const deepSolveEl = panel.querySelector("#sr-deep-solve");

    if (answerEl && STATE.answerText) answerEl.textContent = STATE.answerText;
    if (inputEl) inputEl.value = STATE.questionText || "";
    if (modeEl) modeEl.value = STATE.mode || "code";
    if (usePageEl) usePageEl.checked = STATE.usePageContext !== false;
    if (deepSolveEl) deepSolveEl.checked = STATE.deepSolve !== false;

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

    panel.querySelector("#sr-paste-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();

      const pasteBtn = panel.querySelector("#sr-paste-btn");
      const textToPaste = pasteBtn?.dataset?.pasteText || "";
      if (!textToPaste) return;

      // First copy to clipboard
      try {
        await copyTextToClipboard(textToPaste);
      } catch (_) {}

      // Temporarily minimize the panel to reveal the editor underneath
      panel.style.opacity = "0.05";
      panel.style.pointerEvents = "none";

      // Try to find the best target element on the page
      await new Promise((resolve) => setTimeout(resolve, 100));

      const target = findBestPasteTarget();

      if (target) {
        target.focus();
        await new Promise((resolve) => setTimeout(resolve, 50));

        let pasted = forceInsertText(target, textToPaste);

        if (!pasted) {
          // Fallback 1: Try execCommand paste since we just copied to clipboard
          try {
            if (document.execCommand("paste")) pasted = true;
          } catch (_) {}
        }

        if (!pasted) {
          // Fallback 2: Synthetic paste event
          try {
            const dt = new DataTransfer();
            dt.setData("text/plain", textToPaste);
            
            // Dispatch to both the target and its parent (some editors listen on the wrapper)
            const pasteEvent = new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: dt,
            });
            
            target.dispatchEvent(pasteEvent);
            pasted = true; // Assume success if dispatch didn't throw
          } catch (_) {}
        }

        pasteBtn.textContent = pasted ? "pasted ✓" : "use ctrl+v";
      } else {
        pasteBtn.textContent = "copied – click editor & ctrl+v";
      }

      // Restore panel
      panel.style.opacity = "";
      panel.style.pointerEvents = "";

      setTimeout(() => {
        const liveBtn = document.getElementById("sr-paste-btn");
        if (liveBtn) liveBtn.textContent = "paste code";
      }, 1500);
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

    deepSolveEl?.addEventListener("change", () => {
      STATE.deepSolve = deepSolveEl.checked;
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

