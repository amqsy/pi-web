import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("files route supports reveal request type", () => {
  assert.match(source, /const FILE_REQUEST_TYPES = \[.*"reveal".*\]/);
  assert.match(source, /if \(type === "reveal"\) \{/);
  assert.match(source, /revealFileInExplorer\(filePath\)/);
});

test("revealFileInExplorer handles win32, darwin, and linux", () => {
  const start = source.indexOf("function revealFileInExplorer");
  const end = source.indexOf("function createFileBodyStream", start);
  assert.notEqual(start, -1, "revealFileInExplorer not found");
  assert.notEqual(end, -1, "revealFileInExplorer end not found");
  const block = source.slice(start, end);

  assert.match(block, /process\.platform === "win32"/);
  assert.match(block, /SHOpenFolderAndSelectItems/);
  assert.match(block, /process\.platform === "darwin"/);
  assert.match(block, /spawn\("open", \["-R", target\]/);
  assert.match(block, /spawn\("xdg-open", \[path\.dirname\(target\)\]/);
});
