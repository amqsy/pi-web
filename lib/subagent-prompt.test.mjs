import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  buildSubagentPromptPlan,
  buildSubagentToolGuidelines,
} = await createJiti(import.meta.url).import("./subagent-prompt.ts");

test("a tool-free subagent uses only its profile as the exact system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Review carefully.",
    tools: [],
    task: "Inspect the parser.",
    inheritedParentContext: "Parent context",
  });

  assert.equal(plan.chatOnly, true);
  assert.equal(plan.exactSystemPrompt, "Review carefully.");
  assert.deepEqual(plan.appendSystemPrompt, ["Review carefully."]);
  assert.equal(plan.delegatedTask, "Inspect the parser.\n\nParent context");
});

test("a tool-enabled subagent retains inherited context and tool guidelines in its appended system prompt", () => {
  const plan = buildSubagentPromptPlan({
    profileSystemPrompt: "Explore carefully.",
    tools: ["read"],
    task: "Inspect the parser.",
    inheritedParentContext: "Parent context",
  });

  assert.equal(plan.chatOnly, false);
  assert.equal(plan.exactSystemPrompt, undefined);
  assert.equal(plan.appendSystemPrompt.length, 3);
  assert.equal(plan.appendSystemPrompt[0], "Explore carefully.");
  assert.match(plan.appendSystemPrompt[1], /文件读取（read）/);
  assert.equal(plan.appendSystemPrompt[2], "Parent context");
  assert.equal(plan.delegatedTask, "Inspect the parser.");
});

test("buildSubagentToolGuidelines injects only guidelines for authorized tools", () => {
  assert.equal(buildSubagentToolGuidelines([]), undefined);

  // Read only
  const readOnly = buildSubagentToolGuidelines(["read"]);
  assert.match(readOnly, /文件读取（read）/);
  assert.doesNotMatch(readOnly, /代码检索|文件修改|Shell 与环境/);

  // Explore tools (read, grep, find, ls)
  const exploreTools = buildSubagentToolGuidelines(["read", "grep", "find", "ls"]);
  assert.match(exploreTools, /文件读取（read）/);
  assert.match(exploreTools, /代码检索（grep\/find）/);
  assert.doesNotMatch(exploreTools, /文件修改|Shell 与环境|curl|Git Bash/);

  // General purpose tools (all)
  const allTools = buildSubagentToolGuidelines(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.match(allTools, /文件读取（read）/);
  assert.match(allTools, /代码检索（grep\/find）/);
  assert.match(allTools, /文件修改（edit\/write）/);
  assert.match(allTools, /Shell 与环境（bash）/);
  assert.match(allTools, /chcp 65001/);
  assert.match(allTools, /curl.exe/);
  assert.match(allTools, /temp/);
  assert.match(allTools, /uv venv/);
});

test("a resource-enabled tool-free subagent keeps the normal system prompt pipeline", () => {
  for (const resources of [
    { loadSkills: true, loadExtensions: false },
    { loadSkills: false, loadExtensions: true },
  ]) {
    const plan = buildSubagentPromptPlan({
      profileSystemPrompt: "Use loaded resources.",
      tools: [],
      ...resources,
      task: "Inspect the parser.",
      inheritedParentContext: "Parent context",
    });

    assert.equal(plan.chatOnly, false);
    assert.equal(plan.exactSystemPrompt, undefined);
    assert.deepEqual(plan.appendSystemPrompt, ["Use loaded resources.", "Parent context"]);
    assert.equal(plan.delegatedTask, "Inspect the parser.");
  }
});
