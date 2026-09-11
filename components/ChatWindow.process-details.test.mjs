import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});

test("passes isStreaming to trailing assistant message during live tail and forwards through renderMessage", () => {
  assert.match(
    source,
    /const renderMessage = \(idx: number, options: \{[\s\S]*?isStreaming\?: boolean;[\s\S]*?\} = \{\}\)/,
  );
  assert.match(
    source,
    /<MessageView[\s\S]*?isStreaming=\{options\.isStreaming\}/,
  );
  assert.match(
    source,
    /const isTailStreaming = Boolean\(\s*streamState\.isStreaming &&\s*renderIdx === endIdx - 1 &&\s*msg\.role === "assistant" &&\s*!\(msg as AssistantMessage\)\.usage,?\s*\);/,
  );
  assert.match(
    source,
    /renderMessage\(renderIdx, isTailStreaming \? \{ isStreaming: true \} : undefined\)/,
  );
  assert.match(
    source,
    /<MessageView message=\{streamState\.streamingMessage as AgentMessage\} toolResults=\{toolResultsMap\} isStreaming\b/,
  );
});
