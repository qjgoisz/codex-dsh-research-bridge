import { researchGuidance } from './research-guidance.mjs';
export const CLARIFY_MARKER = '<<BRIDGE_CLARIFY>>';
export function extractClarification(text = '') {
  const index = text.indexOf(CLARIFY_MARKER);
  if (index === -1) return null;
  const rest = text.slice(index + CLARIFY_MARKER.length).trim();
  return { question: rest.length > 0 ? rest : '(worker 未附问题正文)', at: index };
}

export function renderPrompt(contract) {
  const list = (items, empty = '（无）') => (items && items.length > 0 ? items.map(item => `- ${item}`).join('\n') : `- ${empty}`);
  const policy = contract.permissions ?? {};
  return [
    `# 委派任务 ${contract.id}`,
    '',
    '## 目标',
    contract.objective,
    '',
    '## 工作区',
    `- 工作区根：${contract.workspace}`,
    `- 阶段：${contract.phase}`,
    '',
    '## 计划',
    contract.plan?.summary ?? '（未提供摘要）',
    list(contract.plan?.steps),
    '',
    '## 验收标准',
    list(contract.acceptance),
    '',
    '## 科研约定与输入',
    JSON.stringify(contract.research ?? {}, null, 2),
    researchGuidance(contract.phase),
    '允许独立提出有证据的异议；缺失的物理定义必须提问。',
    '注明假设、单位、适用范围、输入版本，以及推导/数据/命令证据。',
    '',
    '## 文件与运行约定',
    `- 交付文件：${(contract.deliverables ?? []).join('、') || '按目标与验收标准交付'}`,
    ...(policy.network === false ? ['- 本任务要求不联网。'] : []),
    '- 工具权限由 DSH 运行环境和实际审批决定；本提示不授予额外权限。',
    '',
    '## 停止条件',
    list(contract.stopIf && contract.stopIf.length > 0
      ? contract.stopIf
      : ['假设、边界条件或输入缺失时停止并提出问题，不要自行补全。']),
    '',
    '## 反向咨询',
    '你只能向 Codex 提问（consult_only），不得反向委派。',
    `需要澄清时，在回复中原样输出一行 ${CLARIFY_MARKER} 后紧跟你的问题，然后立即结束本轮。`,
    '',
    '## 交付要求',
    '先给出结论，再给出证据（命令、文件路径、行号或数据）。',
    '无法验证的步骤必须明确标注为未验证。',
  ].join('\n');
}

export function renderFollowUp(contract, answer, state = {}) {
  const base = typeof state.base === 'string' && state.base.length > 0
    ? state.base
    : renderPrompt(contract);
  const history = Array.isArray(state.history) ? state.history : [];
  const question = contract?.clarification?.question ?? null;
  const block = [
    '## 澄清答复',
    question === null ? '' : `（针对问题：${question}）`,
    String(answer ?? ''),
  ].filter(line => line !== null).join('\n');

  const earlier = history.length > 0
    ? ['', '## 此前的澄清', ...history.flatMap(entry => [
      entry.question ? `（问：${entry.question}）` : '',
      `（答：${String(entry.answer ?? '')}）`,
    ])]
    : [];
  return [base, '', ...earlier, ...(earlier.length > 0 ? [''] : []), block].join('\n');
}
