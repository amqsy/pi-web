import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = lines\.length > SOURCE_HIGHLIGHT_MAX_LINES;/);

  const lightweightStart = source.indexOf(") : useLightweightSource ? (");
  const syntaxStart = source.indexOf("<SyntaxHighlighter", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(syntaxStart, -1);

  const lightweightSource = source.slice(lightweightStart, syntaxStart);
  assert.match(lightweightSource, /className="file-source-view is-lightweight"/);
  assert.match(lightweightSource, /lines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);
});

test("FileViewer provides OpenInExplorerButton alongside DownloadLink in all four viewers", () => {
  assert.match(source, /function OpenInExplorerButton/);
  assert.match(source, /getFileApiUrl\(filePath, "reveal", sourceSessionId\)/);
  assert.match(source, /i18n\.openInExplorer/);
  assert.match(source, /i18n\.openedInExplorer/);
  assert.match(source, /i18n\.openInExplorerFailed/);

  const matches = [...source.matchAll(/<OpenInExplorerButton filePath=\{filePath\} sourceSessionId=\{sourceSessionId\} \/>/g)];
  assert.equal(matches.length, 4, "OpenInExplorerButton should appear in all 4 viewer implementations");
});

