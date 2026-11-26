// File-only replay checks. Own Edge profile/process; no requests to the live server.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const profile = path.resolve(root, 'recordings/sessions', 'edge-static-' + Date.now());
const port = 9481;
fs.mkdirSync(profile, {recursive: true});
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=' + port,
  '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank',
], {stdio: 'ignore', windowsHide: true});
let ws;
const stop = () => {
  ws?.close();
  if (edge.exitCode === null && edge.pid) {
    try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true, timeout: 5000}); }
    catch { edge.kill(); }
  }
};
const timeout = setTimeout(() => { stop(); console.error('Static check timed out'); process.exit(1); }, 60000);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await delay(100); }
  throw Error('Condition timed out');
}
try {
  const tabs = await until(async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/json`, {signal: AbortSignal.timeout(500)})).json(); }
    catch { return null; }
  });
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map(), errors = [], requests = [];
  ws.onmessage = ({data}) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry);
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const r = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await cdp(domain + '.enable');
  const url = pathToFileURL(path.join(root, 'dist/harness-replay.html')).href;
  await cdp('Page.navigate', {url});
  await until(() => evaluate("window.demoState?.().paused && loadedRecording === '1-model.jsonl'"));
  assert.equal(await evaluate('document.title'), 'From Chatbots to Agents');
  assert.equal(await evaluate("document.querySelector('nav [data-stage=\"5\"]').textContent"), '05 Harness');
  assert.equal(await evaluate("$('recordings').options.length"), 6);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#promptForm,#live,#stop,#recoverLive')].map(el=>el.getBoundingClientRect().height)"), [0, 0, 0, 0]);
  const checks = [];
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    await cdp('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    for (const detailed of [false, true]) {
      await evaluate('explain = ' + detailed);
      const report = await evaluate('(' + (async () => {
        const stages = [];
        function bounds(id) {
          const {x, y, width, height} = $(id).getBoundingClientRect();
          return [x, y, width, height];
        }
        const showsHarness = () => /\bharness\b/i.test(document.body.innerText.replace('05 Harness', ''));
        for (let n = 1; n <= 5; n++) {
          await setStage(n);
          if (step || !queue.length) await loadReplay(RECORDING_FOR_STAGE(n));
          while (queue.length && !isBoundary(queue[0].event)) accept(queue.shift());
          const geometry = ['contextArea', 'model', 'replyNode', 'addNode', 'executor'].map(bounds);
          const steps = [], calls = [];
          let before, after, answer, summaryVisible, summaryInspect, limitMarked, counts, script;
          let mentionsHarness = showsHarness();
          while (queue.length) {
            nextStep();
            while (queue.length && !isBoundary(queue[0].event)) accept(queue.shift());
            steps.push(step.kind);
            if (step.kind === 'run') {
              calls.push(tool.call?.name);
              if (tool.call?.name === 'bash') script = argsText(tool.call);
            }
            if (step.kind === 'limit') {
              before = messageCharacters(messages);
              limitMarked = $('listMeter').classList.contains('over-limit');
            }
            if (step.kind === 'summary') {
              after = messageCharacters(messages);
              counts = $('listCount').textContent;
              $('raw').click(); // The summary remains visible in Raw too.
              const block = $('blocks').querySelector('.compactionSummary');
              const r = block.getBoundingClientRect(), parent = $('blocks').getBoundingClientRect();
              summaryVisible = r.height > 0 && r.bottom <= parent.bottom + 1;
              block.click();
              summaryInspect = $('detailTitle').textContent === 'Summary' && /991/.test($('detailText').textContent);
              $('detail').close();
              $('raw').click();
            }
            if (step.kind === 'done') answer = textOf(messages.at(-1));
            mentionsHarness ||= showsHarness();
          }
          if (n < 5) {
            $('raw').click();
            for (const option of $('rawSelect').options) {
              $('rawSelect').value = option.value;
              renderRaw();
              mentionsHarness ||= showsHarness();
            }
            $('rawSelect').value = 'step';
            $('raw').click();
            const instructions = $('blocks').querySelector('.context-block.system');
            if (instructions) {
              instructions.click();
              mentionsHarness ||= /\bharness\b/i.test($('detailText').textContent);
              $('detail').close();
            }
          }
          stages.push({loadedRecording, geometry, steps, calls, script, mentionsHarness, before, after, answer, summaryVisible, summaryInspect, limitMarked, counts});
        }
        return stages;
      }).toString() + ')()');
      assert.deepEqual(report.map(r => r.loadedRecording), ['1-model.jsonl', '2-chat.jsonl', '3-tools.jsonl', '4-loop.jsonl', '5-harness.jsonl']);
      assert.deepEqual(report.map(r => r.steps.at(-1)), Array(5).fill('done'));
      assert.deepEqual(report[0].steps, ['prompt', 'call', 'reply', 'done']);
      assert.deepEqual(report[1].steps, [...report[0].steps, ...report[0].steps]);
      assert.deepEqual(report.slice(2).map(r => r.calls), [['bash'], ['write', 'read', 'bash'], ['write', 'read', 'bash']]);
      assert.deepEqual(report[2].steps, ['prompt', 'call', 'toolcall', 'permission', 'run', 'append', 'call', 'reply', 'done']);
      assert.equal(report[2].script, 'node goldbach.cjs');
      assert.match(report[2].answer, /498/);
      assert.deepEqual(report.map(r => r.mentionsHarness), [false, false, false, false, true]);
      assert.deepEqual(report[2].geometry, report[3].geometry);
      assert.deepEqual(report[3].geometry, report[4].geometry);
      const harness = report[4];
      assert.ok(harness.before > 1200 && harness.after < 1200);
      assert.deepEqual(harness.steps.slice(-7), ['limit', 'compact', 'summary', 'prompt', 'call', 'reply', 'done']);
      assert.ok(harness.summaryVisible && harness.summaryInspect && harness.limitMarked, JSON.stringify({width, summaryVisible: harness.summaryVisible, summaryInspect: harness.summaryInspect, limitMarked: harness.limitMarked}));
      assert.match(harness.counts, /\/ 1,200 characters$/);
      assert.match(harness.answer, /498/);
      assert.match(harness.answer, /\b7\b.*\b991/s);
      checks.push({width, height, detailed, steps: report.map(r => r.steps), before: harness.before, after: harness.after});
    }
  }
  await evaluate("$('replay').click()");
  await until(() => evaluate('!window.demoState().step && window.demoState().paused'));
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' '}))");
  assert.equal(await evaluate('window.demoState().step.kind'), 'prompt');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.filter(u => !u.startsWith('file:')), []);
  console.log(JSON.stringify(checks));
} finally { clearTimeout(timeout); stop(); }
