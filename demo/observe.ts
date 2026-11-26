import path from 'node:path';
import {lstatSync, writeSync} from 'node:fs';
// Explicit local extension; automatic extension discovery stays disabled.
export default function(pi: any) {
  // Pi redirects process.stdout.write to stderr in RPC mode. Write a single
  // JSONL record to fd 1 so observations reach the protocol stream.
  const emit = (value: any) => writeSync(1, JSON.stringify(value) + '\n');
  pi.on('before_agent_start', (event: any) => {
    emit({type:'viz_system', systemPrompt:event.systemPrompt, tools:pi.getAllTools().filter((t:any)=>pi.getActiveTools().includes(t.name))});
  });
  pi.on('context', (event: any) => { emit({type:'viz_context', messages:event.messages}); });
  pi.on('before_provider_request', (event: any) => { emit({type:'viz_request', payload:event.payload}); });
  pi.on('tool_call', (event: any, ctx: any) => {
    const file = 'goldbach.cjs';
    const stat = lstatSync(path.join(ctx.cwd, file), {throwIfNoEntry:false});
    const regularFile = !stat || (stat.isFile() && stat.nlink === 1);
    if(regularFile && event.input.path === file && ['read','write'].includes(event.toolName)) return;
    if(regularFile && event.toolName === 'bash' && event.input.command === 'node goldbach.cjs') {
      // Run the same script with Node's permission checks and without provider
      // secrets in its environment. This is a local demo tool, not OS isolation.
      event.input.command = 'env -i PATH="$PATH" SystemRoot="$SYSTEMROOT" node --permission --allow-fs-read=goldbach.cjs goldbach.cjs';
      event.input.timeout = 5;
      return;
    }
    return {block:true, reason:'Stage demo policy: read or write goldbach.cjs. Run only node goldbach.cjs.'};
  });
}
