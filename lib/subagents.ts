import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dump as stringifyYaml } from "js-yaml";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { parseFrontmatter } from "./frontmatter";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots } from "./path-security";
import { PRESET_READ_ONLY } from "./tool-presets";
import type { SessionEntry, SubagentSessionStatus } from "./types";

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";
export const SUBAGENT_CONTROL_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

export type SubagentStatus = SubagentSessionStatus;
export type SubagentScope = "builtin" | "global" | "workspace" | "project";
export type SubagentWritableScope = Extract<SubagentScope, "global" | "project">;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
}

export interface SubagentMetadata {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  createdAt: string;
  resourceSnapshot: SubagentResourceSnapshot;
}

export interface SubagentResourceSnapshot {
  version: 1;
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
}

export interface SubagentSessionResources {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
}

export interface SubagentResultMetadata {
  version: 1;
  status: Exclude<SubagentStatus, "starting" | "running" | "interrupted">;
  completedAt: string;
  result?: string;
  error?: string;
}

export interface SubagentRunInfo {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  status: SubagentStatus;
  createdAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set(DEFAULT_TOOLS);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "general-purpose",
    displayName: "General purpose",
    description: "Autonomous task execution. Handle focused implementations, multi-step changes, or deep investigation in an isolated context",
    systemPrompt: `Work autonomously on the delegated task.

【Strict Output Contract / 输出契约】
Your final response MUST follow this structured format strictly:
1. 执行结论: 明确说明成功/失败及产物路径。
2. 核心操作与测试验证结果: 列出主要操作与命令/测试验证结果。`,
    tools: DEFAULT_TOOLS,
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "explore",
    displayName: "Explore",
    description: "Fast read-only exploration. Search across files and locate symbols without polluting main context. Returns strictly: key file paths, symbols/lines, and summary",
    systemPrompt: `Explore the codebase to answer the delegated question. Do not modify files.

【Strict Output Contract / 输出契约】
Your final response MUST follow this structured format strictly:
1. 核心结论 (Summary): 1~2 句话直接回答核心问题，严禁无意义客套与铺垫。
2. 关键文件与位置 (Key Locations):
   - 必须精确列出文件路径与关键符号/行号（格式如 path/to/file.ts:42，包含函数/类/字段名）。
   - 每个位置简述其核心职责。
3. 关键依赖与调用流 (Call Flow & Dependencies): 用简洁要点说明调用链或数据流向。`,
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Design an implementation-ready plan before editing files. Returns strictly: target files, atomic steps, risks, and verification commands",
    systemPrompt: `Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files.

【Strict Output Contract / 输出契约】
Your final response MUST follow this structured format strictly:
1. 方案核心目标 (Objective): 1 句话阐明实现目标与核心思路。
2. 目标文件修改清单 (Target Files):
   - 精确列出每个需要新增（Create）、修改（Modify）或删除（Delete）的文件路径及对应行号/函数。
3. 原子化分步实施步骤 (Step-by-Step Execution Plan):
   - 按依赖顺序排列的实施步骤，每步明确具体改动逻辑与工具。`,
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "builtin",
  },
];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseTools(value: unknown, fallback: string[]): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const tools = values.map((item) => String(item).trim()).filter(Boolean);
  if (tools.includes("none")) return [];
  if (tools.includes("all") || tools.includes("*")) return [...DEFAULT_TOOLS];
  if (tools.length === 0) return [...fallback];
  return [...new Set(tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
}

function parseProfileFile(filePath: string, scope: SubagentScope): SubagentProfile | null {
  try {
    const source = readFileSync(filePath, "utf8");
    const { data, rest } = parseFrontmatter(source);
    const name = basename(filePath, ".md");
    const thinkingValue = stringValue(data?.thinking) as ThinkingLevel | undefined;
    const maxTurnsValue = typeof data?.max_turns === "number" ? Math.floor(data.max_turns) : undefined;
    const tools = parseTools(data?.tools, DEFAULT_TOOLS);
    const disallowedTools = new Set(parseTools(data?.disallowed_tools, []));
    return {
      name,
      displayName: stringValue(data?.display_name) ?? name,
      description: stringValue(data?.description) ?? name,
      systemPrompt: rest.trim(),
      tools: tools.filter((tool) => !disallowedTools.has(tool)),
      loadSkills: booleanValue(data?.load_skills, false),
      loadExtensions: booleanValue(data?.load_extensions, false),
      ...(stringValue(data?.model) ? { model: stringValue(data?.model) } : {}),
      ...(thinkingValue && THINKING_LEVELS.has(thinkingValue) ? { thinking: thinkingValue } : {}),
      ...(maxTurnsValue && maxTurnsValue > 0 ? { maxTurns: maxTurnsValue } : {}),
      inheritContext: booleanValue(data?.inherit_context, false),
      runInBackground: booleanValue(data?.run_in_background, false),
      enabled: booleanValue(data?.enabled, true),
      scope,
      filePath,
    };
  } catch {
    return null;
  }
}

function isProjectProfilePathAllowed(cwd: string, target: string): boolean {
  return isExistingPathWithinRoots(target, new Set([cwd]));
}

function readProfileDirectory(dir: string, scope: SubagentScope, cwd: string): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  if (scope !== "global" && !isProjectProfilePathAllowed(cwd, dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => parseProfileFile(join(dir, entry.name), scope))
    .filter((profile): profile is SubagentProfile => profile !== null);
}

function profileDirectories(cwd: string): Array<[string, Exclude<SubagentScope, "builtin">]> {
  return [
    [join(getAgentDir(), "agents"), "global"],
    [join(resolve(cwd), ".agents", "agents"), "workspace"],
    [join(resolve(cwd), ".pi", "agents"), "project"],
  ];
}

/** Every configured source, including profiles shadowed by a higher-precedence scope. */
export function listSubagentProfileSources(cwd: string): SubagentProfile[] {
  const profiles = BUILTIN_PROFILES.map((profile) => ({ ...profile, tools: [...profile.tools] }));
  for (const [dir, scope] of profileDirectories(cwd)) {
    profiles.push(...readProfileDirectory(dir, scope, cwd));
  }
  return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function listSubagentProfiles(cwd: string): SubagentProfile[] {
  const byName = new Map(BUILTIN_PROFILES.map((profile) => [profile.name.toLowerCase(), { ...profile, tools: [...profile.tools] }]));
  for (const [dir, scope] of profileDirectories(cwd)) {
    for (const profile of readProfileDirectory(dir, scope, cwd)) byName.set(profile.name.toLowerCase(), profile);
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSubagentProfile(cwd: string, name: string): SubagentProfile | undefined {
  return listSubagentProfiles(cwd).find((profile) => profile.name.toLowerCase() === name.trim().toLowerCase() && profile.enabled);
}

function assertProfileName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error("Agent name may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function writableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  if (scope === "global") return join(getAgentDir(), "agents");
  if (scope === "project") return join(resolve(cwd), ".pi", "agents");
  throw new Error("Agent scope must be global or project");
}

function assertWritableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = writableProfileDirectory(cwd, scope);
  if (scope === "global") return dir;

  let existingAncestor = dir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Agent profile directory is outside the project root");
    existingAncestor = parent;
  }
  if (!isProjectProfilePathAllowed(cwd, existingAncestor)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  return dir;
}

export function saveSubagentProfile(
  cwd: string,
  scope: SubagentWritableScope,
  profile: Omit<SubagentProfile, "scope" | "filePath">,
): SubagentProfile {
  const name = assertProfileName(profile.name);
  const tools = [...new Set(profile.tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
  if (profile.thinking && !THINKING_LEVELS.has(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  if (profile.maxTurns !== undefined && (!Number.isFinite(profile.maxTurns) || profile.maxTurns < 0)) {
    throw new Error("Max turns must be a non-negative number");
  }
  const maxTurns = profile.maxTurns && profile.maxTurns > 0
    ? Math.floor(profile.maxTurns)
    : undefined;
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  const loadSkills = profile.loadSkills === true;
  const loadExtensions = profile.loadExtensions === true;
  const dir = assertWritableProfileDirectory(cwd, scope);
  mkdirSync(dir, { recursive: true });
  if (scope === "project" && !isProjectProfilePathAllowed(cwd, dir)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  const filePath = join(dir, `${name}.md`);
  const frontmatter: Record<string, unknown> = {
    description,
    display_name: displayName,
    tools: tools.length > 0 ? tools.join(", ") : "none",
    load_skills: loadSkills,
    load_extensions: loadExtensions,
    enabled: profile.enabled,
    inherit_context: profile.inheritContext,
    run_in_background: profile.runInBackground,
  };
  if (model) frontmatter.model = model;
  if (profile.thinking) frontmatter.thinking = profile.thinking;
  if (maxTurns) frontmatter.max_turns = maxTurns;
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  writePrivateFileAtomicSync(filePath, `---\n${yaml}\n---\n\n${systemPrompt}\n`);
  return {
    ...profile,
    name,
    displayName,
    description,
    systemPrompt,
    tools,
    loadSkills,
    loadExtensions,
    ...(model ? { model } : { model: undefined }),
    ...(maxTurns ? { maxTurns } : { maxTurns: undefined }),
    scope,
    filePath,
  };
}

export function deleteSubagentProfile(cwd: string, scope: SubagentWritableScope, name: string): void {
  const safeName = assertProfileName(name);
  const filePath = join(assertWritableProfileDirectory(cwd, scope), `${safeName}.md`);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function saveProjectSubagentProfile(cwd: string, profile: Omit<SubagentProfile, "scope" | "filePath">): SubagentProfile {
  return saveSubagentProfile(cwd, "project", profile);
}

export function deleteProjectSubagentProfile(cwd: string, name: string): void {
  deleteSubagentProfile(cwd, "project", name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ValidSubagentMetadataData = Record<string, unknown> & {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
};

function subagentMetadataData(entries: readonly SessionEntry[]): ValidSubagentMetadataData | null {
  const metaEntry = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (!metaEntry || metaEntry.type !== "custom" || !isRecord(metaEntry.data)) return null;
  const data = metaEntry.data;
  if (data.version !== 1 || typeof data.parentSessionId !== "string" || typeof data.parentSessionPath !== "string") return null;
  return data as ValidSubagentMetadataData;
}

/** Restore the isolated prompt and tool scope used by a persisted subagent session. */
export function readSubagentSessionResources(
  entries: readonly SessionEntry[],
): SubagentSessionResources | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  const loadSkills = isRecord(snapshot) && snapshot.loadSkills === true;
  const loadExtensions = isRecord(snapshot) && snapshot.loadExtensions === true;
  if (
    isRecord(snapshot)
    && snapshot.version === 1
    && Array.isArray(snapshot.appendSystemPrompt)
    && snapshot.appendSystemPrompt.every((item) => typeof item === "string")
    && Array.isArray(snapshot.tools)
    && snapshot.tools.every((item) =>
      typeof item === "string"
      && item.length > 0
      && !SUBAGENT_CONTROL_TOOLS.has(item)
      && (BUILTIN_TOOLS.has(item) || loadExtensions)
    )
  ) {
    return {
      appendSystemPrompt: [...snapshot.appendSystemPrompt],
      tools: [...new Set(snapshot.tools)],
      loadSkills,
      loadExtensions,
    };
  }
  return null;
}

export function withSubagentExtensionTools(
  profileTools: readonly string[],
  extensionToolNames: Iterable<string>,
): string[] {
  return [...new Set([
    ...profileTools,
    ...[...extensionToolNames].filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name)),
  ])];
}

export function readSubagentRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string): SubagentRunInfo | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const resultEntry = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RESULT_TYPE);
  const result = resultEntry?.type === "custom" && isRecord(resultEntry.data) ? resultEntry.data : undefined;
  const persistedStatus = result && (result.status === "completed" || result.status === "failed" || result.status === "aborted")
    ? result.status
    : "interrupted";
  return {
    sessionId,
    sessionPath,
    parentSessionId: data.parentSessionId,
    parentToolCallId: typeof data.parentToolCallId === "string" ? data.parentToolCallId : "",
    profile: typeof data.profile === "string" ? data.profile : "general-purpose",
    description: typeof data.description === "string" ? data.description : "Subagent",
    task: typeof data.task === "string" ? data.task : "",
    runInBackground: data.runInBackground === true,
    status: persistedStatus,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(result && typeof result.completedAt === "string" ? { completedAt: result.completedAt } : {}),
    ...(result && typeof result.result === "string" ? { result: result.result } : {}),
    ...(result && typeof result.error === "string" ? { error: result.error } : {}),
  };
}
