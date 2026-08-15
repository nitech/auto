/**
 * How Cursor's own chat shows a desktop tool call, so Auto's stream can
 * follow it instead of printing every database bubble as OTHER.
 *
 * The IDE groups reads and searches into a quiet status line ("Explored 22
 * files, 13 searches"), puts edits on a file-change lane, and hides a handful
 * of tools entirely. Auto still records every call; this is only how a
 * projection (web or Telegram) should draw one.
 */

const HIDE = new Set([
  'unspecified',
  'reapply',
  'background_composer_followup',
  'knowledge_base',
  'fetch_pull_request',
  'create_diagram',
  'task',
  'await_task',
  'apply_agent_diff',
  'report_bugfix_results',
  'mcp--',
  'tool',
]);

const FILE_CHANGE = {
  edit_file_v2: { label: 'Edit file', short: 'Edited', toolKind: 'edit' },
  edit_file: { label: 'Edit file', short: 'Edited', toolKind: 'edit' },
  delete_file: { label: 'Delete file', short: 'Deleted', toolKind: 'delete' },
};

const GROUP = {
  read_file_v2: { label: 'Read file', short: 'Read', toolKind: 'read' },
  read_file: { label: 'Read file', short: 'Read', toolKind: 'read' },
  ripgrep_raw_search: { label: 'Search', short: 'Search', toolKind: 'search' },
  ripgrep_search: { label: 'Search', short: 'Search', toolKind: 'search' },
  glob_file_search: { label: 'Find files', short: 'Find', toolKind: 'search' },
  file_search: { label: 'Find files', short: 'Find', toolKind: 'search' },
  list_dir_v2: { label: 'List directory', short: 'List', toolKind: 'read' },
  list_dir: { label: 'List directory', short: 'List', toolKind: 'read' },
  read_lints: { label: 'Read lints', short: 'Lints', toolKind: 'read' },
  web_search: { label: 'Search web', short: 'Web', toolKind: 'search' },
  web_fetch: { label: 'Fetch webpage', short: 'Fetch', toolKind: 'fetch' },
  await: { label: 'Await', short: 'Await', toolKind: 'other' },
  get_mcp_tools: { label: 'Get MCP tools', short: 'MCP tools', toolKind: 'other' },
  semantic_search_full: { label: 'Semantic search', short: 'Search', toolKind: 'search' },
  todo_read: { label: 'Read todos', short: 'Todos', toolKind: 'read' },
  fetch_rules: { label: 'Fetch rules', short: 'Rules', toolKind: 'read' },
  read_semsearch_files: { label: 'Read search files', short: 'Read', toolKind: 'read' },
  search_symbols: { label: 'Search symbols', short: 'Symbols', toolKind: 'search' },
  go_to_definition: { label: 'Go to definition', short: 'Definition', toolKind: 'read' },
};

const CARD = {
  run_terminal_command_v2: { label: 'Run command', short: 'Run', toolKind: 'execute' },
  todo_write: { label: 'Update todos', short: 'Todos', toolKind: 'other' },
  ask_question: { label: 'Ask question', short: 'Question', toolKind: 'other' },
  task_v2: { label: 'Task', short: 'Task', toolKind: 'other' },
  create_plan: { label: 'Create plan', short: 'Plan', toolKind: 'plan' },
  switch_mode: { label: 'Switch mode', short: 'Mode', toolKind: 'other' },
  generate_image: { label: 'Generate image', short: 'Image', toolKind: 'other' },
  computer_use: { label: 'Computer use', short: 'Computer', toolKind: 'other' },
  mcp_auth: { label: 'Authenticate MCP', short: 'Auth', toolKind: 'other' },
  connect_scm: { label: 'Connect GitHub', short: 'GitHub', toolKind: 'other' },
  read_mcp_resource: { label: 'Read MCP resource', short: 'Resource', toolKind: 'fetch' },
  record_screen: { label: 'Screen recording', short: 'Record', toolKind: 'other' },
};

const PIPES = /[|;&]|&&|\|\|/;

/** A bare `ls` is grouped in the IDE the way a directory listing is. */
export function isSimpleLs(command) {
  const t = String(command || '').trim();
  if (!t || !/^\s*ls(\s|$)/i.test(t)) return false;
  if (PIPES.test(t) || /\$\(|`/.test(t) || /[><]/.test(t)) return false;
  return true;
}

function keyOf(rec) {
  return String(rec?.title || '').trim().toLowerCase();
}

function recOf(item) {
  return item?.rec || item || {};
}

/**
 * Which lane a tool call belongs on.
 *
 * `hide` — Cursor draws nothing.
 * `fileChange` — a path and a +/- count, not a named step.
 * `group` — collapsed with its neighbours into an activity row.
 * `card` — a real card: shells, MCP, todos, questions, plans.
 *
 * ACP titles (`Edit File`, `Read File`) are not in the desktop maps, so they
 * stay cards — they already arrive with a kind and often a diff.
 */
export function classifyTool(rec = {}) {
  const key = keyOf(rec);
  if (HIDE.has(key)) return { lane: 'hide', toolKind: 'other', label: 'tool', short: 'tool' };

  const command = rec.rawInput?.command;
  if (command && isSimpleLs(command)) {
    return { lane: 'group', toolKind: 'execute', label: 'List directory', short: 'List' };
  }
  if (command) {
    return { lane: 'card', toolKind: 'execute', label: command, short: 'Run' };
  }

  if (FILE_CHANGE[key]) return { lane: 'fileChange', ...FILE_CHANGE[key] };
  if (GROUP[key]) return { lane: 'group', ...GROUP[key] };
  if (CARD[key]) return { lane: 'card', ...CARD[key] };
  if (rec.toolKind === 'plan' || rec.rawInput?.plan) {
    return {
      lane: 'card',
      toolKind: 'plan',
      label: rec.rawInput?.name || 'Create plan',
      short: 'Plan',
    };
  }

  const kind =
    rec.toolKind && rec.toolKind !== 'other' && rec.toolKind !== 'tool' ? rec.toolKind : 'other';
  return {
    lane: 'card',
    toolKind: kind,
    label: rec.title || kind || 'tool',
    short: rec.title || kind || 'tool',
  };
}

export function toolPath(rec) {
  const input = rec?.rawInput || {};
  return String(
    input.relativeWorkspacePath ||
      input.targetFile ||
      input.path ||
      input.file_path ||
      input.effectiveUri ||
      '',
  ).trim();
}

export function toolBase(path) {
  const s = String(path || '').replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  return parts.at(-1) || s;
}

export function fileStats(rec) {
  const input = rec?.rawInput || {};
  const added = input.added ?? input.editLinesAdded;
  const removed = input.removed ?? input.editLinesRemoved;
  if (added == null && removed == null) return null;
  return { added: Number(added) || 0, removed: Number(removed) || 0 };
}

/** Is this Cursor's Created Plan card, not a generic tool bar? */
export function isCreatedPlan(rec = {}) {
  const key = keyOf(rec);
  if (key === 'create_plan' || rec.toolKind === 'plan') return true;
  const input = rec.rawInput || {};
  return Boolean(typeof input.plan === 'string' && (input.name || input.overview));
}

/** Title, overview and markdown as the Created Plan card shows them. */
export function planFields(rec = {}) {
  const input = rec.rawInput || {};
  const markdown = typeof input.plan === 'string' ? input.plan : String(rec.markdown || '');
  const heading = markdown.match(/^#\s+(.+)$/m);
  return {
    name: input.name || heading?.[1]?.trim() || rec.title || 'Plan',
    overview: input.overview || rec.overview || '',
    markdown,
    todos: input.todos || rec.todos || [],
    planId: input.planId || rec.planId || null,
    awaitingBuild: rec.awaitingBuild !== false,
  };
}

export function displayLabel(rec = {}) {
  const ui = classifyTool(rec);
  const input = rec.rawInput || {};
  if (isCreatedPlan(rec)) return planFields(rec).name;
  if (input.command && ui.lane !== 'group') return String(input.command);
  const base = toolBase(toolPath(rec));
  if (ui.lane === 'fileChange') {
    const verb = ui.toolKind === 'delete' ? 'Deleted' : 'Edited';
    return base ? `${verb} ${base}` : ui.label;
  }
  if (base && (ui.lane === 'group' || ui.toolKind === 'read' || ui.toolKind === 'search')) {
    return `${ui.label} ${base}`;
  }
  if (typeof input.query === 'string' && input.query.trim()) return input.query.trim();
  return ui.label || rec.title || rec.toolKind || 'tool';
}

const RANK = { in_progress: 4, pending: 4, failed: 3, cancelled: 2, completed: 1 };

function mergeStatus(a, b) {
  return (RANK[b] || 0) > (RANK[a] || 0) ? b : a;
}

function word(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

function lineOf(...bits) {
  const parts = bits.map((b) => (typeof b === 'number' ? { n: b } : { t: b }));
  return { parts, label: bits.join('') };
}

/**
 * Cursor's activity copy: muted verbs, bright counts.
 *
 * A turn in flight is present ("Exploring 1 search"); a finished one is past
 * ("Searched 3 files", "Explored 22 files, 13 searches"). The counts are
 * separate from the words so a renderer can draw them louder.
 */
export function activityCopy({ files = 0, searches = 0, running = false } = {}) {
  const fileWord = word(files, 'file');
  const searchWord = word(searches, 'search', 'searches');
  if (running) {
    if (files && searches) {
      return lineOf('Exploring ', files, ` ${fileWord}, `, searches, ` ${searchWord}`);
    }
    if (searches) return lineOf('Exploring ', searches, ` ${searchWord}`);
    if (files) return lineOf('Exploring ', files, ` ${fileWord}`);
    return lineOf('Exploring');
  }
  if (files && searches) {
    return lineOf('Explored ', files, ` ${fileWord}, `, searches, ` ${searchWord}`);
  }
  if (searches) return lineOf('Searched ', searches, ` ${fileWord}`);
  if (files) return lineOf('Explored ', files, ` ${fileWord}`);
  return lineOf('Explored');
}

export function editCopy(count, oneLabel) {
  if (count === 1 && oneLabel) return lineOf(oneLabel);
  return lineOf('Edited ', count, ` ${word(count, 'file')}`);
}

/** How many reads vs searches sit in a group of tool calls. */
export function groupTally(items = []) {
  let files = 0;
  let searches = 0;
  for (const item of items) {
    const rec = recOf(item);
    const ui = item.ui || classifyTool(rec);
    if (ui.toolKind === 'search') searches += 1;
    else files += 1;
  }
  return { files, searches };
}

function batchStatus(batch) {
  let status = 'completed';
  let failure = null;
  for (const item of batch) {
    const rec = recOf(item);
    status = mergeStatus(status, item.status || rec.status || 'completed');
    failure = item.failure || failure;
  }
  return { status, failure };
}

function groupSummary(batch) {
  const { status, failure } = batchStatus(batch);
  const running = status === 'in_progress' || status === 'pending';
  const { files, searches } = groupTally(batch);
  return {
    ...activityCopy({ files, searches, running }),
    status,
    failure,
    lane: 'group',
    count: batch.length,
  };
}

function fileChangeSummary(batch) {
  const { status, failure } = batchStatus(batch);
  const first = recOf(batch[0]);
  return {
    ...editCopy(batch.length, displayLabel(first)),
    status,
    failure,
    lane: 'fileChange',
    count: batch.length,
  };
}

/**
 * Collapse a turn's tool list the way the IDE does, so a phone is not sent
 * sixty "read_file_v2" lines.
 *
 * Items may be records or `{ rec, status, failure }` wrappers.
 */
export function foldTools(tools = []) {
  const out = [];
  let i = 0;
  while (i < tools.length) {
    const rec = recOf(tools[i]);
    const ui = classifyTool(rec);
    if (ui.lane === 'hide') {
      i += 1;
      continue;
    }
    if (ui.lane === 'fileChange') {
      const batch = [];
      while (i < tools.length && classifyTool(recOf(tools[i])).lane === 'fileChange') {
        batch.push(tools[i]);
        i += 1;
      }
      out.push(fileChangeSummary(batch));
      continue;
    }
    if (ui.lane === 'group') {
      const batch = [];
      while (i < tools.length && classifyTool(recOf(tools[i])).lane === 'group') {
        batch.push(tools[i]);
        i += 1;
      }
      out.push(groupSummary(batch));
      continue;
    }
    const item = tools[i];
    out.push({
      label: item.label || displayLabel(rec),
      status: item.status || rec.status || 'completed',
      failure: item.failure || null,
      lane: 'card',
      count: 1,
    });
    i += 1;
  }
  return out;
}
