import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import observe from './observe.ts';
const root=path.dirname(fileURLToPath(import.meta.url));
test('server forwards RPC, preserves Unicode separators, redacts secrets, restarts and rejects cross-origin requests',async()=>{
 const secret='fixture-secret-must-never-appear';const before=new Set(fs.readdirSync(path.join(root,'recordings')));
 const server=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'4184',PI_BIN:process.execPath,PI_ENTRY:path.join(root,'test-fixture.mjs'),VIZ_TEST_SECRET:secret},stdio:['ignore','pipe','pipe'],windowsHide:true});
 const base='http://127.0.0.1:4184';
 const post=(p,b,headers={})=>fetch(base+p,{method:'POST',headers,body:JSON.stringify(b)});
 const eventsThrough=async type=>{
  const stream=await fetch(base+'/events',{signal:AbortSignal.timeout(4000)});let text='';
  for await(const chunk of stream.body.pipeThrough(new TextDecoderStream())){
   text+=chunk;
   const events=text.split('\n\n').slice(0,-1).map(row=>JSON.parse(row.slice(6)).event);
   if(events.some(e=>e.type===type))return events;
  }
  throw Error(`Missing event ${type}`);
 };
 try{
  await new Promise((r,j)=>{server.stdout.once('data',r);server.once('error',j);});
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await post('/api/session',{tools:false},{Origin:'https://example.com'})).status,403);
  assert.equal((await post('/api/session',{tools:false})).status,200);
  await new Promise(r=>setTimeout(r,250));
  assert.equal((await post('/api/prompt',{message:'hello'})).status,200);
  const stream=await fetch(base+'/events',{signal:AbortSignal.timeout(4000)});let text='';
  for await(const chunk of stream.body){text+=Buffer.from(chunk);if(text.includes('agent_settled'))break;}
  assert.ok(text.includes('a\u2028b'));assert.ok(text.includes('[redacted]'));assert.ok(!text.includes(secret));assert.ok(text.includes('turn_start'));
  assert.equal((await post('/api/session',{tools:true,singleTool:true})).status,200);
  const [reset,ready]=await eventsThrough('response');
  assert.match(reset.systemPrompt,/Run exactly node goldbach\.cjs once with bash/);
  assert.equal(ready.data.tools,'bash');
  assert.equal(ready.data.checker,fs.readFileSync(path.join(root,'sandbox','primes.cjs'),'utf8'));
  assert.equal((await post('/api/session',{tools:true})).status,200);
  const [,loopReady]=await eventsThrough('response');
  assert.equal(loopReady.data.tools,'read,write,bash');
  assert.equal(loopReady.data.checker,null);
  assert.equal((await fetch(base+'/api/recording?name=..%2Fserver.mjs')).status,400);
  await post('/api/stop',{});
  for(const f of fs.readdirSync(path.join(root,'recordings')).filter(f=>!before.has(f)))assert.ok(!fs.readFileSync(path.join(root,'recordings',f),'utf8').includes(secret));
 }finally{server.kill();await new Promise(r=>server.once('exit',r));for(const f of fs.readdirSync(path.join(root,'recordings')).filter(f=>!before.has(f)))fs.unlinkSync(path.join(root,'recordings',f));}
});

test('the observer permits only the session script and exact run command', () => {
 const handlers = new Map();
 observe({on: (name, handler) => handlers.set(name, handler)});
 const ctx = {cwd: fs.mkdtempSync(path.join(root, 'sandbox', '.live-'))};
 const check = (toolName, input) => handlers.get('tool_call')({toolName, input}, ctx);
 try {
  assert.equal(check('write', {path: 'goldbach.cjs', content: 'console.log(42)'}), undefined);
  assert.equal(check('read', {path: 'goldbach.cjs'}), undefined);
  const input = {command: 'node goldbach.cjs'};
  assert.equal(check('bash', input), undefined);
  assert.equal(input.timeout, 5);
  assert.match(input.command, /--permission --allow-fs-read=goldbach\.cjs goldbach\.cjs$/);
  assert.equal(check('bash', {command: 'ls'}).block, true);
  assert.equal(check('bash', {command: 'node goldbach.cjs --extra'}).block, true);
  assert.equal(check('write', {path: '../goldbach.cjs'}).block, true);
  assert.equal(check('read', {path: 'primes.cjs'}).block, true);
  assert.equal(check('edit', {path: 'goldbach.cjs'}).block, true);
 } finally {
  fs.rmdirSync(ctx.cwd);
 }
});
