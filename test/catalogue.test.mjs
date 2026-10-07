import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogueInstallation, collectConfiguredRoutes } from '../src/platform/catalogue.mjs';

test('configured routes respect disabled groups, explicit replacements and route identity', async () => {
  const imported=[];
  const importer=async name=>{imported.push(name);return {
    resolveAdapterOptions: v=>({models:v.models??[{id:'default'}]}),
    getBuiltinModels: p=>[{id:p+'-builtin'}],
  };};
  const rows=[
    {group:true,disabled:true,config:[{name:'@deepseek-ai/dsh-llm-deepseek-account'}]},
    {group:true,disabled:{__jsExpr:'secret'},config:[]},
    {name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{models:[{id:'explicit'}]}},
    {name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{a:{models:[{id:'custom'},{id:' custom '}]},b:{models:[]}}}},
    {name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{models:[{id:'explicit'}]}},
  ];
  const warnings=[];const routes=await collectConfiguredRoutes(rows,importer,warnings);
  assert.deepEqual(routes,[{provider:'deepseek-official',model:'explicit'},{provider:'a',model:'custom'},{provider:'b',model:'b-builtin'}]);
  assert.equal(warnings.length,1);
  assert.equal(imported.filter(n=>n.includes('providers/all')).length,1);
});

test('provider import failures do not disclose configuration or parser secrets', async()=>{
  const warnings=[];
  const routes=await collectConfiguredRoutes([{name:'@deepseek-ai/dsh-llm-deepseek-account',config:{apiKey:'secret-value'}}],async()=>{throw Error('secret-value');},warnings);
  assert.deepEqual(routes,[]);assert.equal(warnings.length,1);assert.ok(!warnings[0].includes('secret-value'));
});

test('Desktop package discovery supports resource layouts without launching CLI',t=>{
 const root=mkdtempSync(join(tmpdir(),'bridge catalogue 中文 '));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const parts of [['resources'],['Harness.app','Contents','Resources']]) {
  const resources=join(root,...parts),bin=join(resources,'runtime','cli','bin');mkdirSync(bin,{recursive:true});
  const command=join(bin,'dsh.exe');writeFileSync(command,'never execute');
  const pkg=join(resources,'app','dsh','node_modules','@deepseek-ai','dsh');mkdirSync(pkg,{recursive:true});
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'fixture'}));
  assert.equal(catalogueInstallation({workerCommand:command}).root,pkg);
 }
 assert.equal(catalogueInstallation({workerCommand:join(root,'absent')}),null);
});
