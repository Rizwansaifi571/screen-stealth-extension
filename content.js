// Screen Reader Extension - Stealth Mode
(function () {
  if (window.__screenReaderExtensionLoaded) return;
  window.__screenReaderExtensionLoaded = true;

  const GROQ_API_KEY = "";

  // ── Persistent state — survives minimize/expand cycles ──
  const STATE = {
    answerText: "",
    answerClass: "sr-answer",
    isLoading: false,
  };

  function getBodyText() {
    return (document.body?.innerText || "").trim();
  }

  function logBodyText() {
    const text = getBodyText();
    return text;
  }

  logBodyText();

  // ── Minimise helper (shared by button + outside click) ──
  function minimisePanel() {
    const panel = document.getElementById("__sr-panel");
    const tab   = document.getElementById("__sr-tab");
    if (!panel) return;

    panel.style.opacity   = "0";
    panel.style.transform = "translateY(-50%) translateX(110%)";
    setTimeout(() => {
      panel.remove();
      if (tab) tab.style.display = "block";
    }, 300);
  }

  // ── Inject stealth tab ───────────────────────────────────
  function injectTab() {
    if (document.getElementById("__sr-tab")) return;
    const tab = document.createElement("div");
    tab.id = "__sr-tab";
    tab.textContent = "ask";
    document.body.appendChild(tab);
    tab.addEventListener("click", expandPanel);
  }

  // ── Expand panel, restore previous answer ───────────────
  function expandPanel() {
    const tab = document.getElementById("__sr-tab");
    if (document.getElementById("__sr-panel")) return;

    if (tab) tab.style.display = "none";

    const panel = document.createElement("div");
    panel.id = "__sr-panel";
    panel.innerHTML = `
      <button class="sr-minimize" id="sr-minimize" title="Minimize">−</button>
      <div class="sr-body">
        <div class="sr-answer ${STATE.answerClass}" id="sr-answer"></div>
      </div>
      <div class="sr-footer">
        <button class="sr-ask-btn" id="sr-ask-btn">ask</button>
      </div>
    `;
    document.body.appendChild(panel);

    // Restore previous answer text
    const answerEl = panel.querySelector("#sr-answer");
    if (STATE.answerText) answerEl.textContent = STATE.answerText;

    // If we were mid-loading when minimised, restore loading state
    if (STATE.isLoading) {
      answerEl.className = "sr-answer sr-loading";
      panel.querySelector("#sr-ask-btn").disabled = true;
      panel.querySelector("#sr-ask-btn").textContent = "...";
    }

    // Minimize button
    panel.querySelector("#sr-minimize").addEventListener("click", (e) => {
      e.stopPropagation();
      minimisePanel();
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

      const bodyText = getBodyText().slice(0, 6000);

      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: "groq/compound-mini",
            // model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: "Answer the user's question concisely. Do NOT explain your reasoning."
              },
              {
                role: "user",
                content: `Here is the body text from a webpage:\n\n${bodyText}\n\nFilter out question in this page and Write only answer in minimum words possible. If it is a coding question answer code in javascript, else answer in minimum words possible`
              }
            ],
            max_tokens: 1000,
            temperature: 0.3
          })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err?.error?.message || "API error " + res.status);
        }

        const data = await res.json();
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

      } catch (e) {
        const liveAnswerEl = document.getElementById("sr-answer");
        if (liveAnswerEl) {
          liveAnswerEl.className = "sr-answer sr-error";
          liveAnswerEl.textContent = "Error: " + e.message;
        }
        STATE.answerText  = "Error: " + e.message;
        STATE.answerClass = "sr-answer sr-error";
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
        expandPanel();
        sendResponse({ visible: true });
      }
    }
    return true;
  });
})();
