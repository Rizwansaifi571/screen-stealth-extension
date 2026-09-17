import sys

def main():
    with open("content.js", "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Update System Prompt
    old_prompt = """if (mode === "mcq") {
      return [
        "You are an expert test taker.",
        "The user is showing you a multiple choice question.",
        "Your goal is to identify the correct option.",
        "Output ONLY the EXACT TEXT of the correct option as it appears on the screen.",
        "Do not output A, B, C, D unless that is the literal text of the option.",
        "Do not include any other text, reasoning, or formatting."
      ].join(" ");
    }"""
    
    new_prompt = """if (mode === "mcq") {
      return [
        "You are an expert test taker.",
        "The user is showing you a page with one or more multiple choice questions.",
        "Your goal is to identify the correct option for EVERY question.",
        "Output ONLY a valid JSON array of strings, where each string is the EXACT TEXT of the correct option for a question, in order of appearance.",
        "For example: [\\"Option 1 text\\", \\"Option 2 text\\"]",
        "Do not include any other text, reasoning, or markdown fences (like ```json)."
      ].join(" ");
    }"""
    
    content = content.replace(old_prompt, new_prompt)

    # 2. Max completion tokens for multiple questions might need more than 200/300
    old_tokens = """if (mode === "mcq") {
      return isVerificationPass ? 300 : 200;
    }"""
    
    new_tokens = """if (mode === "mcq") {
      return isVerificationPass ? 1500 : 1000;
    }"""
    
    content = content.replace(old_tokens, new_tokens)

    # 3. Replace runHeadlessAskForMCQ and clickCorrectMCQOption
    # The old block starts at `async function runHeadlessAskForMCQ()` and ends right before `function getEditorTextSnapshot(el)`
    import re
    
    pattern = re.compile(r"async function runHeadlessAskForMCQ\(\) \{[\s\S]*?function clickCorrectMCQOption\(answer\) \{[\s\S]*?\}\n  \}\n", re.MULTILINE)
    
    new_mcq_functions = """async function runHeadlessAskForMCQ() {
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
              maxCompletionTokens: 1000,
              thinkingBudget: deepSolve ? 1024 : 0,
            })
          : await requestGroqWithKeyRotation(messages, {
              temperature: 0.1,
              maxCompletionTokens: 1000,
            });

      let reply = sanitizeReply(extractProviderText(provider, response.data) || "", mode);
      
      let answers = [];
      try {
        const jsonMatch = reply.match(/\\[.*\\]/s);
        if (jsonMatch) {
          answers = JSON.parse(jsonMatch[0]);
        } else {
          answers = JSON.parse(reply);
        }
      } catch (e) {
        answers = [reply];
      }
      
      debugHotkeyLog("mcq success", { answerCount: answers.length });
      return answers;
    } finally {
      STATE.isLoading = false;
    }
  }

  async function clickCorrectMCQOptions(answers) {
    if (!Array.isArray(answers) || answers.length === 0) return { success: false, reason: "Empty answers" };
    
    let clickedCount = 0;
    const clickedTexts = [];
    
    for (const answer of answers) {
      if (!answer || typeof answer !== "string" || answer.length < 1) continue;
      
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
          let levels = 0;
          while (clickable && clickable !== document.body && levels < 4) {
            candidates.push({ el: clickable, score, text });
            clickable = clickable.parentElement;
            levels++;
          }
        }
      }
      
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0].el;
        
        try {
          best.scrollIntoView({ behavior: "smooth", block: "center" });
          await sleep(600); // Wait for scroll
          best.click();
          const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window });
          const mouseup = new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window });
          best.dispatchEvent(mousedown);
          best.dispatchEvent(mouseup);
          
          clickedCount++;
          clickedTexts.push(candidates[0].text);
          await sleep(600); // Pause before finding next to mimic human behavior
        } catch (e) {
          console.warn("Failed to click:", e);
        }
      }
    }
    
    return { success: clickedCount > 0, clickedCount, clickedTexts };
  }
"""
    
    content = pattern.sub(new_mcq_functions, content)

    # 4. Update the event listener
    content = content.replace(
        '.then((reply) => clickCorrectMCQOption(reply))',
        '.then((answers) => clickCorrectMCQOptions(answers))'
    )

    with open("content.js", "w", encoding="utf-8") as f:
        f.write(content)
        
    print("Modification 2 complete")

if __name__ == "__main__":
    main()
