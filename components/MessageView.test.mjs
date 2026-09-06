import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  ThinkingBlock,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitFinalAssistantBlocks } = await jiti.import("@/lib/message-display");
const { THINKING_EXPANDED_EVENT } = await jiti.import("@/lib/thinking-expansion-preference");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(MessageView.compare(props, { ...props, writtenFiles: [{ path: "/tmp/result.txt" }] }), false);
});

test("previews the first thinking line and reveals the full text with the saved default", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "**Independent reasoning**\n\nDetailed second line." },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      assert.equal((html.match(/>[^<]*Independent reasoning[^<]*</g) ?? []).length, 1);
      assert.equal(html.includes("Detailed second line."), expanded);
      assert.match(html, /aria-label="Thinking: /);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shows deferred thinking previews without loading the full content", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Historical first line", deferred: true }],
  });
  assert.match(html, />Historical first line<\/span>/);
  assert.match(html, /aria-expanded="false"/);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal((html.match(/data-search-target="true"/g) ?? []).length, content.includes(searchBlock) ? 1 : 0);
      if (content.includes(searchBlock)) {
        assert.match(html, new RegExp(`data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`));
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="Open sub-agent session"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Select this response" }],
  }, { entryId: "assistant-entry" });

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("auto-expands thinking block when streaming", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [{ type: "thinking", thinking: "Analyzing the repository structure..." }],
  }, { isStreaming: true });

  assert.match(html, /Thinking/);
  assert.match(html, /Analyzing the repository structure\.\.\./);
});

test("shows thinking placeholder when streaming without text yet", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [{ type: "thinking", thinking: "" }],
  }, { isStreaming: true });

  assert.match(html, /Thinking\.\.\./);
});

test("collapses thinking block by default when loaded completed", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [{ type: "thinking", thinking: "First summary line.\n\nFinished reasoning about the task." }],
  }, { isStreaming: false });

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /First summary line/);
  assert.doesNotMatch(html, /Finished reasoning about the task\./);
});

test("shows token estimate badge only while actively streaming", () => {
  const streamingHtml = renderMessage({
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [{ type: "text", text: "Hello world this is a test response." }],
  }, { isStreaming: true });
  assert.match(streamingHtml, /Estimated token count while streaming/);

  const completedHtml = renderMessage({
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [{ type: "text", text: "Hello world this is a test response." }],
  }, { isStreaming: false });
  assert.doesNotMatch(completedHtml, /Estimated token count while streaming/);
});

test("shows token estimate badge during streaming even when usage object is initialized, and switches to official usage upon completion", () => {
  const messageWithUsage = {
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [{ type: "text", text: "Hello world this is a test response." }],
    usage: {
      input: 120,
      output: 45,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.001 },
    },
  };

  const streamingHtml = renderMessage(messageWithUsage, { isStreaming: true });
  assert.match(streamingHtml, /Estimated token count while streaming/);
  assert.doesNotMatch(streamingHtml, /120 in · 45 out/);

  const completedHtml = renderMessage(messageWithUsage, { isStreaming: false });
  assert.doesNotMatch(completedHtml, /Estimated token count while streaming/);
  assert.match(completedHtml, /120 in · 45 out/);
});

test("shows token estimate badge while model is thinking during streaming", () => {
  const thinkingMessage = {
    role: "assistant",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    content: [{ type: "thinking", thinking: "Let me think about how to solve this problem carefully..." }],
    usage: {
      input: 80,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };

  const html = renderMessage(thinkingMessage, { isStreaming: true });
  assert.match(html, /Estimated token count while streaming/);
});

test("keeps edit tool calls expanded by default while other tools remain collapsed", () => {
  const editBlock = {
    type: "toolCall",
    toolCallId: "call-edit-1",
    toolName: "edit",
    input: { path: "src/index.ts" },
  };
  const editResult = {
    role: "toolResult",
    toolCallId: "call-edit-1",
    content: [{ type: "text", text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new" }],
  };

  const grepBlock = {
    type: "toolCall",
    toolCallId: "call-grep-1",
    toolName: "grep",
    input: { path: "src" },
  };
  const grepResult = {
    role: "toolResult",
    toolCallId: "call-grep-1",
    content: [{ type: "text", text: "matched line" }],
  };

  const html = renderMessage({
    role: "assistant",
    provider: "google",
    model: "gemini-3.7-flash",
    content: [editBlock, grepBlock],
  }, {
    toolResults: new Map([
      ["call-edit-1", editResult],
      ["call-grep-1", grepResult],
    ]),
  });

  // Edit tool diff should be rendered (expanded)
  assert.match(html, /new/);
  // Grep tool result text should NOT be rendered (collapsed)
  assert.doesNotMatch(html, /matched line/);
});

function createThinkingBlockHarness() {
  let hookIndex = 0;
  const hooks = [];
  const prevDeps = [];
  const cleanups = [];
  const pendingEffects = [];
  let currentProps = null;
  let latestOutput = null;
  let isRendering = false;
  let needsRerender = false;

  const dispatcher = {
    useState(initial) {
      const i = hookIndex++;
      if (hooks[i] === undefined) {
        hooks[i] = typeof initial === "function" ? initial() : initial;
      }
      const setState = (val) => {
        const next = typeof val === "function" ? val(hooks[i]) : val;
        if (hooks[i] !== next) {
          hooks[i] = next;
          if (isRendering) {
            needsRerender = true;
          } else {
            renderCycle();
          }
        }
      };
      return [hooks[i], setState];
    },
    useRef(initial) {
      const i = hookIndex++;
      if (hooks[i] === undefined) {
        hooks[i] = { current: initial };
      }
      return hooks[i];
    },
    useEffect(effect, deps) {
      const i = hookIndex++;
      const oldDeps = prevDeps[i];
      let hasChanged = true;
      if (oldDeps && deps) {
        hasChanged = deps.some((d, idx) => !Object.is(d, oldDeps[idx]));
      }
      if (hasChanged) {
        prevDeps[i] = deps;
        pendingEffects.push({ index: i, effect });
      }
    },
    useContext() {
      return { t: (k) => k };
    },
    useMemo(fn) {
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
  };

  function renderCycle() {
    let passes = 0;
    do {
      needsRerender = false;
      isRendering = true;
      hookIndex = 0;
      const prevDispatcher = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
      try {
        latestOutput = ThinkingBlock(currentProps);
      } finally {
        React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = prevDispatcher;
        isRendering = false;
      }

      const effectsToRun = pendingEffects.splice(0, pendingEffects.length);
      for (const { index, effect } of effectsToRun) {
        cleanups[index]?.();
        cleanups[index] = effect();
      }
      passes++;
    } while (needsRerender && passes < 10);
    return latestOutput;
  }

  return {
    mount(props) {
      currentProps = props;
      return renderCycle();
    },
    update(props) {
      currentProps = props;
      return renderCycle();
    },
    getExpanded: () => Boolean(latestOutput.props.children[0].props["aria-expanded"]),
    toggle: () => {
      latestOutput.props.children[0].props.onClick();
    },
    getUserInteracted: () => hooks[4]?.current,
    unmount: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}

test("auto-collapses thinking block when streaming completes if user has not interacted", () => {
  const previousWindow = globalThis.window;
  try {
    let preference = "false";
    const listeners = new Map();
    globalThis.window = {
      localStorage: {
        getItem: () => preference,
        setItem: (_, val) => { preference = String(val); },
        removeItem: () => {},
      },
      addEventListener: (type, handler) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
      },
      removeEventListener: (type, handler) => {
        listeners.get(type)?.delete(handler);
      },
      dispatchEvent: (event) => {
        for (const handler of listeners.get(event.type) || []) handler(event);
        return true;
      },
    };

    // 1. When streaming, thinking block is auto-expanded
    const harness = createThinkingBlockHarness();
    harness.mount({
      block: { type: "thinking", thinking: "Deep reasoning step 1\nDeep reasoning step 2" },
      blockIndex: 0,
      isStreaming: true,
    });
    assert.equal(harness.getExpanded(), true, "Thinking block should be expanded while streaming");

    // 2. When streaming completes without user interaction, it automatically collapses
    harness.update({
      block: { type: "thinking", thinking: "Deep reasoning step 1\nDeep reasoning step 2" },
      blockIndex: 0,
      isStreaming: false,
    });
    assert.equal(harness.getExpanded(), false, "Thinking block should auto-collapse when streaming finishes without manual intervention");

    // 3. User manually interacts during streaming
    const interactiveHarness = createThinkingBlockHarness();
    interactiveHarness.mount({
      block: { type: "thinking", thinking: "Deep reasoning step 1\nDeep reasoning step 2" },
      blockIndex: 0,
      isStreaming: true,
    });
    assert.equal(interactiveHarness.getExpanded(), true);

    // User toggles to collapse, then toggles to expand
    interactiveHarness.toggle(); // user collapsed it
    assert.equal(interactiveHarness.getExpanded(), false);
    interactiveHarness.toggle(); // user re-expanded it
    assert.equal(interactiveHarness.getExpanded(), true);

    // Streaming completes - should preserve user's manual choice (remains expanded)
    interactiveHarness.update({
      block: { type: "thinking", thinking: "Deep reasoning step 1\nDeep reasoning step 2" },
      blockIndex: 0,
      isStreaming: false,
    });
    assert.equal(interactiveHarness.getExpanded(), true, "Should keep manual user toggle state when streaming finishes");

    // 4. Preference event resets manual intervention and updates state
    preference = "false";
    globalThis.window.dispatchEvent({ type: THINKING_EXPANDED_EVENT });
    assert.equal(interactiveHarness.getExpanded(), false, "Should update to default preference on THINKING_EXPANDED_EVENT");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("thinking block implementation contract for auto-collapse on stream completion", async () => {
  const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  const thinkingBlockStart = source.indexOf("export function ThinkingBlock");
  const thinkingBlockEnd = source.indexOf("function isSubagentToolDetails", thinkingBlockStart);
  const thinkingBlockSource = source.slice(thinkingBlockStart, thinkingBlockEnd);

  // userInteractedRef tracks manual user interaction
  assert.match(thinkingBlockSource, /const userInteractedRef = useRef\(false\);/);

  // toggle marks userInteractedRef.current = true
  assert.match(thinkingBlockSource, /const toggle = \(\) => \{\s*userInteractedRef\.current = true;\s*setExpanded\(\(v\) => !v\);/);
  assert.match(thinkingBlockSource, /onClick=\{toggle\}/);

  // useEffect on isStreaming auto-expands and auto-collapses
  assert.match(
    thinkingBlockSource,
    /useEffect\(\(\) => \{\s*if \(isStreaming === true\) \{\s*userInteractedRef\.current = false;\s*setExpanded\(true\);\s*\} else if \(isStreaming === false\) \{\s*if \(!userInteractedRef\.current\) \{\s*setExpanded\(isThinkingExpandedByDefault\(\)\);\s*\}\s*\}\s*\}, \[isStreaming\]\);/,
  );

  // THINKING_EXPANDED_EVENT resets userInteractedRef.current and updates state
  assert.match(
    thinkingBlockSource,
    /const onChange = \(\) => \{\s*userInteractedRef\.current = false;\s*setExpanded\(Boolean\(isStreaming \|\| isThinkingExpandedByDefault\(\)\)\);\s*\};/,
  );
});
