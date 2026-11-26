import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const recordings=path.join(root,'recordings');
// Automatic logs of each live session. The replay list shows only the curated files in recordings/.
const sessions=path.join(recordings,'sessions'); fs.mkdirSync(sessions,{recursive:true});
const sandbox=path.join(root,'sandbox');
const demoLimit=1200;
const policy='Read or write goldbach.cjs. Run only node goldbach.cjs.';
const port=Number(process.env.PORT || 4173);
const peers=new Set(); let child, generation=0, timer, startTimer, ready=false, pending=null, busy=false, log, history=[];
let workdir, demoCompaction=false, checkingCompaction=false;
const secrets=Object.entries(process.env).filter(([k,v])=>/key|token|secret|password/i.test(k)&&v?.length>7).map(([,v])=>v);
function clean(value) {
  return JSON.parse(JSON.stringify(value,(key,v)=> /^(api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret)$/i.test(key) ? '[redacted]' : typeof v==='string' ? secrets.reduce((s,k)=>s.split(k).join('[redacted]'),v).replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\-]{12,})/g,'[redacted]') : v));
}
function emit(event) {
  const row=clean({at:Date.now(),event}); history.push(row);
  if(history.length>30000) history.shift();
  if(log) fs.appendFileSync(log,JSON.stringify(row)+'\n');
  for(const peer of peers) peer.write('data: '+JSON.stringify(row)+'\n\n');
}
function stop() {
  generation++; clearTimeout(timer); clearTimeout(startTimer); pending=null;
  if(child) {child.stdin?.end();if(process.platform==='win32'&&child.pid){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:4000,windowsHide:true});}catch{child.kill();}}else child.kill();child=undefined;}
  if(workdir) {
    const settings=path.join(workdir,'.pi');
    for(const file of [path.join(workdir,'goldbach.cjs'),path.join(settings,'settings.json')]) {
      try {fs.unlinkSync(file);} catch { /* File was never created or is in use. */ }
    }
    for(const dir of [settings,workdir]) {
      try {fs.rmdirSync(dir);} catch { /* Leave any unexpected files alone. */ }
    }
    workdir=undefined;
  }
  busy=false; checkingCompaction=false;
}
const send=command=>child.stdin.write(JSON.stringify(command)+'\n');
function messageCharacters(messages) {
  return messages.reduce((sum,m)=>sum+(m.summary?.length ?? (m.content || []).reduce((n,c)=>
    n+(c.type==='text' ? c.text.length : c.type==='toolCall' ? JSON.stringify(c.arguments).length : 0),0)),0);
}
function finishPrompt() {
  busy=false; pending=null; clearTimeout(timer);
  emit({type:'viz_ready'});
}
function afterEvent(e) {
  if(e.type==='agent_settled'){
    if(demoCompaction) send({type:'get_messages',id:'before-compact'});
    else finishPrompt();
  }
  if(e.type==='compaction_start' && e.reason!=='manual') checkingCompaction=true;
  if(e.type==='compaction_end' && e.reason!=='manual'){
    if(e.result) send({type:'get_messages',id:'compacted-list'});
    else checkingCompaction=false;
  }
  if(e.type!=='response') return;
  if(e.command==='get_state') {
    ready=true; clearTimeout(startTimer);
    if(!busy) clearTimeout(timer);
  }
  if(e.command==='prompt' && !e.success) finishPrompt();
  if(e.id==='before-compact') {
    const chars=e.success ? messageCharacters(e.data.messages) : 0;
    if(chars<=demoLimit) {finishPrompt();return;}
    checkingCompaction=true;
    emit({type:'viz_compaction_limit',chars,limit:demoLimit});
    send({type:'compact',id:'demo-compact',customInstructions:'Keep this checkpoint short. Preserve the script name, checked range, exact number checked, whether any check failed, and the exact pair of primes reported by the tool. Omit the source code.'});
  }
  if(e.id==='demo-compact') {
    if(e.success) send({type:'get_messages',id:'demo-compacted-list'});
    else {checkingCompaction=false;finishPrompt();}
  }
  if(['demo-compacted-list','compacted-list'].includes(e.id)) {
    checkingCompaction=false;
    if(e.success) emit({type:'viz_messages_list',messages:e.data.messages});
    if(e.id==='demo-compacted-list') finishPrompt();
  }
}
function start(tools, compact=false, singleTool=false, retry=0) {
  stop(); demoCompaction=tools && compact && !singleTool; history=[];
  log=path.join(sessions,`${new Date().toISOString().replace(/[:.]/g,'-')}-${tools?'tools':'chat'}.jsonl`);
  const basicSystem='You are demonstrating an agent harness to a general audience. Give concise, truthful answers in plain text. Distinguish reasoning from a check you have run. Do not claim a proof for all even integers.';
  const toolSystem=' To verify a new range, write a self-contained JavaScript Goldbach checker to goldbach.cjs using write. Check that it was saved using read on goldbach.cjs. Only then run exactly node goldbach.cjs using bash. Make these calls in order, one call per reply. The file must use only plain JavaScript and console.log, with no imports or input. Print JSON with checked and counterexamples fields. You may include other findings requested by the user. Answer follow-up questions about past results from the messages you have.';
  const singleToolSystem=' The Goldbach checker is already saved as goldbach.cjs in this session. Run exactly node goldbach.cjs once with bash, then answer from its result. Make no other tool calls.';
  const defaultSystem=basicSystem+(singleTool?singleToolSystem:tools?toolSystem:'');
  // Optional override for recording how the harness handles a blocked request.
  const system=process.env.VIZ_SYSTEM_PROMPT || defaultSystem;
  emit({type:'viz_reset',tools,source:'live',systemPrompt:system,policy:singleTool?'Run only node goldbach.cjs.':policy,...(demoCompaction?{demoLimit}:{})});
  fs.mkdirSync(sandbox,{recursive:true});
  workdir=fs.mkdtempSync(path.join(sandbox,'.live-'));
  if(singleTool) fs.copyFileSync(path.join(sandbox,'primes.cjs'),path.join(workdir,'goldbach.cjs'));
  if(demoCompaction) {
    // Pi uses this local retention setting for its real summary. The demo
    // controls when to ask for it. The user's global settings stay untouched.
    const settings=path.join(workdir,'.pi');
    fs.mkdirSync(settings);
    fs.writeFileSync(path.join(settings,'settings.json'),JSON.stringify({compaction:{enabled:false,keepRecentTokens:1}}));
  }
  const args=['--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--system-prompt',system,'-e',path.join(root,'observe.ts'),...(tools?['--tools',singleTool?'bash':'read,write,bash']:['--no-tools'])];
  // Approve only the fresh folder containing the settings we just created.
  if(demoCompaction) args.push('--approve');
  args.push('--model',process.env.PI_MODEL || 'openai-codex/gpt-6.1-sol:low');
  const mine=generation;
  child=spawn(process.env.PI_BIN || 'pi',[...(process.env.PI_ENTRY?[process.env.PI_ENTRY]:[]),...args],{cwd:workdir,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString(); let i;
    while((i=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);
      if(mine!==generation)continue;
      let e;
      try {e=JSON.parse(line);} catch {continue;} // Ignore non-protocol stdout.
      emit(e); afterEvent(e);
    }
    if(buffer.length>8e6) {emit({type:'viz_error',message:'RPC line exceeded 8 MB.'});stop();}
  });
  // stderr can contain provider diagnostics; never save it or return it to the browser.
  child.stderr.resume();
  child.stdin.on('error',()=>{});
  child.on('error',()=>{if(mine===generation){emit({type:'viz_error',message:'Could not start pi. Check PI_BIN and use replay.'});stop();}});
  child.on('exit',code=>{if(mine===generation){emit({type:'viz_exit',code});stop();}});
  armTimeout();
  // pi sometimes hangs at startup. Restart it once after 25 s, and send a waiting question again.
  ready=false; clearTimeout(startTimer);
  startTimer=setTimeout(()=>{
    if(mine!==generation||ready||retry>=1) return;
    const p=pending; start(tools,compact,singleTool,retry+1);
    if(p){pending=p;busy=true;armTimeout();emit({type:'viz_prompt',message:p.message});child.stdin.write(p.line);}
  },25000); startTimer.unref();
  send({type:'get_state',id:'startup'});
}
function armTimeout(){clearTimeout(timer); timer=setTimeout(()=>{emit({type:'viz_error',message:'Pi timed out after 120 seconds. Use replay or start a new session.'});stop();},120000);timer.unref();}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  try {
    if(req.headers.origin && req.headers.origin!==`http://localhost:${port}` && req.headers.origin!==`http://127.0.0.1:${port}`) return json(res,403,{error:'Local origin required'});
    const url=new URL(req.url,`http://localhost:${port}`);
    if(req.method==='GET' && url.pathname==='/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      for(const row of history)res.write('data: '+JSON.stringify(row)+'\n\n');
      peers.add(res);req.on('close',()=>peers.delete(res));return;
    }
    if(req.method==='GET' && url.pathname==='/api/recordings') return json(res,200,fs.readdirSync(recordings).filter(f=>f.endsWith('.jsonl')));
    if(req.method==='GET' && url.pathname==='/api/recording') {
      const name=url.searchParams.get('name');
      if(!name || path.basename(name)!==name || !name.endsWith('.jsonl'))return json(res,400,{error:'Invalid recording'});
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(fs.readFileSync(path.join(recordings,name)));return;
    }
    if(req.method==='POST') {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>64000)return json(res,413,{error:'Prompt too long'});}
      const data=JSON.parse(body||'{}');
      if(url.pathname==='/api/session'){
        const singleTool=data.singleTool===true;
        start(singleTool||!!data.tools,!!data.compact,singleTool);return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/stop'){stop();emit({type:'viz_stopped'});return json(res,200,{ok:true});}
      if(url.pathname==='/api/prompt'){
        if(!child)return json(res,409,{error:'Start a live session first.'});
        if(busy||checkingCompaction)return json(res,409,{error:'Pi is still working.'});
        if(typeof data.message!=='string'||!data.message.trim())return json(res,400,{error:'Enter a prompt.'});
        busy=true;armTimeout();emit({type:'viz_prompt',message:data.message});
        const line=JSON.stringify({type:'prompt',message:data.message,id:'prompt-'+Date.now()})+'\n';
        pending={line,message:data.message}; child.stdin.write(line);return json(res,200,{ok:true});
      }
    }
    if(req.method==='GET' && ['/','/index.html','/app.js','/style.css'].includes(url.pathname)){
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(path.join(root,file)));return;
    }
    json(res,404,{error:'Not found'});
  }catch{json(res,500,{error:'Request failed. Check the local files or restart the session.'});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Harness demo: http://localhost:${port}`));
function shutdown(){stop();for(const p of peers)p.end();server.close(()=>process.exit());setTimeout(()=>process.exit(),1500).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
