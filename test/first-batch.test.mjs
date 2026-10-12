import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { createRecord, transition } from '../src/state.mjs';
import { validateTaskContract } from '../src/contract.mjs';
import { WorkspaceQueue } from '../src/workspace-queue.mjs';
import { McpServer } from '../src/mcp-server.mjs';
import { contract } from './fixtures.mjs';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'bridge-batch-one-'));
 const store=new Store(root).init().lock();
 t.after(()=>{store.unlock();rmSync(root,{recursive:true,force:true});});
 return {root,store,bridge:new Bridge({store,worker:{}})};
}
test('batch inventory isolates damaged records and exposes them through recovery, inspect and MCP',async t=>{
 const {root,store,bridge}=fixture(t);
 let record=createRecord({id:'good',contract:contract({id:'good',workspace:root}),policy:{},at:new Date().toISOString()});
 record=transition(record,'dispatching',{at:new Date().toISOString()});store.write(record);
 const broken=join(root,'tasks','broken.json');writeFileSync(broken,'{invalid');
 const wrong=join(root,'tasks','wrong.json');writeFileSync(wrong,JSON.stringify({schema:99,id:'wrong'}));
 const records=store.readAll();assert.equal(records.size,1);assert.equal(records.get('good').status,'dispatching');
 assert.deepEqual(records.problems.map(p=>[p.id,p.code]),[['broken','corrupt_json'],['wrong','schema_mismatch']]);
 assert.throws(()=>store.read('broken'),{code:'corrupt_json'});
 const recovery=bridge.reconcile();assert.equal(recovery.tasks,1);assert.equal(recovery.stranded[0].id,'good');
 assert.deepEqual(recovery.problems,records.problems);
 assert.deepEqual(store.inspect().problems,records.problems);
 const server=new McpServer({bridge});const response=await server.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dsh_status',arguments:{}}});
 const summary=JSON.parse(response.result.content[0].text);assert.deepEqual(summary.problems,records.problems);assert.equal(summary.count,1);
 assert.equal(readFileSync(broken,'utf8'),'{invalid');assert.equal(store.read('good').status,'dispatching');
});
test('workspace errors aggregate before durable intent or worker execution',async t=>{
 const {root,store,bridge}=fixture(t);const missing=join(root,'absent');
 const invalid=contract({id:'missing',workspace:missing,objective:'',acceptance:[]});
 const report=validateTaskContract(invalid);
 assert.equal(report.valid,false);assert.deepEqual(new Set(report.errors.map(e=>e.field)),new Set(['objective','workspace','acceptance']));
 await assert.rejects(bridge.delegate(contract({id:'missing',workspace:missing})),{code:'invalid_contract'});
 assert.deepEqual(store.list(),[]);
 const file=join(root,'file');writeFileSync(file,'not a directory');
 assert.equal(validateTaskContract(contract({workspace:file})).valid,false);
 mkdirSync(missing);assert.equal(validateTaskContract(contract({workspace:missing})).valid,true);
});
test('dispatch supplies workspace to the queue without decoding the session key',async t=>{
 const {root,bridge}=fixture(t);const workspace=root+'/.';
 const original=WorkspaceQueue.prototype.enqueue;let received;
 WorkspaceQueue.prototype.enqueue=function(path){received=path;return Promise.reject(new Error('fixture stops before worker launch'));};
 try {await bridge.delegate(contract({id:'queued',workspace}),{wait:true});assert.equal(received,workspace);}
 finally {WorkspaceQueue.prototype.enqueue=original;}
});
