import re

with open("content.js", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Hotkey constant
content = content.replace(
    'const SMART_ACTION_HOTKEY_KEY = "Q";',
    'const SMART_ACTION_HOTKEY_KEY = "Q";\n  const SMART_MCQ_HOTKEY_KEY = "&";'
)

# 2. System Prompt
if 'if (mode === "mcq")' not in content:
    content = content.replace(
        'if (mode === "explain") {',
        '''if (mode === "mcq") {
      return [
        "You are an expert test taker.",
        "The user is showing you a multiple choice question.",
        "Your goal is to identify the correct option.",
        "Output ONLY the EXACT TEXT of the correct option as it appears on the screen.",
        "Do not output A, B, C, D unless that is the literal text of the option.",
        "Do not include any other text, reasoning, or formatting."
      ].join(" ");
    }

    if (mode === "explain") {'''
    )

# 3. Max completion tokens
if 'if (mode === "mcq") return isVerificationPass' not in content:
    content = content.replace(
        'if (mode === "explain") {',
        '''if (mode === "mcq") {
      return isVerificationPass ? 300 : 200;
    }

    if (mode === "explain") {'''
    )

# 4. MCQ Runner and Clicker functions
mcq_functions = """
  async function runHeadlessAskForMCQ() {
    if (STATE.isLoading) {
      debugHotkeyLog("mcq skipped: assistant already loading");
      throw new Error("Assistant is already generating a response.");
    }

    await ensureApiKeysLoaded();

    const mode = "mcq";
    const usePageContext = true;
    const deepSolve = STATE.deepSolve !== false;
    const selectedText = getSelectedText();
    const customQuestion = selectedText || "";

    const rawBodyText = usePageContext ? getBodyText() : "";
    const bodyText = usePageContext
      ? buildRelevantPageContext(rawBodyText, customQuestion, selectedText)
      : "";

    const difficulty = inferDifficulty(customQuestion, mode, bodyText);
    const provider = deepSolve ? "gemini" : "groq";

    const messages = buildMessages({
      bodyText,
      customQuestion,
      mode,
      usePageContext,
      deepSolve,
      difficulty,
    });

    debugHotkeyLog("mcq start", {
      provider,
      deepSolve,
      difficulty,
      selectedChars: selectedText.length,
      contextChars: bodyText.length,
    });

    STATE.isLoading = true;

    try {
      if (provider === "gemini" && !GEMINI_API_KEYS.length) {
        throw new Error("Deep mode is set to Gemini, but no GEMINI API keys are configured.");
      }

      const response =
        provider === "gemini"
          ? await requestGeminiWithKeyRotation(messages, {
              temperature: 0.1,
              maxCompletionTokens: 200,
              thinkingBudget: deepSolve ? 1024 : 0,
            })
          : await requestGroqWithKeyRotation(messages, {
              temperature: 0.1,
              maxCompletionTokens: 200,
            });

      let reply = sanitizeReply(extractProviderText(provider, response.data) || "", mode);
      debugHotkeyLog("mcq success", { answerChars: String(reply || "").length });
      return reply;
    } finally {
      STATE.isLoading = false;
    }
  }

  function clickCorrectMCQOption(answer) {
    if (!answer || answer.length < 1) return { success: false, reason: "Empty answer" };
    
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const candidates = [];
    const cleanAnswer = answer.toLowerCase().trim();
    
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.trim().toLowerCase();
      if (!text) continue;
      
      const parent = node.parentElement;
      if (!parent || parent.tagName === "SCRIPT" || parent.tagName === "STYLE" || parent.tagName === "NOSCRIPT") continue;
      
      let score = 0;
      if (text === cleanAnswer) score = 100;
      else if (text.includes(cleanAnswer) && cleanAnswer.length > 3) score = 50 + (cleanAnswer.length / text.length) * 50;
      else if (cleanAnswer.includes(text) && text.length > 5) score = 40 + (text.length / cleanAnswer.length) * 40;
      
      if (score > 40) {
        let clickable = parent;
        while (clickable && clickable !== document.body) {
          candidates.push({ el: clickable, score, text });
          clickable = clickable.parentElement;
        }
      }
    }
    
    if (candidates.length === 0) return { success: false, reason: "No matching element found for answer: " + answer };
    
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].el;
    
    try {
      best.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        best.click();
        const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window });
        const mouseup = new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window });
        best.dispatchEvent(mousedown);
        best.dispatchEvent(mouseup);
      }, 100);
      return { success: true, clickedText: candidates[0].text, rawAnswer: answer };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }
"""

if "clickCorrectMCQOption" not in content:
    content = content.replace(
        "function getEditorTextSnapshot(el) {",
        mcq_functions + "\n  function getEditorTextSnapshot(el) {"
    )

# 5. Event Listener for hotkey
event_listener_addition = """
    if (e.altKey && e.shiftKey && String(e.key || "") === "&") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || isTypingCodeNow || isSmartHotkeyFlowRunning) {
        debugHotkeyLog("mcq skipped", { reason: "flow-in-progress" });
        return;
      }
      isSmartHotkeyFlowRunning = true;
      debugHotkeyLog("hotkey accepted: Alt+Shift+& (MCQ)");

      runHeadlessAskForMCQ()
        .then((reply) => clickCorrectMCQOption(reply))
        .then((result) => {
          debugHotkeyLog("mcq flow result", result);
        })
        .catch((error) => {
          console.warn("[SR-EXT] MCQ skipped:", error?.message || error);
          debugHotkeyLog("mcq flow error", error?.message || String(error));
        })
        .finally(() => {
          isSmartHotkeyFlowRunning = false;
          debugHotkeyLog("mcq flow finished");
        });
    }
"""

if 'String(e.key || "") === "&"' not in content:
    content = content.replace(
        'if (e.altKey && e.shiftKey && String(e.key || "").toUpperCase() === SMART_ACTION_HOTKEY_KEY) {',
        event_listener_addition + '\n    if (e.altKey && e.shiftKey && String(e.key || "").toUpperCase() === SMART_ACTION_HOTKEY_KEY) {'
    )

with open("content.js", "w", encoding="utf-8") as f:
    f.write(content)

print("Modification complete")
