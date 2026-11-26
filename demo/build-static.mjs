// Rebuild from the current design files; never fetch or start a live session.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const credentialField = /^(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|token|key|password|secret|client[-_]?secret|prompt_cache_key)$/i;
const localPath = /(?:[a-z]:[\\/]|\\\\)[^\s"<>|]+|\/(?:home|Users)\/[^\s"<>]+/gi;
const secretValue = /\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\-]{12,})/gi;
const environmentSecrets = Object.entries(process.env)
  .filter(([key, value]) => /token|key|authorization|secret|password/i.test(key) && value?.length > 7)
  .map(([, value]) => value);
let redactions = 0;
function sanitize(value, key = '') {
  if (credentialField.test(key) || /^(?:thinkingSignature|encrypted_content)$/i.test(key)) {
    redactions++;
    return '[redacted for static replay]';
  }
  if (typeof value === 'string') {
    for (const secret of environmentSecrets) value = value.split(secret).join('[redacted]');
    return value.replace(secretValue, () => { redactions++; return '[redacted]'; })
      .replace(localPath, () => { redactions++; return '/demo/sandbox'; });
  }
  if (Array.isArray(value)) return value.map(v => sanitize(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}

const recordings = Object.fromEntries(['1-model.jsonl', '2-chat.jsonl', '3-tools.jsonl', '4-loop.jsonl', '5-harness.jsonl'].map(name => [name,
  read('recordings/' + name).trim().split('\n').filter(Boolean).map(line => sanitize(JSON.parse(line))),
]));
const data = JSON.stringify({recordings});
// Scan the output as well. Token usage and tool schema keys are ordinary data.
if (/[a-z]:[\\/](?:Users|home)[\\/]|AlexanderKammerer|\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\-]{12,})/i.test(data)) {
  throw Error('Private path or credential remains in embedded data.');
}
const audit = Object.fromEntries(['token', 'key', 'authorization'].map(term => [term, (data.match(new RegExp(term, 'gi')) || []).length]));
const style = read('style.css');
const app = read('app.js');
let html = read('index.html');
const styleTag = '<link rel="stylesheet" href="/style.css">';
const scriptTag = '<script src="/app.js"></script>';
if (!html.includes(styleTag) || !html.includes(scriptTag)) throw Error('Update static build markers to match index.html.');
html = html.replace(styleTag, () => `<style>${style}</style>
<style>/* Static replay only: hide controls that need a live server. */
#promptForm, .group:has(#live), #recoverLive { display: none !important; }
</style>`).replace(scriptTag, () => `<script id="replay-data" type="application/json">${data.replace(/</g, '\\u003c')}</script>
<script>window.HARNESS_STATIC = JSON.parse(document.getElementById('replay-data').textContent);</script>
<script>${app.replace(/<\/script/gi, '<\\/script')}</script>`);
fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
fs.writeFileSync(path.join(root, 'dist/harness-replay.html'), html);
console.log(JSON.stringify({file: 'dist/harness-replay.html', bytes: Buffer.byteLength(html), redactions, scan: audit}));
