import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliLanguage, formatCliError, translateDiagnostic } from '../src/cli-language.mjs';
import { parseArgs } from '../src/cli.mjs';
const CLI=join(import.meta.dirname,'../src/cli.mjs');
function run(t,args,extraEnv={},program=CLI) {
 const root=mkdtempSync(join(tmpdir(),'bridge-lang-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 return spawnSync(process.execPath,[program,...args],{cwd:root,env:{...process.env,DSH_BRIDGE_LANG:'',...extraEnv},encoding:'utf8'});
}
test('CLI diagnostics default to English and explicit Chinese works even after a bad option',t=>{
 const en=run(t,['--bogus']);assert.equal(en.status,1);assert.match(en.stderr,/Unknown option: --bogus/);
 const zh=run(t,['--bogus','--lang','zh-CN']);assert.equal(zh.status,1);assert.match(zh.stderr,/未知选项：--bogus/);
});
test('language flag overrides environment and worker arguments cannot select the UI language',t=>{
 assert.match(run(t,['--bogus'],{DSH_BRIDGE_LANG:'zh-CN'}).stderr,/未知选项/);
 assert.match(run(t,['--bogus','--lang','en'],{DSH_BRIDGE_LANG:'zh-CN'}).stderr,/Unknown option/);
 assert.equal(resolveCliLanguage(['serve','--worker-arg','--lang'],{}),'en');
 assert.equal(parseArgs(['serve','--worker-arg','--lang']).flags['worker-arg'],'--lang');
});
test('localized missing configuration retains the error code and Unicode path',t=>{
 const path=join(tmpdir(),'bridge-中文 必须是非空字符串或 null');
 const en=run(t,['config','--config',path]);assert.equal(en.status,1);
 assert.match(en.stderr,/Specified configuration does not exist/);assert.ok(en.stderr.includes(path));assert.match(en.stderr,/code=config_missing/);
 const zh=run(t,['config','--config',path,'--lang','zh-CN']);assert.ok(zh.stderr.includes(path));assert.match(zh.stderr,/指定的配置不存在/);assert.match(zh.stderr,/code=config_missing/);
});
test('formatting never mutates upstream error objects or stable identifiers',()=>{
 const error=Object.assign(new Error('没有任务 my-task。'),{code:'not_found',hint:'保留原始详情'});
 assert.match(formatCliError(error,'en'),/Task not found: my-task/);assert.match(formatCliError(error,'en'),/code=not_found/);
 assert.equal(error.message,'没有任务 my-task。');assert.equal(error.hint,'保留原始详情');
 assert.equal(translateDiagnostic('provider 必须是非空字符串，例如 deepseek-official','en'),'provider must be a non-empty string, for example deepseek-official');
});
test('help describes language selection, unsupported and duplicate language options fail',t=>{
 assert.match(run(t,['--help']).stdout,/--lang/);
 assert.match(run(t,['--help','--lang','zh-CN']).stdout,/用法/);
 assert.equal(run(t,['--lang','fr']).status,1);
 assert.match(run(t,['--lang','en','--lang','zh-CN']).stderr,/重复选项/);
});

test('configuration script diagnostics follow the same language policy',t=>{
 const script=join(import.meta.dirname,'../scripts/configure-bridge.mjs');
 const en=run(t,['--bogus'],{},script);assert.equal(en.status,1);assert.match(en.stderr,/Configuration failed/);assert.match(en.stderr,/Unknown option/);
 const zh=run(t,['--bogus','--lang','zh-CN'],{},script);assert.match(zh.stderr,/配置失败/);assert.match(zh.stderr,/未知选项/);
});
