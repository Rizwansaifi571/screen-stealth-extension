// Paste Unblock – Force-enable paste on ALL platforms
// Runs at document_start so it intercepts before any page script can block paste.
(function () {
  "use strict";

  if (window.__pasteUnblockLoaded) return;
  window.__pasteUnblockLoaded = true;

  // ─── 1. Intercept addEventListener to neuter paste/copy/cut/contextmenu blocks ───
  const _origAddEventListener = EventTarget.prototype.addEventListener;
  const BLOCKED_EVENTS = new Set([
    "paste",
    "copy",
    "cut",
    "contextmenu",
    "beforepaste",
    "beforecopy",
    "beforecut",
  ]);

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (BLOCKED_EVENTS.has(type)) {
      // Wrap the listener: allow it to run but undo any preventDefault calls
      const wrappedListener = function (e) {
        // Create a proxy that silently ignores preventDefault for clipboard events
        const fakeEvent = new Proxy(e, {
          get(target, prop) {
            if (prop === "preventDefault") return () => {};
            if (prop === "stopPropagation") return () => {};
            if (prop === "stopImmediatePropagation") return () => {};
            if (prop === "returnValue") return true;
            const val = target[prop];
            return typeof val === "function" ? val.bind(target) : val;
          },
          set(target, prop, value) {
            if (prop === "returnValue") return true;
            target[prop] = value;
            return true;
          },
        });
        try {
          listener.call(this, fakeEvent);
        } catch (_) {
          // Ignore errors from page scripts
        }
      };
      return _origAddEventListener.call(this, type, wrappedListener, options);
    }
    return _origAddEventListener.call(this, type, listener, options);
  };

  // ─── 2. Override onpaste/oncopy/oncut/oncontextmenu setters to no-op ───
  const INLINE_HANDLERS = ["onpaste", "oncopy", "oncut", "oncontextmenu", "onbeforepaste", "onbeforecopy", "onbeforecut"];

  function neutralizeInlineHandlers(element) {
    for (const handler of INLINE_HANDLERS) {
      try {
        Object.defineProperty(element, handler, {
          get: () => null,
          set: () => true,
          configurable: true,
        });
      } catch (_) {
        // Some properties may not be configurable
      }
    }
  }

  // Override on HTMLElement and Document prototypes
  neutralizeInlineHandlers(HTMLElement.prototype);
  neutralizeInlineHandlers(Document.prototype);

  // ─── 3. Remove all inline onpaste/oncopy/oncut attributes from DOM once loaded ───
  function stripInlineAttributes() {
    const ATTRS_TO_REMOVE = [
      "onpaste", "oncopy", "oncut", "oncontextmenu",
      "onbeforepaste", "onbeforecopy", "onbeforecut",
      "ondragstart", "onselectstart",
    ];
    const allElements = document.querySelectorAll("*");
    for (const el of allElements) {
      for (const attr of ATTRS_TO_REMOVE) {
        if (el.hasAttribute(attr)) {
          el.removeAttribute(attr);
        }
      }
    }
  }

  // ─── 4. Re-enable right-click context menu ───
  function enableContextMenu() {
    document.addEventListener(
      "contextmenu",
      (e) => {
        e.stopImmediatePropagation();
      },
      true
    );
  }

  // ─── 5. Force-paste function – the nuclear option ───
  // This handles the actual paste when Ctrl+V is intercepted
  async function forcePaste(targetElement) {
    if (!targetElement) return false;

    let textToPaste = "";

    // Try to read from clipboard API
    try {
      textToPaste = await navigator.clipboard.readText();
    } catch (_) {
      // Clipboard API might be blocked; we'll still try execCommand
    }

    // Normalize poorly indented code if it looks like a raw code block
    if (textToPaste && textToPaste.includes('\n')) {
      const lines = textToPaste.split('\n');
      // If many lines have huge leading spaces, it might be corrupted by clipboard
      const excessiveSpace = lines.every(l => !l.trim() || l.startsWith('        '));
      if (excessiveSpace) {
        textToPaste = lines.map(l => l.replace(/^ {8}/, '')).join('\n');
      }
    }

    // Method 1: If we have clipboard text, insert it directly
    if (textToPaste) {
      if (insertTextIntoElement(targetElement, textToPaste)) {
        return true;
      }
    }

    // Method 2: execCommand('paste') – works on some browsers
    try {
      targetElement.focus();
      const success = document.execCommand("paste");
      if (success) return true;
    } catch (_) {}

    // Method 3: execCommand('insertText') with clipboard content
    if (textToPaste) {
      try {
        targetElement.focus();
        const success = document.execCommand("insertText", false, textToPaste);
        if (success) return true;
      } catch (_) {}
    }

    return false;
  }

  // Insert text into various element types
  function insertTextIntoElement(el, text) {
    if (!el || !text) return false;

    // Standard input/textarea
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      
      const newText = before + text + after;

      // React 15/16/17/18 swallows direct assignment to el.value. We must call the native setter bypassing React's override.
      let nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (el.tagName === "INPUT") {
        nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      }
      
      if (nativeSetter) {
        nativeSetter.call(el, newText);
      } else {
        el.value = newText;
      }
      
      const newCursor = start + text.length;
      el.selectionStart = newCursor;
      el.selectionEnd = newCursor;

      // Fire input and change events so frameworks (React, Angular, Vue) pick up the change
      const inputEvent = new Event("input", { bubbles: true, cancelable: true });
      // Attach a flag so mock testing environments can know we bypassed it legitimately
      inputEvent.detail = 'synthetic_bypass';
      el.dispatchEvent(inputEvent);
      
      el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      return true;
    }

    // ContentEditable elements (rich text editors, CodeMirror, Monaco, etc.)
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      // If it's a Monaco editor, the DOM insertion will break it. Let it fall back to synthetic paste event.
      if (el.closest && el.closest(".monaco-editor")) {
        try {
          el.focus();
          const success = document.execCommand("insertText", false, text);
          if (success) return true;
        } catch (_) {}
        return false; // Skip the generic contentEditable fallback
      }
      
      el.focus();

      // Try execCommand first for contenteditable
      try {
        const success = document.execCommand("insertText", false, text);
        if (success) return true;
      } catch (_) {}

      // Fallback: use Selection API
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        // Move cursor to end of inserted text
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);

        el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        return true;
      }

      // Last resort: append
      el.textContent += text;
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      return true;
    }

    return false;
  }

  // ─── 6. Keyboard listener – capture Ctrl+V BEFORE the page can block it ───
  document.addEventListener(
    "keydown",
    async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        const target = document.activeElement || e.target;

        // Don't interfere if paste is already working naturally
        // We detect this by checking if the target is a normal, unrestricted input
        if (isNativelyPasteable(target)) return;

        e.stopImmediatePropagation();
        e.preventDefault();

        await forcePaste(target);
      }
    },
    true // Capture phase – runs before ANY page listener
  );

  // Check if an element would normally accept paste without blocking
  function isNativelyPasteable(el) {
    if (!el) return false;

    // Our own extension elements – always pasteable, don't intercept
    if (el.closest && el.closest("#__sr-panel, #__sr-tab")) return true;

    // If the element has no paste-blocking signals, let browser handle it
    // But many OA platforms attach listeners dynamically, so we check common signals
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Check if readonly or disabled
      if (el.readOnly || el.disabled) return true; // Not our problem

      // Check for data attributes that signal paste blocking (common on OA platforms)
      if (el.dataset.noPaste || el.dataset.disablePaste) return false;

      // If there's an onpaste attribute on the element or ancestors, it's likely blocked
      let parent = el;
      while (parent && parent !== document.body) {
        if (parent.getAttribute("onpaste")) return false;
        parent = parent.parentElement;
      }
    }

    // For contenteditable, it's often blocked on OA platforms
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      return false; // Assume blocked on OA platforms, our force-paste is safe
    }

    // If the page has globally blocked paste (detected), don't consider pasteable
    if (window.__pasteWasBlocked) return false;

    return true;
  }

  // ─── 7. Detect if paste events are being blocked globally ───
  document.addEventListener(
    "paste",
    (e) => {
      // If this fires, paste is working – but check if defaultPrevented
      if (e.defaultPrevented) {
        window.__pasteWasBlocked = true;
      }
    },
    true
  );

  // ─── 8. Synthetic paste event dispatch (for Ctrl+V force) ───
  // Some editors only respond to paste events, not direct text insertion
  function dispatchSyntheticPaste(target, text) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });

      // Dispatch to target, but if it's Monaco, also dispatch to the parent wrapper
      target.dispatchEvent(pasteEvent);
      
      const parent = target.parentElement;
      if (parent) parent.dispatchEvent(pasteEvent);
      
    } catch (_) {
      // DataTransfer constructor might not be available
    }
  }

  // ─── 9. Override CSS that hides paste in context menus ───
  function injectAntiBlockCSS() {
    const style = document.createElement("style");
    style.textContent = `
      /* Re-enable text selection everywhere */
      * {
        -webkit-user-select: text !important;
        -moz-user-select: text !important;
        -ms-user-select: text !important;
        user-select: text !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ─── 10. MutationObserver – strip paste-blocking from dynamically added elements ───
  function observeDOM() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Strip inline handlers from new elements
          const ATTRS = [
            "onpaste", "oncopy", "oncut", "oncontextmenu",
            "onbeforepaste", "onbeforecopy", "onbeforecut",
          ];
          for (const attr of ATTRS) {
            if (node.hasAttribute && node.hasAttribute(attr)) {
              node.removeAttribute(attr);
            }
          }
          // Also check children
          if (node.querySelectorAll) {
            const children = node.querySelectorAll("*");
            for (const child of children) {
              for (const attr of ATTRS) {
                if (child.hasAttribute(attr)) {
                  child.removeAttribute(attr);
                }
              }
            }
          }
        }
      }
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } else {
      // document_start might not have documentElement yet
      const waitForDoc = setInterval(() => {
        if (document.documentElement) {
          clearInterval(waitForDoc);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
        }
      }, 10);
    }
  }

  // ─── 11. Enhanced Ctrl+Shift+V – Force paste with clipboard read ───
  // Backup hotkey in case Ctrl+V interception doesn't work
  document.addEventListener(
    "keydown",
    async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "V") {
        e.stopImmediatePropagation();
        e.preventDefault();

        const target = document.activeElement;
        if (!target) return;

        let text = "";
        try {
          text = await navigator.clipboard.readText();
        } catch (_) {
          return;
        }

        if (!text) return;

        // Try all methods
        if (insertTextIntoElement(target, text)) return;
        dispatchSyntheticPaste(target, text);
      }
    },
    true
  );

  // ─── 12. Override document.execCommand to un-block paste commands ───
  const _origExecCommand = document.execCommand.bind(document);
  document.execCommand = function (command, ...args) {
    // Allow paste/copy/cut commands to go through
    return _origExecCommand(command, ...args);
  };

  // ─── Init: Run when DOM is ready ───
  function init() {
    stripInlineAttributes();
    enableContextMenu();
    injectAntiBlockCSS();
    observeDOM();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Also run after full page load to catch late-loaded elements
  window.addEventListener("load", () => {
    setTimeout(stripInlineAttributes, 500);
    setTimeout(stripInlineAttributes, 2000);
  });
})();
