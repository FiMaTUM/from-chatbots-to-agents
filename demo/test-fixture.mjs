// Protocol fixture only. Production uses the pi executable on PATH.
import fs from 'node:fs';
const checker=fs.existsSync('goldbach.cjs')?fs.readFileSync('goldbach.cjs','utf8'):null;
const toolFlag=process.argv.indexOf('--tools');
const tools=toolFlag<0?null:process.argv[toolFlag+1];
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');
let buffer='';
process.stdin.on('data',b=>{
 buffer+=b;let i;
 while((i=buffer.indexOf('\n'))>=0){
  const c=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
  if(c.type==='get_state')emit({type:'response',command:c.type,success:true,data:{model:{id:'TEST ONLY'},tools,checker}});
  if(c.type==='prompt'){
   emit({type:'response',command:c.type,success:true});
   emit({type:'turn_start'});
   emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Unicode: a\u2028b; '+process.env.VIZ_TEST_SECRET}],usage:{input:5,output:3,totalTokens:8}}});
   emit({type:'agent_settled'});
  }
 }
});
