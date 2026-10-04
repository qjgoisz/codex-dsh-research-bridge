// Default uses a fake ACP peer. Real prompts require the explicit --allow-model
// switch, an isolated workspace, and a separate config/state directory.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2), real = argv.includes('--allow-model');
const value = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i+1]; };
const root = mkdtempSync(join(tmpdir(), 'bridge-smoke-'));
const workspace = join(root, 'workspace'); mkdirSync(workspace);
const input = { type: 'bridge-research-fixture', unitConvention: 'Dimensionless arithmetic fixture; no SI or natural-unit inference is needed or authorized.', hbar: 1, omega: 2, n: 3, marker: `fixture-${Date.now()}` };
const original = JSON.stringify(input)+'\n'; writeFileSync(join(workspace, 'input.json'), original);
const target = join(workspace, real ? 'energy.json' : 'result.txt');
const config = value('--config');
if (real && !config) throw new Error('Real smoke requires --config; provider/model must be explicit.');
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const args = [cli, 'serve', '--state-root', join(root,'state'), '--approval-mode', 'allow-once'];
if (config) args.push('--config', resolve(config));
if (!real) args.push('--worker-command', process.execPath, '--worker-arg', fileURLToPath(new URL('../test/fake-acp-agent.mjs', import.meta.url)), '--prompt-timeout-ms', '5000');
const child = spawn(process.execPath, args, { cwd: workspace, env: { ...process.env,
  ...(!real ? { FAKE_SCENARIO: 'permission', FAKE_WRITE: target } : {}) }, stdio: ['pipe','pipe','pipe'] });
let seq = 0, buffer = '', stderr = '', exited = false;
const pending = new Map();
child.stderr.on('data', b => { stderr = (stderr+b).slice(-2000); });
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n'), line = buffer.slice(0,index); buffer = buffer.slice(index+1);
    if (!line.trim()) continue;
    let frame; try { frame=JSON.parse(line); } catch { for (const p of pending.values()) p.reject(new Error('non_protocol_stdout')); continue; }
    const p = pending.get(frame.id); if (!p) continue;
    clearTimeout(p.timer); pending.delete(frame.id);
    frame.error ? p.reject(new Error(JSON.stringify(frame.error))) : p.resolve(frame.result);
  }
});
const closed = new Promise(resolve => child.once('close', (code,signal) => {
  exited=true; for(const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`bridge_closed:${code}:${stderr}`)); } pending.clear(); resolve({code,signal});
}));
const rpc = (method, params) => new Promise((resolve,reject) => {
  if(exited) return reject(new Error('bridge_already_closed'));
  const id=++seq; const timer=setTimeout(()=>{pending.delete(id); reject(new Error(`request_timeout:${method}`));},130000);
  pending.set(id,{resolve,reject,timer}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
const call = async (name,args) => {
  const r=await rpc('tools/call',{name,arguments:args}); const p=JSON.parse(r.content[0].text);
  if(r.isError) throw new Error(JSON.stringify(p)); return p;
};
const terminal = new Set(['completed','failed','unknown','cancelled','needs_clarification']);
const settle = async id => {
  const deadline = Date.now()+180000;
  for(;;) {
    const view=await call('dsh_status',{id}); if(terminal.has(view.status)) return view;
    if(Date.now()>deadline) throw new Error(`execution_budget_exhausted:${id}`);
    await new Promise(r=>setTimeout(r,250));
  }
};
const task = (id,objective,phase='numerics') => ({id,objective,workspace,project:'isolated-smoke',phase,
  plan:{summary:'Run one isolated acceptance check',steps:['Read input.json','Follow only the stated test action','Report evidence']},
  acceptance:['Use only the isolated test workspace','Preserve input.json exactly'],deliverables:[target],waitMs:120000});
const report={at:new Date().toISOString(),realModel:real,root,workspace,checks:{},tasks:[]};
try {
  await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'bridge-smoke',version:'0.2.0'},capabilities:{}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const first=await call('dsh_delegate',task('smoke-first',real
    ? '读取 input.json。这是有明确 unitConvention 的无量纲算术夹具；不要自行设定物理单位或宣称物理理论验收。使用谐振子 E=(n+1/2)hbar*omega，计算能量，写 energy.json，格式为 {"energy":数值,"marker":输入的marker}。仅写这个文件，然后给出简短命令与计算证据。'
    : 'Exercise fake permission routing and create the configured result artifact.'));
  const done=terminal.has(first.status)?first:await settle('smoke-first'); report.tasks.push(done);
  if(done.status!=='completed') throw new Error(`first_task:${done.status}`);
  const result=await call('dsh_result',{id:'smoke-first'}); report.firstResult=result;
  if(real) {
    const energy=JSON.parse(readFileSync(target,'utf8')); if(energy.energy!==7||energy.marker!==input.marker) throw new Error('energy_artifact_mismatch');
  } else if(readFileSync(target,'utf8')!=='written with permission\n') throw new Error('fake_artifact_mismatch');
  report.checks.artifact=true;
  const second=await call('dsh_delegate',task('smoke-second',real
    ? `读取 input.json 和 energy.json，核对能量为7且 marker 为 ${input.marker}。不要写文件，报告核对结果。`
    : 'Reuse the active fake session.'));
  const secondDone=terminal.has(second.status)?second:await settle('smoke-second'); report.tasks.push(secondDone);
  report.checks.activeSessionReuse=done.sessionId===secondDone.sessionId&&secondDone.status==='completed';
  if(!report.checks.activeSessionReuse) throw new Error('active_session_not_reused');
  if(real) {
    const clarify=await call('dsh_delegate',task('smoke-clarify', '这是桥澄清测试。第一轮只输出 <<BRIDGE_CLARIFY>> 然后问“是否用 SI 单位？”，立即结束。收到答案后不要再次提问，回复“已确认 SI 单位”并结束，不写任何文件。'));
    report.tasks.push(clarify); if(clarify.status!=='needs_clarification') throw new Error('clarification_not_received');
    await call('dsh_reply',{id:'smoke-clarify',answer:'是，使用 SI 单位。此时已经收到答案，请回复已确认 SI 单位并结束，不再输出澄清标记。'});
    const answered=await settle('smoke-clarify'); report.tasks.push(answered);
    const reply=await call('dsh_result',{id:'smoke-clarify'});
    report.checks.clarification=answered.status==='completed'&&reply.text.includes('SI');
    if(!report.checks.clarification) throw new Error('clarification_roundtrip_failed');
    await call('dsh_delegate',{...task('smoke-cancel','这是隔离取消测试。不要写文件，执行一个约30秒的等待，然后回复完成。','maintenance'),waitMs:0});
    await new Promise(r=>setTimeout(r,1000));
    const cancelled=await call('dsh_cancel',{id:'smoke-cancel',reason:'isolated acceptance cancellation'});
    report.tasks.push(cancelled); const cancelDone=await settle('smoke-cancel');report.tasks.push(cancelDone);
    report.checks.cancel=cancelDone.status==='cancelled';
    if(!report.checks.cancel) throw new Error(`cancellation_unconfirmed:${cancelDone.status}`);
  }
  report.checks.inputPreserved=readFileSync(join(workspace,'input.json'),'utf8')===original;
  if(!report.checks.inputPreserved) throw new Error('input_changed');
} catch(error){report.error=error.message;process.exitCode=1;}
finally {
  child.stdin.end(); let timer;
  const outcome=await Promise.race([closed,new Promise(r=>{timer=setTimeout(()=>r(null),10000);})]);clearTimeout(timer);
  if(!outcome) {child.kill('SIGKILL');process.exitCode=1;}
  report.shutdown=outcome; report.checks.lockReleased=!existsSync(join(root,'state','bridge.lock'));
  if(!report.checks.lockReleased||outcome?.code!==0) process.exitCode=1;
  const path=resolve(value('--report')??join(root,'smoke-report.json'));writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({report:path,...report},null,2));
}
