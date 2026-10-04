import { writeFileSync } from 'node:fs';

import { createSuite } from './harness.mjs';
import {
  flattenSelectOptions, summarizeConfigOptions, modelValues, reasoningValues,
  validateModelSelection, validateReasoningSelection, resolveSelection,
  CatalogueCache, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, PROVIDER_DEFAULT_REASONING,
  MODEL_CONFIG_ID, REASONING_CONFIG_ID, summaryToOptions,
} from '../src/models.mjs';

export const suite = createSuite('模型目录：解析、校验与默认值');

/** The grouped shape DSH actually emits for the model option. */
const grouped = {
  id: MODEL_CONFIG_ID, name: 'Model', category: 'model', type: 'select',
  currentValue: 'deepseek-official/deepseek-flash',
  options: [
    { group: 'deepseek-official', name: 'DeepSeek Official', options: [
      { value: 'deepseek-official/deepseek-flash', name: 'deepseek-flash' },
      { value: 'deepseek-official/deepseek-pro', name: 'deepseek-pro' },
    ] },
    { group: 'other-provider', name: 'Other', options: [
      { value: 'other-provider/small', name: 'small' },
    ] },
  ],
};

/** The flat shape the schema also allows; a client must not assume only one. */
const flat = {
  id: MODEL_CONFIG_ID, name: 'Model', type: 'select', currentValue: 'a/one',
  options: [{ value: 'a/one', name: 'one' }, { value: 'a/two', name: 'two' }],
};

const reasoningOption = {
  id: REASONING_CONFIG_ID, name: 'Reasoning effort', category: 'thought_level', type: 'select',
  currentValue: 'medium',
  options: [
    { value: '', name: 'Provider default' },
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};

suite.test('同时支持分组与扁平两种 options 形状', ctx => {
  const fromGrouped = flattenSelectOptions(grouped);
  ctx.equal(fromGrouped.length, 3);
  ctx.equal(fromGrouped[0].group, 'deepseek-official');
  ctx.deepEqual(fromGrouped.map(entry => entry.value), [
    'deepseek-official/deepseek-flash', 'deepseek-official/deepseek-pro', 'other-provider/small',
  ]);

  const fromFlat = flattenSelectOptions(flat);
  ctx.deepEqual(fromFlat.map(entry => entry.value), ['a/one', 'a/two']);
  ctx.equal(fromFlat[0].group, null, '扁平形状没有分组');
});

suite.test('目录摘要保留当前值与全部选项，不含无关字段', ctx => {
  const summary = summarizeConfigOptions([grouped, reasoningOption]);
  ctx.equal(summary.model.currentValue, 'deepseek-official/deepseek-flash');
  ctx.equal(summary.model.choices.length, 3);
  ctx.equal(summary.reasoning.currentValue, 'medium');
  ctx.assert(summary.reasoning.choices.some(choice => choice.value === ''), 'provider 默认必须是可选项之一');
  ctx.deepEqual(Object.keys(summary).sort(), ['model', 'reasoning']);
});

suite.test('目录为空时视为“未知”，不冒充结论', ctx => {
  const empty = summarizeConfigOptions([{ id: MODEL_CONFIG_ID, type: 'select', currentValue: 'x/y', options: [] }]);
  const verdict = validateModelSelection(empty, 'anything/at-all', { explicit: true });
  ctx.equal(verdict.status, 'unknown', '没有目录就不能断言模型非法');
  ctx.deepEqual(modelValues(empty), ['x/y'], '当前值仍算已知');
});

suite.test('显式请求一个目录里没有的模型必须被拒，并给出候选', ctx => {
  const summary = summarizeConfigOptions([grouped, reasoningOption]);
  const verdict = validateModelSelection(summary, 'nope/none', { explicit: true });
  ctx.equal(verdict.status, 'invalid');
  ctx.assert(verdict.candidates.includes('deepseek-official/deepseek-pro'), '必须列出候选');
});

suite.test('默认值不在目录里只是“不可用”，不是“非法”', ctx => {
  const summary = summarizeConfigOptions([grouped, reasoningOption]);
  const verdict = validateModelSelection(summary, 'deepseek-official/deepseek-flash-plus', { explicit: false });
  ctx.equal(verdict.status, 'unavailable', '默认值应当让 worker 去裁定，而不是直接拒签');
  ctx.assert(verdict.message.includes('将尝试设置'), verdict.message);
});

suite.test('模型在当前目录里就是通过', ctx => {
  const summary = summarizeConfigOptions([grouped]);
  ctx.equal(validateModelSelection(summary, 'deepseek-official/deepseek-flash').status, 'ok');
  ctx.equal(validateModelSelection(summary, '').status, 'ok', '空值表示不指定');
});

suite.test('推理档位：模型未声明时是“不支持”，不是错误', ctx => {
  const modelOnly = summarizeConfigOptions([grouped]);
  const verdict = validateReasoningSelection(modelOnly, 'high');
  ctx.equal(verdict.status, 'unsupported');
  ctx.assert(verdict.message.includes('不会导致任务失败'), '必须说明这不会让任务失败');
});

suite.test('推理档位非法时列出候选，包含 provider 默认', ctx => {
  const summary = summarizeConfigOptions([grouped, reasoningOption]);
  const verdict = validateReasoningSelection(summary, 'extreme');
  ctx.equal(verdict.status, 'invalid');
  ctx.assert(verdict.candidates.includes(''), 'provider 默认（空字符串）必须出现在候选里');
  ctx.equal(validateReasoningSelection(summary, 'high').status, 'ok');
  ctx.equal(validateReasoningSelection(summary, '').status, 'ok');
});

suite.test('默认选择：未显式请求时用桥的默认值', ctx => {
  const selection = resolveSelection({});
  ctx.equal(selection.model, DEFAULT_MODEL);
  ctx.equal(selection.reasoningEffort, DEFAULT_REASONING_EFFORT);
  ctx.equal(selection.modelExplicit, false);
  ctx.equal(selection.reasoningExplicit, false);
});

suite.test('默认选择：显式请求优先，且 null 表示 provider 默认', ctx => {
  const selection = resolveSelection({ requestedModel: 'other/small', requestedReasoning: null });
  ctx.equal(selection.model, 'other/small');
  ctx.equal(selection.modelExplicit, true);
  ctx.equal(selection.reasoningEffort, PROVIDER_DEFAULT_REASONING);
  ctx.equal(selection.reasoningExplicit, true);
});

suite.test('默认选择：部署配置可以覆盖桥内建默认值', ctx => {
  const selection = resolveSelection({ defaults: { model: 'x/y', reasoningEffort: 'low' } });
  ctx.equal(selection.model, 'x/y');
  ctx.equal(selection.reasoningEffort, 'low');
  const empty = resolveSelection({ defaults: { model: '', reasoningEffort: '' } });
  ctx.equal(empty.model, DEFAULT_MODEL, '空字符串不构成覆盖');
  ctx.equal(empty.reasoningEffort, '', '但推理档位的空字符串是有意义的值');
});

suite.test('摘要可以往返成 configOptions，缓存不丢信息', ctx => {
  const summary = summarizeConfigOptions([grouped, reasoningOption]);
  const roundTrip = summarizeConfigOptions(summaryToOptions(summary));
  ctx.deepEqual(roundTrip, summary);
});

suite.test('目录缓存带时间戳、可判新旧、损坏时视为没有', ctx => {
  const root = ctx.tempDir('catalogue-');
  const cache = new CatalogueCache(root);
  ctx.equal(cache.read(), null, '未写过就是没有');

  const written = cache.write({ dshHome: '/tmp/dsh', summary: summarizeConfigOptions([grouped]) });
  ctx.equal(written.schema, 1);
  ctx.assert(cache.ageMs() !== null, '必须能算出年龄');
  ctx.equal(cache.read().dshHome, '/tmp/dsh');

  writeFileSync(cache.path, '{ 坏掉的 JSON');
  ctx.equal(cache.read(), null, '损坏缓存不能当成有效目录');
});
