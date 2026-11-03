// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("Screen Reader Extension installed.");
});

// Monaco lives in the page's own JS world, so content scripts cannot configure it.
// Turn off its auto-closing / auto-indent while we type, then restore the user's settings.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action !== "monacoTypingMode" || !sender.tab?.id) return;

  chrome.scripting
    .executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      world: "MAIN",
      args: [Boolean(msg.enable)],
      func: (enable) => {
        const monacoApi = window.monaco;
        const editors = monacoApi?.editor?.getEditors?.() || [];
        if (!editors.length) return { ok: false, reason: "no-monaco" };

        // Prefer the editor that has focus, otherwise the first one
        const editor = editors.find((e) => e.hasTextFocus?.()) || editors[0];

        if (enable) {
          if (!window.__srMonacoPrev) {
            window.__srMonacoPrev = {
              autoClosingBrackets: editor.getOption(monacoApi.editor.EditorOption.autoClosingBrackets),
              autoClosingQuotes: editor.getOption(monacoApi.editor.EditorOption.autoClosingQuotes),
              autoClosingOvertype: editor.getOption(monacoApi.editor.EditorOption.autoClosingOvertype),
              autoIndent: editor.getOption(monacoApi.editor.EditorOption.autoIndent),
              autoSurround: editor.getOption(monacoApi.editor.EditorOption.autoSurround),
              formatOnType: editor.getOption(monacoApi.editor.EditorOption.formatOnType),
              suggestOnTriggerCharacters: editor.getOption(
                monacoApi.editor.EditorOption.suggestOnTriggerCharacters
              ),
              quickSuggestions: editor.getOption(monacoApi.editor.EditorOption.quickSuggestions),
              acceptSuggestionOnEnter: editor.getOption(
                monacoApi.editor.EditorOption.acceptSuggestionOnEnter
              ),
            };
          }
          editor.updateOptions({
            autoClosingBrackets: "never",
            autoClosingQuotes: "never",
            autoClosingOvertype: "never",
            autoSurround: "never",
            autoIndent: "none",
            formatOnType: false,
            suggestOnTriggerCharacters: false,
            quickSuggestions: false,
            acceptSuggestionOnEnter: "off",
          });
          window.__srMonacoEditor = editor;
          return { ok: true };
        }

        const prev = window.__srMonacoPrev;
        const target = window.__srMonacoEditor || editor;
        if (prev && target) {
          const autoIndentNames = ['none', 'keep', 'brackets', 'advanced', 'full'];
          target.updateOptions({
            autoClosingBrackets: prev.autoClosingBrackets,
            autoClosingQuotes: prev.autoClosingQuotes,
            autoClosingOvertype: prev.autoClosingOvertype,
            autoSurround: prev.autoSurround,
            autoIndent:
              typeof prev.autoIndent === 'number'
                ? autoIndentNames[prev.autoIndent] || 'advanced'
                : prev.autoIndent,
            formatOnType: prev.formatOnType,
            suggestOnTriggerCharacters: prev.suggestOnTriggerCharacters,
            quickSuggestions: prev.quickSuggestions,
            acceptSuggestionOnEnter: prev.acceptSuggestionOnEnter,
          });
        }
        window.__srMonacoPrev = null;
        window.__srMonacoEditor = null;
        return { ok: true };
      },
    })
    .then((results) => sendResponse(results?.[0]?.result || { ok: false }))
    .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));

  return true;
});
