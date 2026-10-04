// Receipt evidence is separate from scientific acceptance.
export function buildObservation({ receipt, result = null, clientFailure = null }) {
  const textChars = typeof result?.text === 'string' ? result.text.length : 0;
  const toolCalls = Number.isInteger(result?.toolCalls) ? result.toolCalls : 0;
  const thoughts = Number.isInteger(result?.thoughts) ? result.thoughts : 0;
  const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : null;

  const gaps = [];
  if (receipt === 'unobserved') gaps.push('未观测到结果：可能已产生副作用，需人工核对');
  if (receipt === 'unconfirmed_cancel') gaps.push('取消未确认：worker 可能仍在运行');
  if (receipt === 'no_prompt') gaps.push('派发失败于提交提示之前：本次没有执行过');
  if (receipt === 'response' && stopReason === null) gaps.push('收到响应但没有 stopReason');

  if (receipt === 'response' && stopReason === 'end_turn' && textChars === 0 && toolCalls === 0) {
    gaps.push('worker 以 end_turn 结束，但没有正文、也没有工具调用：没有可核对的产出');
  }
  if (clientFailure !== null && clientFailure !== undefined) {
    gaps.push(`连接层失败：${clientFailure}`);
  }

  return {
    receipt,
    stopReason,
    textChars,
    toolCalls,
    thoughts,
    clientFailure: clientFailure ?? null,
    degraded: gaps.length > 0,
    gaps,
    observedAt: null, // filled by the caller, which owns the clock
  };
}
