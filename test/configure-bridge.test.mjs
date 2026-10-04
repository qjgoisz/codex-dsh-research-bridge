import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { main, readSnapshot, saveConfig } from '../scripts/configure-bridge.mjs';
import { BUILT_IN_CONFIG } from '../src/config.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge 配置 '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'bridge.config.json');
  const run = async (args, text = '') => {
    let outputText = '';
    await main(args, {
      cwd, input: Readable.from([text]),
      output: new Writable({ write(chunk, encoding, done) { outputText += chunk.toString(); done(); } }),
    });
    return outputText;
  };
  return { cwd, path, run };
}

test('check validates a typed overlay without creating configuration or backup', async t => {
  const { cwd, path, run } = fixture(t);
  const output = await run(['--set', 'reasoningEffort', 'null', '--set', 'workerArgs', '["路径 含空格", "中文"]', '--check']);
  assert.match(output, /"reasoningEffort": null/);
  assert.match(output, /路径 含空格/);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(cwd), []);
});

test('explicit save backs up exact original bytes, preserves comments, and unchanged save is a no-op', async t => {
  const { cwd, path, run } = fixture(t);
  const original = '{"schema":1,"_note":"保留注释", "provider":"old"}\n';
  writeFileSync(path, original);
  await run(['--set', 'provider', 'new', '--yes']);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.schema, 2);
  assert.equal(config._note, '保留注释');
  assert.equal(config.provider, 'new');
  const backups = readdirSync(cwd).filter(name => name.includes('.bak.'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(cwd, backups[0]), 'utf8'), original);
  const before = readdirSync(cwd);
  assert.match(await run(['--yes']), /配置没有变化/);
  assert.deepEqual(readdirSync(cwd), before);
});

test('conflicting external edit is retained, without backup or temporary files', t => {
  const { cwd, path } = fixture(t);
  writeFileSync(path, JSON.stringify(BUILT_IN_CONFIG));
  const snapshot = readSnapshot(path);
  const edited = JSON.stringify({ ...BUILT_IN_CONFIG, model: 'external' });
  writeFileSync(path, edited);
  assert.throws(() => saveConfig(snapshot, BUILT_IN_CONFIG), /被修改/);
  assert.equal(readFileSync(path, 'utf8'), edited);
  assert.deepEqual(readdirSync(cwd), ['bridge.config.json']);
});

test('interactive menu uses cached routes and requires final confirmation', async t => {
  const { cwd, path, run } = fixture(t);
  const state = join(cwd, 'cache');
  mkdirSync(state);
  writeFileSync(join(state, 'models.json'), JSON.stringify({ schema: 1, summary: { model: { choices: [
    { value: JSON.stringify(['provider-a', 'model-a']) },
    { value: JSON.stringify(['provider-b', 'model-b']) },
  ] } } }));
  const otherFields = Object.keys(BUILT_IN_CONFIG).length - 3;
  const output = await run(['--state-root', 'cache'], `2\n1\n${'\n'.repeat(otherFields)}y\n`);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.provider, 'provider-b');
  assert.equal(config.model, 'model-b');
  assert.match(output, /缓存菜单/);
  assert.match(output, /保存配置/);
});

test('rejected confirmation and premature EOF never write', async t => {
  const { path, run } = fixture(t);
  await run(['--set', 'model', 'chosen'], 'n\n');
  assert.equal(existsSync(path), false);
  await assert.rejects(run(['--set', 'model', 'chosen']), /输入结束/);
  assert.equal(existsSync(path), false);
});

test('invalid input is rejected before any write', async t => {
  const { cwd, run } = fixture(t);
  for (const args of [
    ['--set', 'workerArgs', '[42]', '--yes'],
    ['--set', 'requestTimeoutMs', '0', '--yes'],
    ['--set', 'exposeModelChoice', 'yes', '--yes'],
    ['--set', 'schema', '2', '--yes'],
    ['--mount-acp'], ['--config'],
  ]) await assert.rejects(run(args));
  assert.deepEqual(readdirSync(cwd), []);
});

test('existing writer lock prevents replacement and is retained', t => {
  const { cwd, path } = fixture(t);
  const snapshot = readSnapshot(path);
  writeFileSync(`${path}.configure.lock`, 'another writer');
  assert.throws(() => saveConfig(snapshot, BUILT_IN_CONFIG), /配置锁已存在/);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(cwd), ['bridge.config.json.configure.lock']);
});

test('refuses symlinks, including dangling symlinks', { skip: process.platform === 'win32' }, t => {
  const { path, cwd } = fixture(t);
  symlinkSync(join(cwd, 'absent.json'), path);
  assert.throws(() => readSnapshot(path), /不接受符号链接/);
});
