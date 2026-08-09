# llm-wiki

Version: 0.1.3
Description: An LLM-powered personal wiki CLI. Incrementally build and query a persistent, interlinked wiki from your raw sources.

## Features
- **Smart Ingestion**: Add raw material; LLM integrates it into structured wiki pages with citations.
- **Automatic Linking**: Cross-links new knowledge with existing pages.
- **Multi-Step Retrieval**: Iterative ReAct agent that dives into source files for deep answers.
- **Wiki Lint**: Detects orphans, dead links, contradictions, shallow pages, and missing concepts.
- **List Tools**: Browse raw sources, wiki pages, and backlinks.
- **Zero Lock-in**: Pure Markdown; works with Obsidian, VS Code, or any editor.
- **OpenAI-compatible**: Works with OpenAI, Anthropic (via proxy), DeepSeek, Ollama, and any OpenAI-compatible API.

## Installation
Requires **Node.js 22+**.

```bash
npm install -g llm-wiki
```

Or with pnpm:
```bash
pnpm add -g llm-wiki
```

## Configuration
Run `wiki init` inside any directory to scaffold the wiki structure and generate a `.wikirc.yaml` template:

```bash
mkdir my-wiki && cd my-wiki
wiki init
```

Edit `.wikirc.yaml` (auto-added to `.gitignore` to protect your API key):

```yaml
llm:
  provider: openai
  model: gpt-4o
  apiKey: YOUR_API_KEY_HERE
  baseUrl: https://api.openai.com/v1
  temperature: 0.3
  thinking:
    type: disabled
```

**Using DeepSeek / other providers:**
```yaml
llm:
  model: deepseek-chat
  apiKey: YOUR_DEEPSEEK_KEY
  baseUrl: https://api.deepseek.com/v1
```

## License
MIT

[src: raw/ingested/2026/08/09-llm-wiki-package-source.md]