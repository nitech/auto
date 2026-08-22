/**
 * Rich markdown after renderMarkdown: Mermaid diagrams and KaTeX math.
 *
 * The parser emits plain containers; this module loads vendor renderers on
 * demand and fills them in. Safe to call repeatedly while an answer streams —
 * only untouched nodes are processed, and a failed Mermaid parse is retried
 * on the next chunk until the source is complete.
 */

let mermaidApi = null;
let mermaidLoading = null;
let katexApi = null;
let katexLoading = null;

function mermaidTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'default' : 'dark';
}

async function loadMermaid() {
  if (mermaidApi) return mermaidApi;
  if (!mermaidLoading) {
    mermaidLoading = import('/vendor/mermaid/mermaid.esm.min.mjs').then((mod) => {
      const api = mod.default || mod;
      api.initialize({
        startOnLoad: false,
        theme: mermaidTheme(),
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });
      mermaidApi = api;
      return api;
    });
  }
  return mermaidLoading;
}

async function loadKatex() {
  if (katexApi) return katexApi;
  if (!katexLoading) {
    katexLoading = import('/vendor/katex/katex.mjs').then((mod) => {
      katexApi = mod.default || mod;
      return katexApi;
    });
  }
  return katexLoading;
}

function mermaidErrorSvg(svg) {
  return /Syntax error in text|class="error-text"/.test(svg || '');
}

async function renderMermaid(root) {
  const nodes = [...(root.querySelectorAll?.('.diagram-mermaid:not([data-rendered])') ?? [])];
  if (!nodes.length) return;
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    theme: mermaidTheme(),
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  for (const node of nodes) {
    const source = node.textContent.trim();
    if (!source) continue;
    if (node.dataset.mermaidFail === source) continue;
    try {
      await mermaid.parse(source);
      const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
      const { svg } = await mermaid.render(id, source);
      if (mermaidErrorSvg(svg)) throw new Error('mermaid syntax error');
      node.innerHTML = svg;
      node.dataset.rendered = '1';
      node.classList.remove('diagram-error');
      delete node.dataset.mermaidFail;
      node.removeAttribute('title');
    } catch {
      // Never paint Mermaid's bomb error art — leave the source monospaced.
      node.textContent = source;
      node.classList.add('diagram-error');
      node.dataset.mermaidFail = source;
    }
  }
}

async function renderMath(root) {
  const nodes = [...(root.querySelectorAll?.('.math:not([data-rendered])') ?? [])];
  if (!nodes.length) return;
  const katex = await loadKatex();
  for (const node of nodes) {
    const tex = node.textContent;
    if (!tex?.trim()) continue;
    const displayMode = node.classList.contains('math-block');
    try {
      katex.render(tex, node, { displayMode, throwOnError: false, strict: 'ignore' });
      node.dataset.rendered = '1';
    } catch {
      // Source stays visible when KaTeX cannot parse it yet.
    }
  }
}

/** Paint diagrams and math inside a transcript node or the whole transcript. */
export function enrichMarkdown(root) {
  if (!root) return;
  void renderMath(root).then(() => renderMermaid(root));
}
