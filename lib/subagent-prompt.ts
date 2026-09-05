export interface SubagentPromptPlan {
  chatOnly: boolean;
  appendSystemPrompt: string[];
  delegatedTask: string;
  exactSystemPrompt?: string;
}

export function buildSubagentToolGuidelines(tools: readonly string[]): string | undefined {
  if (tools.length === 0) return undefined;
  const toolSet = new Set(tools);
  const items: string[] = [];

  if (toolSet.has("read")) {
    items.push(
      "* **文件读取（read）**：大文件定位后，必须使用 read 的 offset/limit 只读取命中行及上下文（如前后 30-50 行），严禁无脑全量读取；工作区外已知路径的确定文件直接 read，不要先执行 ls 探测。",
    );
  }

  if (toolSet.has("grep") || toolSet.has("find")) {
    items.push(
      "* **代码检索（grep/find）**：内置 grep 支持正则，多词 OR 匹配直接使用 pattern1|pattern2；在 Bash 中检索必须使用 rg，禁止使用系统 grep。",
    );
  }

  if (toolSet.has("edit") || toolSet.has("write")) {
    items.push(
      "* **文件修改（edit/write）**：用 edit 做精确替换，oldText 取最小唯一片段；同一文件多处修改合并为一次 edit 调用，不要拆成多次。",
    );
  }

  if (toolSet.has("bash")) {
    items.push(
      "* **Shell 与环境（bash）**：宿主系统为 Windows 11，工具 Shell 为 Git Bash (MSYS2 / MINGW64)，命令一律使用 bash 语法；禁止使用 cmd 内部命令及 PowerShell cmdlet。",
      "* **cmd 调用防乱码**：涉及 cmd.exe //c 调用时，先切代码页：cmd.exe //c \"chcp 65001>nul && 实际命令...\"，避免中文乱码。",
      "* **curl 绝对路径**：优先使用 Windows 自带绝对路径：C:/Windows/System32/curl.exe。",
      "* **网络代理**：需要代理时设置 export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890。",
      "* **临时文件**：一律创建在当前工作目录的 ./temp/ 子目录，禁止使用 %TEMP% 或 /tmp。临时目录不存在时先 mkdir -p temp。",
      "* **Python 与虚拟环境**：需用到隔离环境时在 ./temp/ 下按需创建 uv venv ./temp/.venv --python 3.12，使用 uv pip install 安装依赖；stdout 涉及中文时执行前 export PYTHONIOENCODING=utf-8。",
    );
  }

  if (items.length === 0) return undefined;
  return `## 工具操作规范（Tool Usage Guidelines）\n${items.join("\n")}`;
}

export function buildSubagentPromptPlan(options: {
  profileSystemPrompt: string;
  tools: readonly string[];
  loadSkills?: boolean;
  loadExtensions?: boolean;
  task: string;
  inheritedParentContext?: string;
}): SubagentPromptPlan {
  const chatOnly = options.tools.length === 0 && !options.loadSkills && !options.loadExtensions;
  const appendSystemPrompt = [options.profileSystemPrompt];
  const toolGuidelines = buildSubagentToolGuidelines(options.tools);
  if (toolGuidelines) {
    appendSystemPrompt.push(toolGuidelines);
  }
  if (options.inheritedParentContext && !chatOnly) {
    appendSystemPrompt.push(options.inheritedParentContext);
  }
  return {
    chatOnly,
    appendSystemPrompt,
    delegatedTask: options.inheritedParentContext && chatOnly
      ? `${options.task}\n\n${options.inheritedParentContext}`
      : options.task,
    ...(chatOnly ? { exactSystemPrompt: options.profileSystemPrompt } : {}),
  };
}
