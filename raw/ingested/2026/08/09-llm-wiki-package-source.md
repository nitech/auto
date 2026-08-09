---
title: llm-wiki package (installed in Auto)
type: code-snippet
source: node_modules/llm-wiki
---

# llm-wiki npm package

Version: 0.1.3
Description: An LLM-powered personal wiki CLI. Incrementally build and query a persistent, interlinked wiki from your raw sources.
Bin: wiki -> dist/bin/wiki.js
Node: >=22.0.0

## README

# llm-wiki

[![npm version](https://img.shields.io/npm/v/llm-wiki.svg)](https://www.npmjs.com/package/llm-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

**An LLM-powered personal wiki CLI.** Inspired by [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) â€“ instead of re-discovering knowledge from raw documents on every query, this tool incrementally builds and maintains a persistent, interlinked wiki where knowledge is compiled once, kept current, and grows smarter over time.

```
Traditional RAG:  You ask â†’ AI searches fragments â†’ temporary answer â†’ no accumulation

LLM Wiki:         You add source
                      â†“ wiki ingest
                  LLM permanently integrates into wiki
                      â†“ wiki query
                  Synthesised answer with citations from your own knowledge base
```

---

## âœ¨ Features

| | Feature | Description |
|---|---|---|
| ðŸ“¥ | **Smart Ingestion** | Add raw material; LLM integrates it into structured wiki pages with citations |
| ðŸ”— | **Automatic Linking** | Cross-links new knowledge with existing pages |
| ðŸ” | **Multi-Step Retrieval** | Iterative ReAct agent that dives into source files for deep answers |
| ðŸ©º | **Wiki Lint** | Detects orphans, dead links, contradictions, shallow pages, and missing concepts |
| ðŸ—‚ï¸ | **List Tools** | Browse raw sources, wiki pages, and backlinks |
| ðŸ“„ | **Zero Lock-in** | Pure Markdown; works with Obsidian, VS Code, or any editor |
| ðŸ¤– | **OpenAI-compatible** | Works with OpenAI, Anthropic (via proxy), DeepSeek, Ollama, and any OpenAI-compatible API |

---

## ðŸš€ Installation

Requires **Node.js 22+**.

```bash
npm install -g llm-wiki
```

Or with pnpm:
```bash
pnpm add -g llm-wiki
```

---

## âš™ï¸ Configuration

Run `wiki init` inside any directory to scaffold the wiki structure and generate a `.wikirc.yaml` template:

```bash
mkdir my-wiki && cd my-wiki
wiki init
```

Edit `.wikirc.yaml` (auto-added to `.gitignore` to protect your API key):

```yaml
# LLM Provider Configuration
llm:
  provider: openai
  model: gpt-4o
  apiKey: YOUR_API_KEY_HERE
  baseUrl: https://api.openai.com/v1  # Change for proxies or other providers
  temperature: 0.3
  thinking:
    type: disabled  # Set to 'enabled' for reasoning models (e.g. o1, o3)
```

**Using DeepSeek / other providers:**
```yaml
llm:
  model: deepseek-chat
  apiKey: YOUR_DEEPSEEK_KEY
  baseUrl: https://api.deepseek.com/v1
```

---

## ðŸ“ Directory Structure

After `wiki init`, your wiki directory will look like:

```
my-wiki/
â”œâ”€â”€ .wikirc.yaml          â† Config (gitignored)
â”œâ”€â”€ .gitignore
â”œâ”€â”€ raw/
â”‚   â”œâ”€â”€ untracked/        â† New sources waiting to be ingested
â”‚   â”‚   â””â”€â”€ 2026/
â”‚   â”‚       â””â”€â”€ 04/
â”‚   â”‚           â””â”€â”€ 05-article-name.md
â”‚   â””â”€â”€ ingested/         â† Sources that have been processed
â”‚       â””â”€â”€ 2026/
â”‚           â””â”€â”€ 04/
â”‚               â””â”€â”€ 05-article-name.md
â””â”€â”€ wiki/
    â”œâ”€â”€ index.md          â† Auto-maintained wiki index (the brain)
    â”œâ”€â”€ log.md            â† Operation history
    â”œâ”€â”€ concepts/         â† LLM-generated concept pages
    â”œâ”€â”€ sources/          â† Source attribution pages
    â””â”€â”€ answers/          â† Saved query answers
```

---

## ðŸ“– Commands

### `wiki raw`
Interactively add a raw source document (articles, notes, conversations, etc.).

```bash
wiki raw
```

You'll be prompted to paste content in your editor, then provide:
- **Source description** â€“ e.g. `"Claude Code ä½¿ç”¨æŠ€å·§å…¬ä¼—å·æ–‡ç« "` (becomes part of the filename)
- **Content type** â€“ `article`, `conversation`, `note`, `book-excerpt`, `code-snippet`, `other`

The file is saved to `raw/untracked/YYYY/MM/DD-source-name.md`.

---

### `wiki ingest [file]`
Process raw source(s) into the wiki using the LLM.

```bash
wiki ingest                   # Interactive file picker
wiki ingest --all             # Ingest all pending files
wiki ingest --dry-run         # Preview operations without writing
wiki ingest -y                # Skip confirmation prompts
wiki ingest -d                # Debug mode: print LLM payload and relevant pages found
```

The LLM will:
1. Read the raw content and the current `wiki/index.md`
2. Find related existing pages automatically (keyword matching)
3. Propose `create` / `update` / `delete` operations on wiki pages
4. Update `wiki/index.md` to link new pages
5. Move the source file to `raw/ingested/` once confirmed

All operations require user confirmation before being applied (unless `-y` is set).

---

### `wiki query [question]`
Ask a question based on your wiki using a multi-step ReAct agent.

```bash
wiki query "æ€Žä¹ˆç”¨å¥½Claude Codeï¼Ÿ"
wiki query -d                  # Debug: show which files the agent reads at each step
wiki query --save              # Auto-save the answer as a wiki page
wiki query --no-save           # Skip the save prompt
```

The agent works in a loop (up to 4 iterations):
1. **Reads `index.md`** â€“ understands what topics exist
2. **Fetches concept pages** â€“ reads the relevant pages
3. **Dives into sources** â€“ if a concept page cites `[src: raw/ingested/...]`, the agent reads the original source for deeper detail
4. **Outputs a synthesised answer** in the same language as your question, with `[src: PageName]` citations

Optionally save the answer back into the wiki as `wiki/answers/your-title.md`.

---

### `wiki list <type> [target]`
Browse the wiki without LLM costs.

```bash
wiki list raw              # Show all untracked + ingested source files
wiki list pages            # List all wiki concept pages
wiki list orphans          # Find pages with no incoming links
wiki list backlinks "Claude Code"   # Find all pages that link to a given page
```

---

### `wiki lint`
Run a health check on your wiki.

```bash
wiki lint                  # Static analysis + LLM semantic analysis
wiki lint --skip-llm       # Static analysis only (free, instant)
wiki lint --fix            # Auto-apply fix proposals (creates stubs, updates index)
```

**Phase 1 â€“ Static (free):**
- âš  Orphan pages (no incoming links)
- âœ— Dead links (`[[Page]]` pointing to non-existent files)
- âš  Pages missing from `index.md`

**Phase 2 â€“ LLM semantic (one API call):**
- âœ— Contradictions between pages
- âš  Missing concept stubs (frequently mentioned but no dedicated page)
- âš  Shallow / placeholder pages

**`--fix` mode** creates stub pages for missing concepts and updates `index.md` atomically so no new orphans are created.

---

## ðŸ—ºï¸ Roadmap

- [x] `wiki init`
- [x] `wiki raw` with YAML frontmatter and per-date directory organisation
- [x] `wiki ingest` with LLM patch generation and confirmation
- [x] `wiki query` with iterative ReAct multi-step retrieval
- [x] `wiki list` (raw / pages / orphans / backlinks)
- [x] `wiki lint` (static + LLM semantic + auto-fix)
- [x] Automatic relevant-page discovery during ingest
- [x] `jsonrepair` resilience for malformed LLM JSON
- [x] `.wikirc.yaml` configuration support
- [ ] `wiki log` command
- [ ] Obsidian plugin integration
- [ ] Support for embeddings / vector search when index grows large

---

## ðŸ™ Acknowledgements

- [Andrej Karpathy](https://github.com/karpathy) for the LLM Wiki pattern
- [Vannevar Bush](https://en.wikipedia.org/wiki/Vannevar_Bush) for the 1945 Memex vision
- The Obsidian community for inspiring local, Markdown-based knowledge management

---

## ðŸ“„ License

MIT

## Agent schema

You are the maintainer of a personal knowledge base wiki. Your primary responsibilities are:
1. **Maintain structure and connectivity**: Ensure the wiki is well-structured, heavily interlinked, and consistent.
2. **Always cite sources**: Every piece of information, claim, or fact added to the wiki MUST reference the absolute path of the raw source it came from using the syntax: `[src: <provided-source-path>]`.
3. **Handle contradictions**: When you discover a contradiction between a new source and an existing page, DO NOT delete the existing claim unless explicitly told, but instead add a blockquote notation on the page marking the contradiction: `> [!contradiction]\n> New source claims X, but previous source Y claimed Z.`
4. **Obsidian Link Strictness**: When you add a link like `[[Title]]` to `wiki/index.md` or any other page, there MUST exist a file physically named `Title.md` EXACTLY matching the text inside the brackets. If the file is `ssml.md`, the link MUST be `[[ssml]]`. If you want a description, use the pipe syntax: `[[ssml|SSML (Speech Synthesis Markup Language)]]`.
5. **Maintain the central Index**: The `wiki/index.md` file must serve as the absolute source-of-truth mapping everything in the wiki. **Any time you create, rename, or delete pages, you MUST also output update instructions for `wiki/index.md`**.
6. **JSON Action Protocol**: Your final output MUST be a strict, valid JSON object detailing instructions on how to patch the file system (create, update, delete pages). Do NOT output conversational text before or after the JSON block.


## CLI bundle excerpt (dist/bin/wiki.js)

#!/usr/bin/env node

// bin/wiki.ts
import { Command } from "commander";

// src/config/loadConfig.ts
import { cosmiconfig } from "cosmiconfig";
import YAML from "yaml";

// src/config/defaultConfig.ts
var defaultConfig = {
  wikiRoot: ".",
  llm: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.3,
    thinking: {
      type: "disabled"
    }
  },
  paths: {
    raw: "raw",
    wiki: "wiki",
    templates: "templates"
  }
};

// src/config/loadConfig.ts
async function loadConfig() {
  const explorer = cosmiconfig("wiki", {
    searchPlaces: [
      "package.json",
      ".wikirc",
      ".wikirc.json",
      ".wikirc.yaml",
      ".wikirc.yml",
      ".wikirc.js",
      ".wikirc.cjs",
      "wiki.config.js",
      "wiki.config.cjs"
    ],
    loaders: {
      ".yaml": (filePath, content) => YAML.parse(content),
      ".yml": (filePath, content) => YAML.parse(content),
      noExt: (filePath, content) => YAML.parse(content)
    }
  });
  try {
    const result = await explorer.search();
    if (result && !result.isEmpty) {
      return {
        ...defaultConfig,
        ...result.config,
        llm: {
          ...defaultConfig.llm,
          ...result.config?.llm
        },
        paths: {
          ...defaultConfig.paths,
          ...result.config?.paths
        }
      };
    }
  } catch (error) {
    console.warn("Failed to load cosmiconfig, using defaults.", error);
  }
  return defaultConfig;
}

// src/commands/init.ts
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { fileURLToPath } from "url";
var __filename2 = fileURLToPath(import.meta.url);
var __dirname2 = path.dirname(__filename2);
async function initCmd(config, options) {
  const spinner = ora("Initializing Wiki").start();
  try {
    const rawDir = path.resolve(config.wikiRoot, config.paths.raw, "untracked");
    const wikiDir = path.resolve(config.wikiRoot, config.paths.wiki);
    const exists = await fs.pathExists(wikiDir) || await fs.pathExists(rawDir);
    if (exists && !options.force) {
      spinner.stop();
      const { confirm } = await inquirer.prompt([{
        type: "confirm",
        name: "confirm",
        message: "Wiki directories already exist. Overwrite?",
        default: false
      }]);
      if (!confirm) {
        console.log(chalk.yellow("Initialization aborted."));
        return;
      }
      spinner.start("Re-initializing Wiki");
    }
    await fs.ensureDir(rawDir);
    await fs.ensureDir(wikiDir);
    const indexDest = path.join(wikiDir, "index.md");
    const logDest = path.join(wikiDir, "log.md");
    const cliWikiTemplatesDir = path.resolve(__dirname2, "../../templates/wiki");
    await fs.copy(path.join(cliWikiTemplatesDir, "index.md"), indexDest, { overwrite: true });
    await fs.copy(path.join(cliWikiTemplatesDir, "log.md"), logDest, { overwrite: true });
    const cliRootTemplatesDir = path.resolve(__dirname2, "../../templates");
    const wikircDest = path.join(config.wikiRoot, ".wikirc.yaml");
    const gitignoreDest = path.join(config.wikiRoot, ".gitignore");
    await fs.copy(path.join(cliRootTemplatesDir, ".wikirc.yaml"), wikircDest, { overwrite: true });
    if (!await fs.pathExists(gitignoreDest)) {
      await fs.copy(path.join(cliRootTemplatesDir, "_gitignore"), gitignoreDest);
    } else {
      const existingGitignore = await fs.readFile(gitignoreDest, "utf8");
      if (!existingGitignore.includes(".wikirc.yaml")) {
        await fs.appendFile(gitignoreDest, "\n.wikirc.yaml\n");
      }
    }
    spinner.succeed(chalk.green("LLM Wiki initialized successfully!"));
  } catch (err) {
    spinner.fail(chalk.red("Initialization failed."));
    console.error(err);
  }
}

// src/commands/raw.ts
import fs2 from "fs-extra";
import path2 from "path";
import chalk2 from "chalk";
import inquirer2 from "inquirer";
async function rawCmd(config, options) {
  let content = options.content;
  if (!content) {
    if (options.editor !== false) {
      const answers = await inquirer2.prompt([{
        type: "editor",
        name: "body",
        message: "Enter the raw content document"
      }]);
      content = answers.body;
    } else {
      console.log(chalk2.yellow("Direct terminal entry not currently supported via --no-editor. Use --content instead."));
      return;
    }
  }
  if (!content || content.trim() === "") {
    console.log(chalk2.red("No content provided."));
    return;
  }
  const metaAnswers = await inquirer2.prompt([
    {
      type: "input",
      name: "source",
      message: "Source description:",
      when: !options.source
    },
    {
      type: "rawlist",
      name: "type",
      message: "Content type (Select a number):",
      choices: ["article", "conversation", "note", "book-excerpt", "code-snippet", "other"],
      when: !options.type
    }
  ]);
  const finalSource = options.source || metaAnswers.source;
  const finalType = options.type || metaAnswers.type;
  const dateStr = (/* @__PURE__ */ new Date()).toISOString();
  const frontmatter = `---
source: "${finalSource}"
date: ${dateStr}
type: ${finalType}
---

`;
  const fullContent = frontmatter + content;
  const now = /* @__PURE__ */ new Date();
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const slug = finalSource.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "").substring(0, 40);
  const rawFileName = `${dd}-${slug}.md`;
  const untrackedDir = path2.resolve(config.wikiRoot, config.paths.raw, "untracked", yyyy, mm);
  await fs2.ensureDir(untrackedDir);
  const targetPath = path2.join(untrackedDir, rawFileName);
  let finalPath = targetPath;
  if (await fs2.pathExists(finalPath)) {
    let counter = 2;
    while (await fs2.pathExists(finalPath)) {
      finalPath = path2.join(untrackedDir, `${dd}-${slug}-${counter}.md`);
      counter++;
    }
  }
  await fs2.writeFile(finalPath, fullContent, "utf8");
  const relPath = path2.relative(config.wikiRoot, finalPath);
  console.log(chalk2.green(`
Saved raw document to ${relPath}`));
  console.log(chalk2.cyan(`Run 'wiki ingest' next to process it!
`));
}

// src/commands/ingest.ts
import fs6 from "fs-extra";
import path6 from "path";
import chalk3 from "chalk";
import ora2 from "ora";
import inquirer3 from "inquirer";
import { jsonrepair } from "jsonrepair";

// src/core/llmClient.ts
import OpenAI from "openai";
var LLMClient = class {
  client;
  config;
  constructor(config) {
    this.config = config;
    const apiKey = config.llm.apiKey || process.env.OPENAI_API_KEY;
    this.client = new OpenAI({
      apiKey,
      baseURL: config.llm.baseUrl
      // Essential for proxies
    });
  }
  async chat(messages) {
    const response = await this.client.chat.completions.create({
      model: this.config.llm.model,
      messages,
      temperature: this.config.llm.temperature,
      thinking: this.config.llm.thinking
    });
    return response.choices[0]?.message?.content || null;
  }
};

// src/core/promptBuilder.ts
import fs3 from "fs-extra";
import path3 from "path";
import Handlebars from "handlebars";
import { fileURLToPath as fileURLToPath2 } from "url";
var __filename3 = fileURLToPath2(import.meta.url);
var __dirname3 = path3.dirname(__filename3);
var PromptBuilder = class {
  agentSchemaPath;
  ingestTemplatePath;
  queryAgentTemplatePath;
  lintTemplatePath;
  constructor() {
    this.agentSchemaPath = path3.resolve(__dirname3, "../schemas/agent.md");
    this.ingestTemplatePath = path3.resolve(__dirname3, "../schemas/ingest.prompt.hbs");
    this.queryAgentTemplatePath = path3.resolve(__dirname3, "../schemas/query_agent.prompt.hbs");
    this.lintTemplatePath = path3.resolve(__dirname3, "../schemas/lint.prompt.hbs");
  }
  async buildIngestPrompt(data) {
    const agentSystemPrompt = await fs3.readFile(this.agentSchemaPath, "utf8");
    const ingestTplString = await fs3.readFile(this.ingestTemplatePath, "utf8");
    const template = Handlebars.compile(ingestTplString);
    return template({
      agentSystemPrompt,
      ...data
    });
  }
  async buildQueryAgentPrompt(data) {
    const tplString = await fs3.readFile(this.queryAgentTemplatePath, "utf8");
    const template = Handlebars.compile(tplString);
    return template(data);
  }
  async buildLintPrompt(data) {
    const tplString = await fs3.readFile(this.lintTemplatePath, "utf8");
    const template = Handlebars.compile(tplString);
    return template(data);
  }
};

// src/core/wikiManager.ts
import fs5 from "fs-extra";
import path5 from "path";

// src/core/fileOps.ts
import fs4 from "fs-extra";
import path4 from "path";
async function safeWriteFile(filePath, content) {
  const dir = path4.dirname(filePath);
  await fs4.ensureDir(dir);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  try {
    await fs4.writeFile(tempPath, content, "utf8");
    await fs4.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs4.unlink(tempPath);
    } catch {
    }
    throw error;
  }
}

// src/core/wikiManager.ts
var WikiManager = class {
  config;
  constructor(config) {
    this.config = config;
  }
  getWikiRoot() {
    return this.config.wikiRoot;
  }
  async getIndexContent() {
    const indexPath = path5.join(this.config.wikiRoot, this.config.paths.wiki, "index.md");
    try {
      const exists = await fs5.pathExists(indexPath);
      if (!exists) return "# Wiki Index\n\nEmpty index.";
      return await fs5.readFile(indexPath, "utf8");
    } catch {
      return "";
    }
  }
  async getPageContents(pageNames) {
    const results = [];
    if (!pageNames || pageNames.length === 0) return results;
    const canonicalize2 = (n) => n.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
    const targets = pageNames.map((original) => ({
      original,
      canon: canonicalize2(original.replace(/\.md$/, "")),
      isPath: original.includes("/") || original.includes(".")
    }));
    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i];
      if (t.isPath) {
        const possiblePaths = [
          path5.resolve(this.config.wikiRoot, t.original),
          path5.resolve(this.config.wikiRoot, this.config.paths.wiki, t.original),
          path5.resolve(this.config.wikiRoot, this.config.paths.raw, "ingested", t.original)
        ];
        for (const p of possiblePaths) {
          if (await fs5.pathExists(p)) {
            try {
              const content = await fs5.readFile(p, "utf8");
              results.push({ name: t.original, content });
              targets.splice(i, 1);
              break;
            } catch {
            }
          }
        }
      }
    }
    if (targets.length === 0) return results;
    async function scanDir(dir) {
      if (!await fs5.pathExists(dir)) return;
      const entries = await fs5.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path5.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const baseName = entry.name.slice(0, -3);
          const baseCanon = canonicalize2(baseName);
          let matchIndex = targets.findIndex((t) => t.canon === baseCanon);
          if (matchIndex === -1) {
            matchIndex = targets.findIndex((t) => {
              if (t.isPath) return false;
              return t.canon.includes(baseCanon) || baseCanon.includes(t.canon);
            });
          }
          const isSafeMatch = matchIndex !== -1 && (targets[matchIndex].canon === baseCanon || Math.abs(targets[matchIndex].canon.length - baseCanon.length) > 3);
          if (isSafeMatch) {
            try {
              const content = await fs5.readFile(fullPath, "utf8");
              results.push({ name: targets[matchIndex].original, content });
              targets.splice(matchIndex, 1);
            } catch (e) {
              console.warn(`Failed to read page: ${fullPath}`, e);
            }
          }
        }
      }
    }
    await scanDir(path5.join(this.config.wikiRoot, this.config.paths.wiki));
    await scanDir(path5.join(this.config.wikiRoot, this.config.paths.raw, "ingested"));
    return results;
  }
  async findRelevantPages(rawContent, options = {}) {
    const { topN = 5, minScore = 2 } = options;
    const wikiDir = path5.join(this.config.wikiRoot, this.config.paths.wiki);
    const stopWords = /* @__PURE__ */ new Set(["that", "this", "with", "from", "they", "have", "what", "when", "will", "your", "into", "more", "also", "just", "been", "some", "than", "then", "them", "were", "like", "said", "each", "which", "their", "there", "about", "would", "these", "other", "after", "using", "could", "where", "those"]);
    const rawWords = new Set(
      rawContent.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w))
    );
    const scored = [];
    async function scanAndScore(dir) {
      if (!await fs5.pathExists(dir)) return;
      const entries = await fs5.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path5.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanAndScore(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md") && !["index.md", "log.md"].includes(entry.name)) {
          try {
            const content = await fs5.readFile(fullPath, "utf8");
            const pageWords = content.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, " ").split(/\s+/);
            let score = 0;
            for (const w of pageWords) {
              if (rawWords.has(w)) score++;
            }
            const nameWords = entry.name.slice(0, -3).toLowerCase().replace(/[-_]/g, " ").split(" ");
            for (const w of nameWords) {
              if (w.length > 3 && rawWords.has(w)) score += 3;
            }
            if (score >= minScore) {
              scored.push({ title: entry.name.slice(0, -3), content, score });
            }
          } catch {
          }
        }
      }
    }
    await scanAndScore(path5.join(wikiDir, "concepts"));
    await scanAndScore(path5.join(wikiDir, "answers"));
    return scored.sort((a, b) => b.score - a.score).slice(0, topN).map(({ title, content }) => ({ title, content }));
  }
  async appendLog(action, details) {
    const logPath = path5.join(this.config.wikiRoot, this.config.paths.wiki, "log.md");
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 16);
    const logEntry = `
## [${timestamp}] ${action} | ${details}`;
    await fs5.ensureFile(logPath);
    await fs5.appendFile(logPath, logEntry, "utf8");
  }
  async executeOperations(ops) {
    for (const op of ops) {
      const absolutePath = path5.resolve(this.config.wikiRoot, op.path);
      if (!absolutePath.startsWith(path5.resolve(this.config.wikiRoot))) {
        throw new Error(`Path traversal detected: ${op.path}`);
      }
      switch (op.type) {
        case "create":
        case "update":
          if (!op.content) throw new Error(`Content missing for op on ${op.path}`);
          await safeWriteFile(absolutePath, op.content);
          break;
        case "delete":
          await fs5.remove(absolutePath);
          break;
        default:
          console.warn(`Unknown operation type: ${op.type}`);
      }
    }
  }
};

// src/commands/ingest.ts
async function ingestCmd(config, file, options) {
  const untrackedDir = path6.resolve(config.wikiRoot, config.paths.raw, "untracked");
  const ingestedDir = path6.resolve(config.wikiRoot, config.paths.raw, "ingested");
  if (!await fs6.pathExists(untrackedDir)) {
    console.log(chalk3.yellow("No pending raw files found. Directory does not exist."));
    return;
  }
  async function collectMdFiles(dir, base) {
    const results = [];
    const entries = await fs6.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...await collectMdFiles(path6.join(dir, entry.name), relPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(relPath);
      }
    }
    return results;
  }
  const pendingFiles = await collectMdFiles(untrackedDir, "");
  if (pendingFiles.length === 0) {
    console.log(chalk3.green("No pending raw files found."));
    return;
  }
  let selectedFiles = [];
  if (file) {
    selectedFiles = [file];
  } else if (options.all) {
    selectedFiles = pendingFiles;
  } else {
    const { choices } = await inquirer3.prompt([{
      type: "checkbox",
      name: "choices",
      message: "Select raw files to ingest:",
      choices: pendingFiles
    }]);
    selectedFiles = choices;
  }
  if (selectedFiles.length === 0) return;
  const llm = new LLMClient(config);
  const pb = new PromptBuilder();
  const wm = new WikiManager(config);
  for (const selectedFile of selectedFiles) {
    console.log(chalk3.blue(`
Processing ${selectedFile}...`));
    const rawPath = path6.join(untrackedDir, selectedFile);
    const rawContent = await fs6.readFile(rawPath, "utf8");
    const indexContent = await wm.getIndexContent();
    let spinner = null;
    try {
      const relevantPages = await wm.findRelevantPages(rawContent, { topN: 5, minScore: 3 });
      if (options.debug && relevantPages.length > 0) {
        console.log(chalk3.magenta(`
[DEBUG] Found ${relevantPages.length} relevant existing pages to pass as context:`));
        relevantPages.forEach((p) => console.log(chalk3.gray(`  - ${p.title}`)));
      }
      const promptText = await pb.buildIngestPrompt({
        sourcePath: `raw/ingested/${selectedFile}`,
        rawContent,
        indexContent,
        relevantPages
      });
      if (options.debug) {
        console.log(chalk3.magenta("\n[DEBUG] Submitting the following payload to LLM:\n"));
        console.log(chalk3.gray(promptText));
        console.log(chalk3.magenta("\n[DEBUG] Awaiting LLM response..."));
      }
      spinner = ora2("Generating wiki operations via LLM...").start();
      const response = await llm.chat([{ role: "user", content: promptText }]);
      spinner.stop();
      if (!response) {
        throw new Error("No response from LLM.");
      }
      const jsonStart = response.indexOf("{");
      const jsonEnd = response.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error("Could not parse JSON operations from LLM response:\n" + response);
      }
      const rawJson = response.substring(jsonStart, jsonEnd + 1);
      let plan;
      try {
        plan = JSON.parse(rawJson);
      } catch (parseErr) {
        console.log(chalk3.yellow("\n[DEBUG] LLM JSON malformed, attempting automatic repair using jsonrepair..."));
        try {
          const repairedJson = jsonrepair(rawJson);
          plan = JSON.parse(repairedJson);
        } catch (repairErr) {
          throw new Error("Could not parse or repair JSON operations from LLM response:\n" + rawJson);
        }
      }
      if (!plan.operations || !Array.isArray(plan.operations)) {
        throw new Error("Invalid plan structure from LLM");
      }
      console.log(chalk3.cyan(`
Proposed Operations:`));
      plan.operations.forEach((op) => {
        const color = op.type === "create" ? chalk3.green : op.type === "delete" ? chalk3.red : chalk3.yellow;
        console.log(`  ${color(`[${op.type.toUpperCase()}]`)} ${op.path}`);
      });
      if (options.dryRun) continue;
      let confirm = options.yes;
      if (!confirm) {
        const answers = await inquirer3.prompt([{
          type: "confirm",
          name: "proceed",
          message: "Apply these operations?",
          default: true
        }]);
        confirm = answers.proceed;
      }
      if (confirm) {
        await wm.executeOperations(plan.operations);
        await wm.appendLog("ingest", `Source: ${selectedFile} | Status: success | Msg: ${plan.log_message || "Ingested"}`);
        const destPath = path6.join(ingestedDir, selectedFile);
        await fs6.ensureDir(path6.dirname(destPath));
        await fs6.move(rawPath, destPath, { overwrite: true });
        const ingestedRelPath = path6.relative(config.wikiRoot, destPath);
        console.log(chalk3.green(`
\u2714 Ingested successfully \u2192 ${ingestedRelPath}`));
      } else {
        console.log(chalk3.yellow(`Skipped ${selectedFile}.`));
      }
    } catch (err) {
      if (spinner) spinner.stop();
      console.error(chalk3.red(`
Failed to ingest ${selectedFile}:`), err);
    }
  }
}

// src/commands/query.ts
import chalk4 from "chalk";
import ora3 from "ora";
import inquirer4 from "inquirer";
import { jsonrepair as jsonrepair2 } from "jsonrepair";
async function queryCmd(config, question, options) {
  let finalQuestion = question;
  if (!finalQuestion) {
    const answers = await inquirer4.prompt([{
      type: "input",
      name: "q",
      message: "What do you want to know about your wiki?"
    }]);
    finalQuestion = answers.q;
  }
  if (!finalQuestion || finalQuestion.trim() === "") {
    console.log(chalk4.red("No question provided."));
    return;
  }
  const llm = new LLMClient(config);
  const pb = new PromptBuilder();
  const wm = new WikiManager(config);
  const indexContent = await wm.getIndexContent();
  const loadedPages = [];
  let answerContent = "";
  let iteration = 0;
  const MAX_ITERATIONS = 4;
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const promptText = await pb.buildQueryAgentPrompt({
      question: finalQuestion,
      indexContent,
      loadedPages
    });
    if (options.debug) {
      console.log(chalk4.magenta(`
[DEBUG] Iteration ${iteration} - Loaded ${loadedPages.length} pages in context.`));
    }
    const spinner = ora3(`Agent is thinking (Iteration ${iteration})...`).start();
    let response = "";
    try {
      response = await llm.chat([{ role: "user", content: promptText }]);
      spinner.stop();
    } catch (err) {
      spinner.stop();
      console.error(chalk4.red("\nAgent request failed:"), err);
      return;
    }
    if (!response) {
      console.log(chalk4.red("\nAgent returned an empty response."));
      return;
    }
    const jsonStart = response.indexOf("{");
    const jsonEnd = response.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      console.log(chalk4.yellow("\nAgent failed to format output as JSON."));
      if (options.debug) console.log(response);
      return;
    }
    let actionData;
    const rawJson = response.substring(jsonStart, jsonEnd + 1);
    try {
      actionData = JSON.parse(rawJson);
    } catch (e) {
      try {
        actionData = JSON.parse(jsonrepair2(rawJson));
      } catch (e2) {
        console.log(chalk4.red("\nAgent produced malformed JSON that could not be repaired."));
        if (options.debug) console.log(rawJson);
        return;
      }
    }
    if (actionData.action === "read") {
      if (options.debug) console.log(chalk4.magenta(`[DEBUG] Agent Reasoning: ${actionData.reasoning || "(none)"}`));
      console.log(chalk4.blue(`Agent wants to read: ${actionData.pages.join(", ")}`));
      const newPages = await wm.getPageContents(actionData.pages);
      const existingNames = new Set(loadedPages.map((p) => p.name));
      let addedCount = 0;
      for (const p of newPages) {
        if (!existingNames.has(p.name)) {
          loadedPages.push(p);
          addedCount++;
        }
      }
      if (addedCount === 0) {
        console.log(chalk4.yellow(`Agent requested pages we couldn't find or already read.`));
        if (iteration === MAX_ITERATIONS - 1) {
          console.log(chalk4.red("Too many recursive misses. Stopping."));
        }
      }
    } else if (actionData.action === "answer") {
      if (options.debug) console.log(chalk4.magenta(`[DEBUG] Agent Reasoning: ${actionData.reasoning || "(none)"}`));
      answerContent = actionData.content;
      break;
    } else {
      console.log(chalk4.red(`Unknown action from Agent: ${actionData.action}`));
      return;
    }
  }
  if (!answerContent) {
    console.log(chalk4.red("Failed to generate an answer within the iteration limit."));
    return;
  }
  console.log(chalk4.cyan(`
================= ANSWER =================
`));
  console.log(answerContent);
  console.log(chalk4.cyan(`
==========================================
`));
  await wm.appendLog("query", `Question: "${finalQuestion}" | Iterations: ${iteration} | Pages read: ${loadedPages.length}`);
  if (options.noSave) return;
  let confirmSave = options.save;
  if (!confirmSave) {
    const savePrompt = await inquirer4.prompt([{
      type: "confirm",
      name: "save",
      message: "Do you want to save this answer back into the wiki?",
      default: false
    }]);
    confirmSave = savePromp
