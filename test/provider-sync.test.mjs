import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { providerPatch, planProviderSync, applyProviderSync } from '../src/platform/provider-sync.mjs';
import { confirmProviderTransfers } from '../scripts/configure-bridge.mjs';
const name='@deepseek-ai/dsh-llm-pi-ai';
const source=[{id:'source',name,config:{providers:{ustcllm:{models:[{id:'model'}],apiKey:{__jsExpr:'process.env.TEST_KEY'}}}}}];
const target=[{id:'target',name,config:{otherSetting:42,providers:{existing:{models:[{id:'keep'}]}}}}];

test('selected provider copy retains other target routes and never mutates source/target',()=>{
 const before=JSON.stringify({source,target});const {patch,replace}=providerPatch(source,target,'ustcllm');
 assert.equal(replace,false);assert.equal(patch.id,'target');assert.equal(patch.config.otherSetting,42);
 assert.deepEqual(patch.config.providers.existing,target[0].config.providers.existing);
 assert.deepEqual(patch.config.providers.ustcllm,source[0].config.providers.ustcllm);
 assert.equal(JSON.stringify({source,target}),before);
});

test('ambiguous/disabled target and unknown source fail instead of enabling or installing plugins',()=>{
 for(const entries of [[],[{...target[0],disabled:true}],[target[0],{...target[0],id:'another'}]])assert.throws(()=>providerPatch(source,entries,'ustcllm'));
 assert.throws(()=>providerPatch(source,target,'absent'));
});

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'sync-provider 中文 '));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const installation=join(root,'install'),home=join(root,'home');mkdirSync(installation);writeFileSync(join(installation,'package.json'),'{"name":"@deepseek-ai/dsh","version":"test"}');
 for(const [p,entries]of [['desktop',source],['acp',target]]){
 const dir=join(home,'profiles',p);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'package.json'),'{}');writeFileSync(join(dir,'cordis.patch.yml'),JSON.stringify([{insert:entries}]));}
 const boot={
  loadProfileDirectory:(prefix,dir)=>({layers:[],skippedBundles:[],patchPath:join(dir,'cordis.patch.yml'),patches:JSON.parse(readFileSync(join(dir,'cordis.patch.yml'),'utf8'))}),
  loadOptionalPatches:(prefix,path)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[],
  composeEntries:layers=>{let entries=[];for(const p of layers.flat()){if(p.insert)entries.push(...structuredClone(p.insert));else{const e=entries.find(e=>e.id===p.id);if(e)Object.assign(e,structuredClone(p));}}return entries;},
 };
 const yaml={Type:class{},JSON_SCHEMA:{extend:()=>({})},dump:rows=>JSON.stringify(rows)};
 const config={dshRoot:installation,dshHome:home,profile:'acp'};
 return {root,home,config,boot,yaml,path:join(home,'profiles','acp','cordis.patch.yml'),plan:()=>planProviderSync(config,'desktop','ustcllm',{boot,yaml})};
}

test('planning is read-only, preview hides secrets, apply backs up exact bytes and preserves unrelated providers',async t=>{
 const f=fixture(t),old=readFileSync(f.path);const plan=await f.plan();
 assert.deepEqual(readFileSync(f.path),old);assert.ok(!JSON.stringify(plan).includes('TEST_KEY'));
 const result=applyProviderSync(plan);assert.deepEqual(readFileSync(result.backup),old);
 const entries=f.boot.composeEntries([JSON.parse(readFileSync(f.path))]);
 assert.deepEqual(entries[0].config.providers.ustcllm,source[0].config.providers.ustcllm);
 assert.deepEqual(entries[0].config.providers.existing,target[0].config.providers.existing);
 assert.throws(()=>applyProviderSync(plan),/无效或已使用/);
 assert.ok(!readdirSync(dirname(f.path)).some(n=>n.endsWith('.lock')||n.includes('.tmp.')));
});

test('concurrent source or target change stops transfer, retaining external bytes and releasing lock',async t=>{
 for(const profile of ['desktop','acp']){
  const f=fixture(t),plan=await f.plan();const path=join(f.home,'profiles',profile,'cordis.patch.yml');
  writeFileSync(path,'external');assert.throws(()=>applyProviderSync(plan),/被修改/);
  assert.equal(readFileSync(path,'utf8'),'external');assert.ok(!existsSync(f.path+'.bridge-sync.lock'));
 }
});

test('home-layer override conflict cannot be reported as a successful transfer',async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'cordis.patch.yml'),JSON.stringify([{id:'target',config:{providers:{home:{models:[]}}}}]));
 await assert.rejects(f.plan(),/home 补丁/);
});

test('both confirmations are required; decline at either point leaves writes at zero',async()=>{
 for(const answers of [['n'],['y','n'],['y','yes']]){
 const expectedReads=answers[0]==='y'?1:0;let writes=0,reads=0;const count=await confirmProviderTransfers({profile:'acp'},{otherProfiles:[{profile:'desktop',routes:[{provider:'ustcllm',model:'model'}]}]},
 {ask:async()=>answers.shift(),output:{write(){}},planSync:async()=>{reads++;return {};},applySync:()=>{writes++;return {};}});
 assert.equal(count,0);assert.equal(writes,0);assert.equal(reads,expectedReads);
 }
});

test('confirmed transfer displays scope before second prompt and writes once',async()=>{
 let log='',writes=0;const answers=['y','SYNC'];
 const count=await confirmProviderTransfers({profile:'acp'},{otherProfiles:[{profile:'desktop',routes:[{provider:'ustcllm',model:'model'}]}]},
 {ask:async prompt=>{if(prompt.includes('二次确认'))assert.match(log,/之后取消桥配置保存不会撤销同步/);return answers.shift();},
 output:{write:text=>{log+=text;}},planSync:async()=>({action:'添加',provider:'ustcllm'}),applySync:()=>{writes++;return {path:'target',backup:'backup'};}});
 assert.equal(count,1);assert.equal(writes,1);assert.match(log,/DSH 原文备份/);
});


test('input EOF before second confirmation never applies a prepared plan',async()=>{
 let calls=0,writes=0;
 await assert.rejects(confirmProviderTransfers({profile:'acp'},{otherProfiles:[{profile:'desktop',routes:[{provider:'ustcllm',model:'model'}]}]},
 {ask:async()=>{if(++calls===1)return 'y';throw Error('input ended');},output:{write(){}},planSync:async()=>({}),applySync:()=>{writes++;}}),/input ended/);
 assert.equal(writes,0);
});
