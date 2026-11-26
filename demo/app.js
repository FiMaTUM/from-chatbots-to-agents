// Harness visualizer. Plain browser script, no build step.
//
// Raw pi events arrive over SSE (live) or from a recording (replay). They go
// into `queue`. The playback loop takes them out one at a time and applies them
// with `accept`. Events are grouped into STEPS: one step is one thing that a
// person can see happen, for example "the model asks for a tool". Step mode
// pauses the display between steps. It never pauses pi.

const $ = id => document.getElementById(id);
// Static replay build: embedded recordings replace all server connections.
const staticRecordings = window.HARNESS_STATIC?.recordings;

const titles = [
  ['TEXT IN, TEXT OUT', 'Start with a model.', 'It receives text. It generates text.', 'The model alone does not run code.'],
  ['THE CONVERSATION', 'Give it the conversation.', 'Each model call receives the conversation so far.', 'Messages are stored and sent again.'],
  ['A REQUEST TO ACT', 'Give it tools.', 'The model asks once. The checker runs and its result goes into the messages list.', 'A tool call is structured data in the model’s reply.'],
  ['REPEAT UNTIL DONE', 'Repeat.', 'Tool results become input for the next model call.', 'A reply with no tool call ends the loop.'],
  ['THE WHOLE SYSTEM', 'This is the harness.', 'It calls the model, runs tools and manages the messages list.', 'The harness can ask the model to summarize older messages.'],
];

// One curated recording per stage.
const STAGE_RECORDINGS = ['1-model.jsonl', '2-chat.jsonl', '3-tools.jsonl', '4-loop.jsonl', '5-harness.jsonl'];
const RECORDING_FOR_STAGE = s => STAGE_RECORDINGS[s - 1];
// The speaker sees friendly names. The file name stays in the option title.
function recordingName(file) {
  if (!file) return '';
  const fixed = {'1-model.jsonl': '01 Model', '2-chat.jsonl': '02 Chat', '3-tools.jsonl': '03 Tools', '4-loop.jsonl': '04 Loop', '5-harness.jsonl': stage === 5 ? '05 Harness' : '05'};
  if (fixed[file]) return fixed[file];
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d).*-(chat|tools)\.jsonl$/.exec(file);
  return m ? `${m[4]} run, ${m[1]} ${m[2]}:${m[3]}` : file.replace(/\.jsonl$/, '');
}
let loadedRecording = '';
let sourceRevision = 0; // Ignore replies from a source the speaker has left.
let sourceChange = Promise.resolve();
let submitting = false;
// Session mutations must reach the server in the same order as speaker actions.
function changeSession(route, data = {}) {
  const next = sourceChange.catch(() => {}).then(() => api(route, data));
  sourceChange = next;
  return next;
}

// ---------- State ----------

let stage = 1, raw = false, explain = false, source = 'offline', liveTools = false;
let queue = [], events = [];
let messages = [], current = null, system = '', tools = [];
let request = null, context = null, tool = {};
let demoLimit = 0, compactionError = '';
let turn = 0, turnPending = false, usages = [];
let promptTurn = 0;       // value of `turn` when the current question started
let busy = false, paused = false, replaying = false, illustrative = false;
let sending = false;      // a live question is out and not finished; blocks a second Send
// Step state.
let step = null;          // {n, kind, events, openedAt, done}
let stepCount = 0, totalSteps = 0, trail = [];
let plan = [];            // replay only: the kind of every step, in order
let questionStart = 1;    // step.n of the step that opened the current question
let pendingQuestion = ''; // live: the question that was sent, before pi echoes it as a message
let agentReady = false;   // live: the agent program answered its first command and can take a question
let sessionAlive = false; // live: an agent program runs (false after Stop, exit or error)
let errorTarget = null;   // selector of the component that failed

const params = new URLSearchParams(location.search);
const stepMode = () => $('stepMode').checked;

// ---------- Small helpers ----------

const textOf = m => m?.summary ?? (m?.content || [])
  .map(c => c.type === 'text' ? c.text
    : c.type === 'toolCall' ? `Tool call: ${c.name}\n${JSON.stringify(c.arguments, null, 2)}`
    : '')
  .filter(Boolean).join('\n');

function messageCharacters(list) {
  return list.reduce((sum, m) => sum + (m.summary?.length ?? (m.content || []).reduce((n, c) =>
    n + (c.type === 'text' ? c.text.length : c.type === 'toolCall' ? JSON.stringify(c.arguments).length : 0), 0)), 0);
}

// Pi's generated headings use terms for its internal turn boundaries.
// Keep the complete summary in Raw and use plain headings in the demo.
const presentSummary = text => text.replace(/^\*\*Turn Context \(split turn\):\*\*$/m, 'Earlier messages from this question')
  .replace(/^## Context for Suffix$/m, '## For the next model call');

const shorten = (s, n) => (s = String(s ?? '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// Simple markdown for replies: **bold**, `code`. Everything else stays plain text.
const markdown = s => escapeHtml(s)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*\*|`/g, '');   // a marker without its pair (a partial streaming reply)

function argsText(call) {
  const a = call?.arguments ?? call?.args ?? {};
  return a.command ?? a.path ?? JSON.stringify(a);
}

function resultText(result) {
  return (result?.content || []).map(c => c.text || '').join('').trim();
}

function fileResult(name) {
  return {write: 'Saved goldbach.cjs', read: 'File found and read'}[name];
}

// Short readable form of a tool result. The exact text stays in Raw.
function summarizeResult(text) {
  try {
    const j = JSON.parse(text);
    if (typeof j.checked === 'number') {
      const c = (j.counterexamples || []).length;
      return `Checked ${j.checked} even numbers · ${c ? `${c} counterexample${c === 1 ? '' : 's'}` : 'no counterexamples'}`;
    }
  } catch { /* not JSON */ }
  return shorten(text, 120);
}

// Very short form for the Run tool box: two short lines.
function shortResult(text) {
  try {
    const j = JSON.parse(text);
    if (typeof j.checked === 'number') {
      const c = (j.counterexamples || []).length;
      // Short words only: the box is narrow and no word may break.
      return `${j.checked} checked
${c ? `${c} failed` : 'none failed'}`;
    }
  } catch { /* not JSON */ }
  return shorten(text, 40);
}

// The audience does not know the name of the agent program. Never show it.
const plainName = s => String(s ?? '').replace(/\bPi\b/g, 'The agent program').replace(/\bpi\b/g, 'the agent program');
function notice(s) { $('notice').textContent = plainName(s); }

async function api(route, data) {
  if (staticRecordings) throw Error('This page only replays recordings.');
  const r = await fetch('/api/' + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const x = await r.json();
  if (!r.ok) throw Error(x.error);
  return x;
}

// Keep the recorded payload intact. Hide the term in the display until Stage 5.
const stageText = text => stage < 5 ? text.replace(/\bharness\b ?/gi, '') : text;

function inspect(title, value) {
  $('detailTitle').textContent = title;
  $('detailText').textContent = stageText(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  $('detail').showModal();
}

function reset() {
  queue = []; events = [];
  messages = []; current = null; system = ''; tools = [];
  request = null; context = null; tool = {};
  demoLimit = 0; compactionError = '';
  turn = 0; turnPending = false; usages = []; promptTurn = 0;
  busy = false; paused = false;
  step = null; stepCount = 0; totalSteps = 0; trail = []; plan = []; questionStart = 1;
  pendingQuestion = ''; errorTarget = null;
  render();
}

// ---------- Steps: which raw events belong together ----------

// Returns the step kind that an event starts or continues.
// `null` means neutral: the event joins whatever step is open.
function kindOf(e) {
  switch (e.type) {
    case 'viz_prompt':
    case 'agent_start':
      return 'prompt';
    case 'message_start':
    case 'message_end':
      return e.message?.role === 'user' ? 'prompt' : e.message?.role === 'toolResult' ? 'append' : null;
    case 'viz_context':
    case 'viz_request':
      return 'call';
    case 'message_update': {
      const t = e.assistantMessageEvent?.type || '';
      if (t.startsWith('toolcall')) return 'toolcall';
      if (t.startsWith('text') || t.startsWith('thinking')) return 'reply';
      return null;
    }
    case 'tool_execution_start':
      return 'permission';
    case 'tool_execution_update':
    case 'tool_execution_end':
      return 'run';
    case 'agent_end':
    case 'agent_settled':
      return 'done';
    case 'viz_compaction_limit':
      return 'limit';
    case 'compaction_start':
      return 'compact';
    case 'compaction_end':
      return e.result ? null : 'compactFailed';
    case 'viz_messages_list':
      return 'summary';
    case 'viz_error':
    case 'viz_exit':
      return 'error';
    case 'response':
      return e.success === false && !['compact', 'get_messages'].includes(e.command) ? 'error' : null;
    default:
      return null; // viz_reset, viz_system, turn_start, turn_end, viz_stopped, ...
  }
}

// True if this event opens a new step, given the kind of the open step.
const startsStep = (e, openKind) => {
  const k = kindOf(e);
  return k !== null && k !== openKind;
};

// The kind of every step in a recording, in order.
function planSteps(rows) {
  const kinds = [];
  let open = null;
  for (const {event} of rows) if (startsStep(event, open)) { open = kindOf(event); kinds.push(open); }
  return kinds;
}

// True if the event must wait for the next step. Setup events before the
// first step (viz_reset, get_state, ...) pass through freely.
const isBoundary = e => step ? startsStep(e, step.kind) : kindOf(e) !== null;

const isStreamDelta = e => e.type === 'message_update' && /_delta$/.test(e.assistantMessageEvent?.type || '');

// Step numbers on screen restart for each question. step.n stays global (demoState uses it).
const displayNumber = n => n - questionStart + 1;

function openStep(kind) {
  if (kind === 'prompt') { promptTurn = turn; questionStart = stepCount + 1; trail = []; tool = {}; }
  else if (step) trail = [...trail, {n: displayNumber(step.n), kind: step.kind, turn: step.turn}].slice(-2);
  step = {n: ++stepCount, kind, events: [], openedAt: performance.now(), turn};
}

// Number of steps of the current question, when a recording tells us.
function questionTotal() {
  if (!plan.length || !step) return 0;
  let end = step.n;               // plan[end] is the step after the current one
  while (end < plan.length && plan[end] !== 'prompt') end++;
  // A recording that stops inside the question has no known total. Show none,
  // so that a complete run never shows a different total for the same question.
  if (!['done', 'summary', 'compactFailed', 'error'].includes(plan[end - 1])) return 0;
  return end - questionStart + 1;
}

// Short label for the trail. Stages 3-4 draw no permission box, so that step
// is called "Start the tool" there.
function stepLabel(s) {
  return {
    prompt: 'Question', call: s.turn ? `Model call ${s.turn}` : 'Model call', reply: 'Reply streams',
    toolcall: 'Tool call', permission: stage >= 5 ? 'Check permission' : 'Start the tool', run: 'Tool runs',
    append: 'Result added', done: 'Done', limit: 'Demo limit passed', compact: 'Summarize',
    summary: 'Summary added', compactFailed: 'Summary failed', error: 'Error',
  }[s.kind];
}

// The caption: what happens now, in plain words, plus one line of detail.
function caption() {
  if (!step) {
    if (queue.length && stepMode() && replaying) return [stage === 1 ? 'Space: send one question to the model (recorded).' : `Ready. Space plays the recorded ${recordingName(loadedRecording)}.`, 'One step per press. A recording makes no model calls.'];
    if (queue.length && stepMode()) return ['Ready. Press Space for the first step.', 'Step mode shows one step at a time.'];
    if (replaying) return ['Recording ended.', 'Space or Restart plays it again.'];
    return ['Ask a question, or replay a recording.', 'Each step will appear here.'];
  }
  const call = tool.call;
  switch (step.kind) {
    case 'prompt': {
      const user = [...messages].reverse().find(m => m.role === 'user');
      const q = user ? textOf(user) : pendingQuestion;
      const w = liveWait();
      if (w === 'start') return ['The agent program starts. Your question waits.', 'Starting the agent program'];
      if (w === 'model') return ['Your question went to the model. Waiting for the reply.', WAIT_TEXT.model];
      return [stage === 1 ? 'You send a question.' : 'Your question goes into the messages list.', q ? `“${shorten(q, 110)}”` : ''];
    }
    case 'call':
      return messages.at(-1)?.role === 'toolResult'
        ? [stage === 5 ? 'The harness calls the model again, with the tool result.' : 'The tool result goes to the model with the messages list.', `Model call ${turn} · ${messages.length} messages`]
        : [stage === 1 ? 'Your question goes to the model.' : stage === 5 ? 'The harness sends the messages list to the model.' : 'The messages list goes to the model.', `Model call ${turn} · ${messages.length} message${messages.length === 1 ? '' : 's'} + instructions${liveTools ? ' + tool list' : ''}`];
    case 'reply':
      if (current && !textOf(current)) return ['The model thinks before it writes.', 'The thinking text is not shown here.'];
      if (current && recordingCut()) return ['The model was sending its reply in small pieces.', 'The recording ends here, during the reply. Only the first pieces were recorded.'];
      if (current) return ['The model streams its reply, piece by piece.', 'The text arrives in small pieces.'];
      return ['The model’s reply is complete.', 'It contains text only.'];
    case 'toolcall':
      return ['The model asks for a tool. Nothing runs yet.', call ? `${call.name}: ${argsText(call)}` : 'The tool call is only structured data in the reply.'];
    case 'permission':
      // The agent program sends no event for the check. Say what is shown: a rule
      // of the harness, applied when the tool starts.
      return stage >= 5
        ? (toolBlocked() ? ['The harness checks its permission rule. This tool call is not allowed.', call ? `${call.name}: ${argsText(call)} · the model cannot run it itself` : ''] : ['The harness checks its permission rule as the tool starts.', 'The harness decides. The model cannot run anything itself.'])
        : ['Start the tool.', call ? `${call.name}: ${argsText(call)}` : ''];
    case 'run':
      if (toolBlocked()) return [stage === 5 ? 'The harness blocked the tool. It did not run.' : 'The tool call was blocked.', 'The model gets a “blocked” message as the tool result.'];
      if (tool.isError) return ['The tool did not run successfully.', summarizeResult(resultText(tool.result))];
      if (call?.name === 'write') return [stage === 5 ? 'Tool runs. The harness saves the file.' : 'Tool runs. The file is saved.', tool.done ? fileResult('write') : ''];
      if (call?.name === 'read') return [stage === 5 ? 'Tool runs. The harness reads the saved file.' : 'Tool runs. The saved file is read.', tool.done ? fileResult('read') : ''];
      return tool.result && tool.done
        ? [stage === 5 ? 'Tool runs. The harness gets the result.' : 'The tool returns its result.', `${argsText(call)}  →  ${summarizeResult(resultText(tool.result))}`]
        : [stage === 5 ? 'Tool runs. The harness runs the script.' : 'The tool runs the script.', `${call?.name || 'tool'}: ${argsText(call)}`];
    case 'append':
      return ['The result goes into the messages list.', 'The model will see it on the next call.'];
    case 'done': {
      const calls = turn - promptTurn;
      const count = `${calls} model call${calls === 1 ? '' : 's'} for this question.`;
      return stage >= 4 ? ['The reply has no tool call, so the loop ends.', count]
        : stage === 3 ? ['The model answers from the tool result.', count] : ['The reply is complete. Done.', count];
    }
    case 'limit':
      return ['The messages list passed the demo limit.', 'The tool calls and results made the list grow.'];
    case 'compact':
      return ['The harness asks the model to summarize older messages.', 'This is called compaction. Newer messages stay in the list.'];
    case 'summary':
      return ['One summary replaces the older messages in the list.', 'The next model call receives the summary and the newer messages.'];
    case 'compactFailed':
      return ['The summary could not be made. The messages list stays as it was.', compactionError];
    case 'error':
      return ['The agent program stopped before returning an answer.', $('notice').textContent];
  }
  return ['', ''];
}

// What changes in each step: one primary element, at most one linked element,
// and the arrows that carry the change. The first visible candidate wins.
const FOCUS = {
  prompt: {primary: ['#blocks .context-block:last-child', '#inputNode'], linked: ['#conversation .message:last-child']},
  call: {primary: ['#model'], linked: ['#contextArea', '#inputNode'], arrows: ['#aCtxModel']},
  reply: {primary: ['#replyNode'], linked: ['#conversation .message:last-child'], arrows: ['#aModelReply']},
  toolcall: {primary: ['#replyNode'], linked: ['#conversation .message:last-child'], arrows: ['#aModelReply']},
  // Stages 3-4 have no permission box: the request goes straight to Run tool.
  permission: {primary: ['#checkNode', '#executor'], arrows: ['#aToolCall', '#bypass']},
  run: {primary: ['#executor'], linked: ['#staging'], arrows: ['#lane2']},
  append: {primary: ['#addNode'], linked: ['#blocks .context-block:last-child'], arrows: ['#lane3', '#aReturn']},
  done: {primary: ['#doneNode', '#replyNode'], linked: ['#conversation .message:last-child'], arrows: ['#aDone']},
  limit: {primary: ['#listMeter', '#contextArea'], linked: ['#contextMgmt']},
  compact: {primary: ['#contextMgmt', '#contextArea'], linked: ['#model']},
  summary: {primary: ['#blocks .compactionSummary'], linked: ['#listMeter']},
  error: {},
};
// The second (or later) model call of one question: the loop closes. One actor
// (the model) and one target (the LOOP counter). Add result is finished, not active.
const LOOP_FOCUS = {primary: ['#model'], linked: ['#loopLabel'], arrows: ['#aCtxModel']};
// Live: the question went out and the model has not answered yet.
const WAIT_FOCUS = {primary: ['#model'], linked: ['#conversation .message:last-child'], arrows: ['#aCtxModel']};

// The one wording of each live wait. Step bar, conversation badge and footer all use it.
const WAIT_TEXT = {start: 'Starting the agent program', model: 'Waiting for the model’s reply', tool: 'Waiting for the tool', thinking: 'The model is thinking', summary: 'Waiting for the summary'};

// True at a model call that receives a tool result: the loop.
const isLoopCall = () => step?.kind === 'call' && messages.at(-1)?.role === 'toolResult';

// Replay only: the recording has no more events, but the question is not done.
const recordingCut = () => replaying && !!step && !queue.length && !['done', 'summary', 'compactFailed', 'error'].includes(step.kind);

// Did the harness block the current tool call? true, false, or null (not known yet).
// A replay knows the outcome ahead, because the result event is already in the queue.
function toolBlocked() {
  if (!tool.call) return null;
  const isBlocked = (err, result) => !!err && /^Error: Blocked by extension: Stage demo policy:|^Stage demo policy:/i.test(resultText(result));
  if (tool.done) return isBlocked(tool.isError, tool.result);
  const end = queue.find(q => q.event?.type === 'tool_execution_end' && q.event.toolCallId === tool.call.id);
  return end ? isBlocked(end.event.isError, end.event.result) : null;
}

// ---------- Applying one raw event ----------

function accept(row) {
  const e = row.event;
  if (e.type === 'viz_reset') {
    const rest = queue, keepTotal = totalSteps, keepPlan = plan;
    reset();
    queue = rest; totalSteps = keepTotal; plan = keepPlan;
  }
  if (!step || startsStep(e, step.kind)) {
    if (kindOf(e) !== null) openStep(kindOf(e));
  }
  events.push(row);
  if (step) { step.events.push(e); step.lastAt = performance.now(); }

  switch (e.type) {
    case 'viz_reset':
      agentReady = false;
      sessionAlive = source === 'live' && !replaying;
      system = e.systemPrompt || '';
      liveTools = e.tools;
      demoLimit = e.demoLimit || 0;
      illustrative = !!e.illustrative;
      if (illustrative) notice('Hand-authored example. No real model run or measured token usage.');
      break;
    case 'viz_system':
      system = e.systemPrompt;
      tools = e.tools;
      break;
    case 'viz_prompt':
      pendingQuestion = e.message || '';
      break;
    case 'agent_start':
      busy = true;
      break;
    case 'turn_start':
      turnPending = true;
      break;
    case 'viz_context':
      countModelCall();
      context = {systemPrompt: system, messages: e.messages, tools};
      break;
    case 'viz_request':
      countModelCall();
      request = e.payload;
      break;
    case 'message_start':
      if (e.message.role === 'user') pendingQuestion = '';
      if (e.message.role === 'toolResult') tool.added = true;
      if (e.message.role === 'assistant') {
        countModelCall();
        current = {role: 'assistant', content: []};
      }
      break;
    case 'message_update': {
      const d = e.assistantMessageEvent;
      if (current && d?.type === 'text_delta') {
        const i = d.contentIndex || 0;
        current.content[i] ||= {type: 'text', text: ''};
        current.content[i].text += d.delta;
      }
      if (d?.type === 'toolcall_end') tool = {call: d.toolCall};
      break;
    }
    case 'message_end': {
      const m = e.message;
      if (m.role === 'user') pendingQuestion = '';
      messages.push(m);
      if (m.role === 'assistant') {
        current = null;
        if (m.usage) usages.push({turn, ...m.usage});
        if (m.errorMessage) notice(m.errorMessage);
      }
      break;
    }
    case 'tool_execution_start':
      tool = {call: {id: e.toolCallId, name: e.toolName, arguments: e.args}};
      break;
    case 'tool_execution_update':
      tool.result = e.partialResult;
      break;
    case 'tool_execution_end':
      tool.result = e.result;
      tool.isError = e.isError;
      tool.done = true;
      break;
    case 'agent_settled':
      if (demoLimit) break;
      busy = false; sending = false;
      break;
    case 'viz_ready':
      busy = false; sending = false;
      break;
    case 'compaction_end':
      compactionError = plainName(e.errorMessage || '');
      break;
    case 'viz_messages_list':
      messages = e.messages;
      context = null;
      break;
    case 'viz_error':
      notice(e.message);
      busy = false; sending = false; sessionAlive = false; errorTarget = 'harness';
      break;
    case 'response':
      if (e.success && e.command === 'get_state') agentReady = true;
      if (!e.success && !['compact', 'get_messages'].includes(e.command)) { notice(e.error || 'The agent program rejected the command.'); busy = false; sending = false; errorTarget = 'harness'; }
      break;
    case 'viz_stopped':
      busy = false; sending = false; sessionAlive = false;
      break;
    case 'viz_exit':
      busy = false; sending = false; sessionAlive = false; errorTarget = 'harness';
      notice(`The agent program exited with code ${e.code}.`);
      break;
  }
  render();
}

// A model call is counted once per turn, when the request actually goes out.
function countModelCall() {
  if (turnPending) { turn++; turnPending = false; if (step) step.turn = turn; }
}

// ---------- Rendering ----------

// Reuse child elements so that animations do not restart on every event.
function syncChildren(parent, count, make) {
  while (parent.children.length > count) parent.lastChild.remove();
  while (parent.children.length < count) parent.append(make());
  return [...parent.children];
}

const setText = (id, s) => { if ($(id).textContent !== s) $(id).textContent = s; };

// The last assistant message, or the reply that streams now.
const latestReply = () => current || [...messages].reverse().find(m => m.role === 'assistant');
const hasToolCall = m => (m?.content || []).some(c => c.type === 'toolCall');

function render() {
  const kind = step?.kind;
  document.body.dataset.step = kind || '';
  document.body.classList.toggle('in-run', !!step);
  document.body.dataset.source = replaying ? 'replay' : source;
  document.body.classList.toggle('raw', raw);
  document.body.classList.toggle('present', !explain);
  $('mode').setAttribute('aria-pressed', String(explain));
  document.body.classList.toggle('is-error', kind === 'error');
  document.body.classList.toggle('is-waiting', !!waitSeconds());

  // Header.
  $('source').textContent = staticRecordings ? 'RECORDING · NO MODEL CALLS' : replaying ? (illustrative ? 'EXAMPLE · HAND-AUTHORED' : step ? 'REPLAY · NO MODEL CALLS' : 'RECORDING LOADED · SEND GOES LIVE')
    : source === 'live' ? 'LIVE · REAL MODEL' : 'OFFLINE · READY';
  $('raw').setAttribute('aria-pressed', String(raw));
  $('rawPanel').hidden = !raw;
  $('conversation').hidden = raw;
  $('panelLabel').textContent = raw ? 'RAW DATA' : 'CONVERSATION';

  // Model and its output. Every label describes the displayed step and agrees
  // with the step bar.
  const wait = liveWait();
  const cut = recordingCut();
  const waitsForModel = kind === 'prompt' && wait === 'model';
  // While the question waits for the model, the call it waits for is already counted.
  setText('turn', `Model calls: ${turn + (waitsForModel ? 1 : 0)}`);
  const writing = current && textOf(current);
  // An error belongs to the agent program, not to the model. The Model box stays neutral.
  setText('modelStatus', kind === 'error' ? (turn ? 'No reply received' : 'No call made')
    : kind === 'prompt' ? (waitsForModel ? 'Waiting…' : wait === 'start' ? 'Not called yet' : 'Idle')
    : kind === 'reply' ? (!current ? 'Reply complete' : !writing ? 'Thinks…' : cut ? 'Was writing' : 'Writes the reply')
    : {call: stage === 1 ? 'Reads the question' : 'Reads the messages list', toolcall: 'Asks for a tool', compact: 'Writes a summary', done: 'Finished'}[kind] || 'Idle');
  setText('replyLabel', stage === 1 ? 'Text out' : 'Reply');
  const reply = latestReply();
  const toolRequested = kind && !['prompt', 'call', 'reply'].includes(kind) && hasToolCall(reply) && tool.call;
  setText('replyStatus', !step ? (stage >= 3 ? 'Text, or a tool call' : 'Text')
    : kind === 'error' ? 'No reply'
    : kind === 'prompt' || kind === 'call' ? 'Not yet'
    : kind === 'reply' && current ? (!writing ? 'Not yet' : cut ? 'Partial text' : 'Text streams…')
    : toolRequested ? `Tool call: ${tool.call.name}`
    : kind === 'toolcall' ? 'Tool call…'
    : 'Text answer');
  $('replyStatus').classList.toggle('wait', $('replyStatus').textContent === 'Not yet');

  // Tool steps. Each label says what is true at the displayed step.
  const blocked = toolBlocked();
  const before = !tool.call || kind === 'toolcall';
  // The check is a rule of the harness. It is shown when the tool starts; the
  // agent program sends no event of its own for it.
  setText('checkStatus', before ? 'At tool start' : blocked ? '✕ Blocked' : blocked === false ? '✓ Allowed' : 'Checking…');
  // Simple view: the check has no event of its own. Raw explains it in full.
  $('checkNote').hidden = before || raw;
  const output = tool.done && tool.result ? fileResult(tool.call?.name) || shortResult(resultText(tool.result)) : '';
  setText('toolStatus', before ? 'Not yet' : kind === 'permission' ? (stage >= 5 ? 'Not yet' : 'Starts…')
    : !tool.done ? `Runs ${argsText(tool.call)}…`
    : blocked ? '✕ Not run' : tool.isError ? 'Failed' : `✓ ${output}`);
  $('executor').classList.toggle('has-output', !!output && !tool.isError);
  setText('resultSummary', tool.added ? (blocked ? '✓ Block added' : tool.isError ? '✓ Error added' : '✓ In the messages list') : 'Not yet');
  for (const id of ['checkStatus', 'toolStatus']) $(id).classList.toggle('blocked', $(id).textContent.startsWith('✕'));
  for (const id of ['checkStatus', 'toolStatus', 'resultSummary']) $(id).classList.toggle('wait', /^(Not yet|At tool start)/.test($(id).textContent));

  // Usage (Raw only).
  const total = usages.reduce((n, u) => n + (u.totalTokens || 0), 0);
  const last = usages.at(-1);
  $('usage').textContent = last ? `Tokens · call ${last.turn}: ${last.input || 0} in / ${last.output || 0} out · ${total.toLocaleString()} total` : 'Token usage appears when reported';
  $('usage').title = JSON.stringify(usages, null, 2);

  renderContext();
  renderConversation();
  renderRaw();
  renderStepBar();
  renderWait();
  renderFocus();

  // Speaker controls.
  const live = source === 'live' && !replaying;
  // Send works in every idle state, also with a recording loaded: it starts a live session.
  $('send').disabled = !!(submitting || (live && (busy || sending)) || !$('prompt').value.trim());
  // After Stop or an error, Send first starts a new agent program. Its label says so.
  $('send').textContent = live && (sending || busy) ? 'Working…' : live && !sessionAlive ? 'Restart and send ↗' : 'Send ↗';
  $('send').title = replaying ? 'Send starts a live session with the real model.' : '';
  // The Next button is only for Step mode. When it cannot act, its label says why.
  $('step').hidden = !stepMode();
  $('step').disabled = !queue.length && !replayEnded();
  const stepLabelHtml = queue.length ? (nextIsQuestion() ? 'Next question <kbd>Space</kbd>' : 'Next step <kbd>Space</kbd>')
    : replayEnded() ? 'Play again <kbd>Space</kbd>'
    : kind === 'done' || !step ? 'Next: ask a question'
    : kind === 'error' ? 'Stopped'
    : 'Waiting for the agent…';
  if ($('step').innerHTML !== stepLabelHtml) $('step').innerHTML = stepLabelHtml;
  $('recovery').hidden = kind !== 'error';
  // The question is in the conversation once a replay runs; the composer has no
  // use then. After an error, the recovery button in the step bar sends it.
  document.body.classList.toggle('compose-hidden', !!staticRecordings || (replaying && !!step) || kind === 'error');
  document.body.classList.toggle('answer-done', kind === 'done');
  $('heldPill').hidden = !(live && stepMode() && paused && queue.length);
  $('replay').textContent = replaying && $('recordings').value === loadedRecording ? 'Restart' : 'Play';
}

// Replay: the next step starts a new question (the current one is complete).
const nextIsQuestion = () => !!step && plan[step.n] === 'prompt';
// Replay: every recorded event is shown. Space or Restart plays it again.
const replayEnded = () => replaying && !!loadedRecording && !queue.length && !!step;

function renderContext() {
  const summary = messages.find(m => m.role === 'compactionSummary');
  const entries = [
    ...(summary ? [summary] : []),
    {role: 'system', content: [{type: 'text', text: system || 'The instructions appear when the session starts.'}]},
    ...(liveTools && stage >= 3 ? [{role: 'tools', tools}] : []),
    ...messages.filter(m => m !== summary),
    ...(pendingQuestion ? [{role: 'user', pending: true, content: [{type: 'text', text: pendingQuestion}]}] : []),
  ];
  // Keep the instructions, tools and summary visible as the list grows.
  const MAX = demoLimit && stage === 5 ? 5 : 6;
  const fixed = entries.filter(m => ['system', 'tools', 'compactionSummary'].includes(m.role));
  const recent = entries.filter(m => !fixed.includes(m));
  const shown = entries.length > MAX
    ? [...fixed, {role: 'more', count: entries.length - MAX + 1}, ...recent.slice(-(MAX - fixed.length - 1))]
    : entries;
  const chars = messageCharacters(messages);
  const toolNames = tools.length ? tools.map(t => t.name) : stage === 3 ? ['bash'] : ['read', 'write', 'bash'];
  const nodes = syncChildren($('blocks'), shown.length, () => {
    const b = document.createElement('button');
    b.append(document.createElement('span'), document.createElement('small'));
    return b;
  });
  shown.forEach((m, i) => {
    const b = nodes[i];
    const text = m.role === 'tools' ? JSON.stringify(m.tools) : textOf(m);
    const name = m.role === 'more' ? `+${m.count} earlier`
      : m.role === 'tools' ? 'Tool list'
      : m.role === 'compactionSummary' ? 'Summary'
      : m.role === 'toolResult' ? 'Tool result'
      : m.role === 'assistant' ? (hasToolCall(m) ? 'Tool call' : 'Model reply')
      : m.role === 'user' ? 'User' : 'Instructions';
    b.className = `context-block ${m.role}${m.pending ? ' pending' : ''}${hasToolCall(m) ? ' toolcall' : ''}${m.role === 'tools' && stage === 3 ? ' is-new' : ''}`;
    // Stage 2 introduces the instructions once by their technical name.
    const extra = m.role === 'system' ? '<span class="aka">system prompt</span>'
      : m.role === 'tools' ? `<span class="tool-count"> · ${toolNames.length} tools</span>` : '';
    const html = escapeHtml(name) + extra;
    if (b.firstChild.innerHTML !== html) b.firstChild.innerHTML = html;
    b.lastChild.textContent = m.role === 'more' ? '' : `${text.length.toLocaleString()} chars`;
    b.title = m.role === 'tools' ? toolNames.join(', ') : '';
    b.onclick = m.role === 'more' ? null : () => inspect(m.role === 'system' ? 'Instructions (system prompt)' : name,
      m.role === 'compactionSummary' ? presentSummary(text) : m.role === 'system' ? text : m.role === 'tools' ? (tools.length ? tools : toolNames) : m);
  });
  $('contextSize').textContent = `${chars.toLocaleString()} text characters`;
  $('listMeter').hidden = !demoLimit;
  if (demoLimit) {
    const format = n => n.toLocaleString('en-US');
    setText('listCount', `${format(chars)} / ${format(demoLimit)} characters`);
    $('listFill').style.width = `${Math.min(100, 50 * chars / demoLimit)}%`;
    $('listMeter').classList.toggle('over-limit', chars > demoLimit);
  }
}

// HTML of one message in Simple mode.
function messageHtml(m) {
  if (m.role === 'compactionSummary') return markdown(presentSummary(textOf(m)));
  if (m.role === 'toolResult') {
    if (!m.isError && fileResult(m.toolName)) return escapeHtml(fileResult(m.toolName));
    const text = textOf(m);
    const summary = summarizeResult(text);
    return summary === shorten(text, 120) ? escapeHtml(text) : `<strong>${escapeHtml(summary)}</strong>`;
  }
  return (m.content || []).map(c => c.type === 'text' ? markdown(c.text)
    : c.type === 'toolCall' ? `Tool call: <span class="call">${escapeHtml(c.name)} · ${escapeHtml(argsText(c))}</span>` : '')
    .filter(Boolean).join('\n');
}

function renderConversation() {
  const conv = $('conversation');
  // The streaming reply appears when the model starts to answer, not when it is called.
  const streaming = current && (textOf(current) || ['reply', 'toolcall'].includes(step?.kind));
  const pending = pendingQuestion ? [{role: 'user', pending: true, content: [{type: 'text', text: pendingQuestion}]}] : [];
  // The tool ran, but its result is not in the conversation yet. It waits in its
  // own staging area under the conversation.
  const output = tool.done && tool.result && !tool.added && step?.kind === 'run';
  $('staging').hidden = !output;
  if (output) {
    const html = messageHtml({role: 'toolResult', toolName: tool.call?.name, isError: tool.isError, content: tool.result.content || []});
    if ($('stagingText').dataset.html !== html) { $('stagingText').dataset.html = html; $('stagingText').innerHTML = html; }
  }
  const shown = [...messages, ...pending, ...(streaming ? [current] : [])];
  if (!shown.length) {
    const text = replaying ? 'The conversation appears here.' : 'Ask a question.\nWatch what happens around the model.';
    if (conv.querySelector('.empty')?.textContent !== text) conv.innerHTML = `<p class="empty">${text}</p>`;
    return;
  }
  conv.querySelector('.empty')?.remove();
  const nodes = syncChildren(conv, shown.length, () => {
    const a = document.createElement('article');
    a.append(document.createElement('small'), document.createElement('p'));
    return a;
  });
  const failed = step?.kind === 'error';
  shown.forEach((m, i) => {
    const a = nodes[i];
    a.className = `message ${m.role}${m.pending ? ' pending' : ''}${m.pending && failed ? ' error' : ''}`;
    const who = m.role === 'user' ? 'You' : m.role === 'compactionSummary' ? 'Summary written by the model'
      : m.role === 'toolResult' ? 'Tool result → messages list' : hasToolCall(m) ? 'Model · tool call' : 'Model';
    const w = liveWait();
    const tag = m.pending ? `<em>${failed ? 'No answer' : w === 'start' ? 'Waits for the agent program' : 'Sent · waiting for the model’s reply'}</em>` : '';
    const label = escapeHtml(who).replace(' → messages list', '<span class="to-ctx"> → messages list</span>') + tag;
    if (a.firstChild.innerHTML !== label) a.firstChild.innerHTML = label;
    const html = messageHtml(m) || (m === current ? '<span class="wait">Thinking…</span>' : '');
    if (a.lastChild.dataset.html !== html) { a.lastChild.dataset.html = html; a.lastChild.innerHTML = html; }
  });
  conv.scrollTop = step?.kind === 'summary' ? 0 : conv.scrollHeight;
}

// One-line explanation of the raw events of each step kind.
const RAW_NOTE = {
  prompt: 'Your question goes into the messages list.',
  call: 'The messages list goes to the model.',
  reply: 'The reply arrives in small pieces (deltas).',
  toolcall: 'The tool call is structured data in the reply.',
  permission: 'The agent program sends no event for the permission check. The page shows the check at tool_execution_start.',
  run: 'The tool runs and returns its output.',
  append: 'The tool result goes into the messages list.',
  done: 'The agent program reports that the question is finished.',
  limit: 'The demo counts message text, tool arguments and any existing summary.',
  compact: 'The harness uses the agent program’s compact command to ask the model for a summary.',
  summary: 'The agent program reports the exact messages list that it will use next.',
  error: 'The agent program reports a failure.',
};

function renderRaw() {
  const summaryEl = $('rawSummary');
  if (!raw) return;
  const choice = $('rawSelect').value;
  summaryEl.hidden = choice !== 'step' || !step;
  if (choice === 'step') {
    if (!step) { setJson('No step yet. The raw events of the current step appear here.'); return; }
    // Summary first: "message_update:text_delta ×39" etc. and one line of explanation. Then the events.
    const names = step.events.map(e => e.type + (e.assistantMessageEvent ? ':' + e.assistantMessageEvent.type : ''));
    const summary = [];
    for (const n of names) {
      const lastItem = summary.at(-1);
      if (lastItem?.name === n) lastItem.count++; else summary.push({name: n, count: 1});
    }
    const html = `<b>Step ${displayNumber(step.n)}: ${step.events.length} raw event${step.events.length === 1 ? '' : 's'}</b>`
      + `<ul>${summary.map(s => `<li><code>${escapeHtml(s.name)}</code>${s.count > 1 ? ' ×' + s.count : ''}</li>`).join('')}</ul>`
      + (RAW_NOTE[step.kind] ? `<p>${escapeHtml(RAW_NOTE[step.kind])}</p>` : '');
    if (summaryEl.dataset.html !== html) { summaryEl.dataset.html = html; summaryEl.innerHTML = html; }
    setJson(step.events.map(e => JSON.stringify(e, null, 2)).join('\n'));
    return;
  }
  const values = {
    request: request || {note: 'No provider payload captured yet. Start live or replay.'},
    context: context || {systemPrompt: system, messages, tools, note: 'Current messages list. Provider request shows the last request sent.'},
    tool,
    events,
  };
  setJson(JSON.stringify(values[choice], null, 2));
}

// Long ids (toolCallId, responseId, ...) are noise on a projector. Show a short
// form; the full value is in the tooltip.
function setJson(text) {
  text = stageText(text);
  if ($('json').dataset.text === text) return;
  $('json').dataset.text = text;
  $('json').innerHTML = escapeHtml(text).replace(/(&quot;\w*(?:id|Id|ID|Signature)&quot;: &quot;)([^&\s]{19,})(&quot;)/g,
    (m, a, v, b) => `${a}<abbr title="${v}">${v.slice(0, 10)}…${v.slice(-4)}</abbr>${b}`);
}

function renderStepBar() {
  const [main, detail] = caption();
  const total = questionTotal();
  $('stepCount').textContent = step ? String(displayNumber(step.n)) : '–';
  $('stepTotal').textContent = step && total ? `of ${total}` : '';
  if ($('stepCaption').textContent !== main) {
    $('stepCaption').textContent = main;
    // Restart the entry animation only when the caption really changes.
    $('stepBar').classList.remove('changed');
    void $('stepBar').offsetWidth;
    $('stepBar').classList.add('changed');
  }
  const items = trail.map(t => `<span><b>${t.n}</b> ${escapeHtml(stepLabel(t))}</span>`);
  // Every state names the next action: the next step, a new question, or the end of a recording.
  const next = plan[step?.n ?? 0];
  const live = source === 'live' && !replaying;
  // Before the first step: the two real paths. After a replay: the two real actions.
  const choices = !step
    ? [queue.length && stepMode() ? 'Space: play the recording' : '', staticRecordings ? '' : queue.length && stepMode() ? 'or press Send to ask the live model' : 'Type and Send: ask the live model'].filter(Boolean)
    : replayEnded() ? ['Space / Restart: play again', staticRecordings ? '' : 'New live session'].filter(Boolean)
    : [];
  const nextText = choices.length || !step ? ''
    : next ? `Next: ${next === 'prompt' ? 'a new question' : escapeHtml(stepLabel({kind: next}))}`
    : ['done', 'summary', 'compactFailed'].includes(step.kind) && live && !busy && !sending ? 'Next: new question · Send'
    : '';
  if (replayEnded()) items.push('<span class="next">Recording ended</span>');
  else if (nextText) items.push(`<span class="next">${nextText}</span>`);
  const html = items.join('<i>→</i>') + (choices.length ? `<div class="choices">${choices.map(c => `<span>${c}</span>`).join('')}</div>` : '');
  if ($('stepTrail').innerHTML !== html) $('stepTrail').innerHTML = html;
  // The hint names the next action only when one exists.
  const nextName = nextIsQuestion() ? 'next question' : 'next step';
  $('stepHint').textContent = !stepMode() || !step || !queue.length ? ''
    : paused ? `Space: ${nextName}` : 'Space: finish this step';
  setText('stepDetail', detail || '');
}

// Live only: what the page waits for now, or null. One value drives every
// waiting label on the screen.
function liveWait() {
  if (source !== 'live' || replaying || !(sending || busy) || queue.length || paused) return null;
  if (!agentReady) return 'start';
  const k = step?.kind;
  if (k === 'limit' || k === 'compact') return 'summary';
  if (k === 'permission' || k === 'run') return 'tool';
  if (k === 'reply' && current && !textOf(current)) return 'thinking';
  return 'model';
}

// Live only: seconds since the last event while the agent works and nothing arrives.
// Without this, the page looks frozen while the agent program starts or the model thinks.
function waitSeconds() {
  if (!liveWait()) return 0;
  const since = step ? step.lastAt || step.openedAt : null;
  if (!since || performance.now() - since < 1200) return 0;
  return Math.max(1, Math.round((performance.now() - since) / 1000));
}

function renderWait() {
  const s = waitSeconds();
  const kind = step?.kind;
  const state = $('state');
  if (s) {
    const what = WAIT_TEXT[liveWait()];
    setText('stepDetail', `${what} · ${s} s · press Stop to cancel`);
    state.textContent = `${what} · ${s} s`;
    state.dataset.kind = 'waiting';
    setText('speakerStatus', `${what} · ${s} s`);
  } else {
    state.textContent = kind === 'error' ? 'Error · no answer' : kind === 'done' ? 'Done'
      : recordingCut() ? (kind === 'reply' ? 'Recording ended during the reply' : 'Recording ends here')
      : current && kind === 'reply' && textOf(current) ? 'Model writes'
      : source === 'live' && !replaying && !agentReady && sessionAlive ? WAIT_TEXT.start
      : source === 'live' && !replaying && (sending || busy) ? 'Working'
      : step ? 'In progress' : 'Ready';
    state.dataset.kind = kind === 'error' ? 'error' : kind === 'done' ? 'done' : recordingCut() ? 'ended' : '';
    setText('speakerStatus', '');
  }
  document.body.classList.toggle('is-waiting', !!s);
}

// Highlight the elements of the current step. The rest stays readable but quieter.
function renderFocus() {
  const kind = step?.kind;
  const looping = isLoopCall();
  const f = looping ? LOOP_FOCUS
    : kind === 'prompt' && liveWait() === 'model' ? WAIT_FOCUS
    : FOCUS[kind] || {};
  const visible = el => el && el.offsetParent !== null && !el.closest('.absent');
  const first = sels => {
    for (const sel of sels || []) for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
    return null;
  };
  const primary = first(f.primary);
  const linked = [first(f.linked)].filter(el => el && el !== primary);
  document.querySelectorAll('.focus').forEach(el => { if (el !== primary) el.classList.remove('focus'); });
  document.querySelectorAll('.linked').forEach(el => { if (!linked.includes(el)) el.classList.remove('linked'); });
  primary?.classList.add('focus');
  linked.forEach(el => el.classList.add('linked'));
  // Exactly one "now" element: the Model box is filled only while it is the focus.
  $('model').classList.toggle('active', primary === $('model'));
  // Stages 3-4: the bypass corner and the lane into Run tool form one path.
  const arrowSels = kind === 'permission' && stage < 5 ? [...(f.arrows || []), '#lane2'] : f.arrows || [];
  const arrows = new Set(arrowSels.map(sel => document.querySelector(sel)));
  document.querySelectorAll('.arrow, #bypass').forEach(a => a.classList.toggle('on', arrows.has(a)));
  document.body.classList.toggle('focusing', !!primary);
  document.body.classList.toggle('looping', looping);
  // An error marks the agent program in red: the harness frame and its status
  // label. The model did not fail, so its box stays neutral.
  const failed = kind === 'error' ? [$('diagram')] : [];
  $('programStatus').hidden = kind !== 'error';
  setText('programDetail', kind === 'error' ? (turn ? 'The model reply never arrived' : 'No model call was made') : '');
  document.querySelectorAll('.failed').forEach(el => { if (!failed.includes(el)) el.classList.remove('failed'); });
  failed.forEach(el => el.classList.add('failed'));
}

// ---------- Playback loop ----------

// How long each step stays on screen before the next one starts (continuous mode).
// The step also stays for 60 % of this time after its last event.
function holdTime() {
  if ($('slow').checked) return 2600;
  return replaying ? 1300 : 350;
}

// Delay between two events inside one step.
function eventDelay(e) {
  if (!e) return 40;
  if (isStreamDelta(e)) return $('slow').checked ? 70 : replaying ? 30 : 15;
  return $('slow').checked ? 250 : replaying ? 90 : 15;
}

function playback() {
  const next = queue[0];
  if (next) {
    if (!isBoundary(next.event)) {
      accept(queue.shift());
    } else if (stepMode()) {
      if (!paused) { paused = true; render(); }
    } else if (!step || (performance.now() - step.openedAt >= holdTime() && performance.now() - step.lastAt >= holdTime() * 0.6)) {
      paused = false;
      accept(queue.shift());
    }
  }
  // Keep the live wait text ("… 7 s") current while no event arrives.
  const wait = waitSeconds();
  if (wait !== playback.lastWait) { playback.lastWait = wait; render(); }
  setTimeout(playback, eventDelay(queue[0]));
}

// Space / Next step. First press finishes a step that is still streaming.
// Otherwise it opens the next step. Its other events then stream in quickly.
function nextStep() {
  if (!queue.length && replayEnded()) { loadReplay(loadedRecording).catch(e => notice(e.message)); return; }
  if (!queue.length) return;
  if (step && !isBoundary(queue[0].event)) {
    while (queue.length && !isBoundary(queue[0].event)) accept(queue.shift());
  } else {
    while (queue.length && !isBoundary(queue[0].event)) accept(queue.shift());
    if (queue.length) accept(queue.shift());
  }
  paused = false;
  render();
}

// ---------- Live and replay ----------

async function setStage(n, recording) {
  const old = stage;
  stage = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.trunc(n))) : 1;
  const prompt = $('prompt');
  const stage3Prompt = 'Run the prepared Goldbach checker goldbach.cjs. ' + prompt.defaultValue;
  if (stage === 3 && prompt.value === prompt.defaultValue) prompt.value = stage3Prompt;
  if (stage !== 3 && old === 3 && prompt.value === stage3Prompt) prompt.value = prompt.defaultValue;
  document.body.dataset.stage = stage;
  // Fixed geometry: every part keeps its place in all stages. A stage only makes
  // parts visible. The parts new in this stage carry a NEW tag.
  document.querySelectorAll('[data-from], [data-until]').forEach(el => {
    const from = Number(el.dataset.from || 1), until = Number(el.dataset.until || 5);
    el.classList.toggle('absent', stage < from || stage > until);
    el.classList.toggle('is-new', stage === from && from > 1);
  });
  $('diagram').classList.remove('revealing');
  if (old !== stage) requestAnimationFrame(() => $('diagram').classList.add('revealing'));
  const t = titles[stage - 1];
  $('eyebrow').textContent = `0${stage} / ${t[0]}`;
  $('title').textContent = t[1];
  $('subtitle').textContent = t[2];
  $('lesson').textContent = t[3];
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('selected', Number(b.dataset.stage) === stage));
  labelRecordings();
  // Each stage selects its own recording, with step mode on. Send or New live session goes live.
  if (old !== stage || !loadedRecording) {
    $('stepMode').checked = true;
    paused = false;
    await loadReplay(recording || RECORDING_FOR_STAGE(stage)).catch(e => notice(e.message));
  }
  render();
}

async function startLive() {
  if (staticRecordings) return false;
  const revision = ++sourceRevision;
  source = 'live';
  replaying = false;
  sending = false;
  sessionAlive = false;
  agentReady = false;
  loadedRecording = '';
  reset();
  liveTools = stage >= 3;
  await changeSession('session', {tools: liveTools, compact: stage === 5, singleTool: stage === 3});
  if (revision !== sourceRevision) return false;
  sessionAlive = true;
  notice('Live session with a real model. Step mode pauses the display, not execution.');
  render();
  return true;
}

async function listRecordings() {
  const old = $('recordings').value;
  const names = staticRecordings ? Object.keys(staticRecordings) : await (await fetch('/api/recordings')).json();
  // The two recordings for the talk first, then the newest sessions.
  const rank = n => { const i = STAGE_RECORDINGS.indexOf(n); return i < 0 ? 9 : i; };
  const sorted = names.sort().sort((a, b) => rank(a) - rank(b));
  $('recordings').replaceChildren(new Option('Choose a recording…', ''), ...sorted.map(n => new Option('', n)));
  labelRecordings();
  $('recordings').value = names.includes(old) ? old : names.includes(loadedRecording) ? loadedRecording : '';
}

function labelRecordings() {
  for (const option of $('recordings').options) {
    if (!option.value) continue;
    option.text = `Recording: ${stageText(recordingName(option.value))}`;
    option.title = stage < 5 && /\bharness\b/i.test(option.value) ? '' : option.value;
  }
}

async function loadReplay(name) {
  if (!name) { notice('Choose a recording first.'); return; }
  const revision = ++sourceRevision;
  source = 'replay';
  replaying = true;
  sending = false;
  sessionAlive = false;
  agentReady = false;
  loadedRecording = '';
  reset();
  notice('Loading recording…');
  if (!staticRecordings) await changeSession('stop');
  if (revision !== sourceRevision) return;
  let rows = staticRecordings?.[name];
  if (staticRecordings && !rows) throw Error('Recording not included in this page.');
  if (!staticRecordings) {
    const response = await fetch('/api/recording?name=' + encodeURIComponent(name));
    if (!response.ok) throw Error('Could not load the recording. Choose another stage or retry.');
    const data = await response.text();
    rows = data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  if (revision !== sourceRevision) return;
  loadedRecording = name;
  if ([...$('recordings').options].some(o => o.value === name)) $('recordings').value = name;
  queue = structuredClone(rows);
  plan = planSteps(queue);
  totalSteps = plan.length;
  notice('Replay: recorded events, no model calls.');
  render();
}

if (!staticRecordings) {
  const stream = new EventSource('/events');
  stream.onmessage = e => { if (source === 'live') queue.push(JSON.parse(e.data)); };
  stream.onerror = () => { if (source === 'live') notice('Server connection lost. Reconnecting…'); };
  // Free the connection when the page goes away. Open event streams count against the browser's per-server connection limit.
  addEventListener('pagehide', () => stream.close());
}

// ---------- Controls ----------

document.querySelectorAll('nav button').forEach(b => b.onclick = () => setStage(Number(b.dataset.stage)));
$('raw').onclick = () => { raw = !raw; render(); };
$('mode').onclick = () => { explain = !explain; try { localStorage.setItem('harness-explain', explain ? '1' : '0'); } catch {} render(); };
$('rawSelect').onchange = render;
$('live').onclick = () => startLive().catch(e => notice(e.message));
// Restart the agent program and send the question again.
$('recoverLive').onclick = () => $('promptForm').requestSubmit();
$('recoverReplay').onclick = () => {
  const name = $('recordings').value || RECORDING_FOR_STAGE(stage);
  loadReplay(name).catch(e => notice(e.message));
};
$('stop').onclick = async () => {
  if (staticRecordings) return;
  const revision = ++sourceRevision;
  try { await changeSession('stop'); } catch (e) { notice(e.message); return; }
  if (revision !== sourceRevision) return;
  queue = []; busy = false; paused = false; sending = false; pendingQuestion = ''; sessionAlive = false;
  notice('Stopped. Send starts a new live session.');
  render();
};
$('replay').onclick = () => loadReplay($('recordings').value).catch(e => notice(e.message));
$('stepMode').onchange = () => {
  paused = false;
  render();
};
$('step').onclick = nextStep;
$('permissions').onclick = () => inspect('Permissions', 'The harness lets the model ask to read or write goldbach.cjs in this session’s folder. The only command it lets the model ask to run is node goldbach.cjs. The harness blocks other tool requests.');
$('contextMgmt').onclick = () => inspect('Context management', 'The harness decides what goes into the messages list. When the list passes the small demo limit, the harness asks the model to summarize older messages. The model receives the summary and the newer messages on the next call.');
$('usage').onclick = () => inspect('Usage per model call', usages);
$('closeDetail').onclick = () => $('detail').close();
$('prompt').addEventListener('input', render);
$('promptForm').onsubmit = async e => {
  e.preventDefault();
  if (staticRecordings) return;
  if (submitting || (source === 'live' && (sending || busy)) || !$('prompt').value.trim()) return;
  submitting = true;
  try {
    if (source !== 'live' || replaying || !sessionAlive || step?.kind === 'error') {
      if (!await startLive()) return;
    }
    sending = true; render();
    await api('prompt', {message: $('prompt').value});
  } catch (err) {
    sending = false; render();
    notice(err.message);
  } finally {
    submitting = false; render();
  }
};

document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || $('detail').open) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); setStage(stage + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); setStage(stage - 1); }
  if (e.key.toLowerCase() === 'r') $('raw').click();
  if (e.key.toLowerCase() === 'e') $('mode').click();
  if (e.code === 'Space') { e.preventDefault(); nextStep(); }
});

// ---------- Start ----------

// The page opens with the stage's recording loaded and step mode on (see setStage).
listRecordings().then(() => setStage(Number(params.get('stage')) || 1, params.get('recording'))).then(() => {
  if (params.get('step') === '0') $('stepMode').checked = false;
}).catch(e => notice(e.message));
raw = params.get('raw') === '1';
// Present mode (less text) is the default. ?explain=1 or the E key shows all explanations.
try { explain = localStorage.getItem('harness-explain') === '1'; } catch {}
if (params.has('explain')) explain = params.get('explain') === '1';
render();
playback();

// Read-only state for the local verification script.
window.demoState = () => ({
  stage, raw, explain, turn, eventCount: events.length, queued: queue.length, paused,
  messages: messages.length, step: step && {n: step.n, kind: step.kind, events: step.events.length},
  totalSteps, caption: caption()[0], request: !!request,
  waiting: liveWait(), waitSeconds: waitSeconds(),
});
