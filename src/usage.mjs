

export const MAX_SAMPLES = 64;

export class UsageSeries {
  #samples = [];
  #truncated = 0;
  #lastUsed = null;
  #sawDecrease = false;
  #maxUsed = 0;

  #firstObservation = null;
  #latestObservation = null;

  observe(update, seq) {
    if (!update || update.sessionUpdate !== 'usage_update') return false;
    const used = Number.isFinite(update.used) ? update.used : null;
    const size = Number.isFinite(update.size) ? update.size : null;
    if (used === null || size === null) return false;

    if (this.#lastUsed !== null && used < this.#lastUsed) this.#sawDecrease = true;
    if (used > this.#maxUsed) this.#maxUsed = used;

    const sample = {
      seq,
      used,
      size,
      delta: this.#lastUsed === null ? null : used - this.#lastUsed,
      pressure: size > 0 ? Number((used / size).toFixed(4)) : null,
    };
    this.#lastUsed = used;

    if (this.#firstObservation === null) this.#firstObservation = sample;
    this.#latestObservation = sample;

    if (this.#samples.length < MAX_SAMPLES) this.#samples.push(sample);
    else this.#truncated += 1;
    return true;
  }

  get count() { return this.#samples.length; }
  get sawDecrease() { return this.#sawDecrease; }

  summary() {
    if (this.#samples.length === 0) return null;

    const first = this.#firstObservation ?? this.#samples[0];
    const last = this.#latestObservation ?? this.#samples[this.#samples.length - 1];
    return {
      samples: this.#samples,
      truncated: this.#truncated,
      firstUsed: first.used,
      lastUsed: last.used,
      maxUsed: this.#maxUsed,
      contextSize: last.size,
      grewBy: last.used - first.used,
      sawDecrease: this.#sawDecrease,

      note: '仅记录上下文占用（used/size）。缓存命中与成本不在 ACP 面上，本记录不含这两项。'
        + '另外：DSH 只在 assistant/message 带 usage 且 request/context 可得时才发这个通知，'
        + '因此在真实运行里可能一条都收不到 —— 那时的正确读法是「未观测到」，不是「没有消耗」。',
    };
  }
}

export function checkPrefixStability(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') {
    return { stable: false, reason: 'invalid_input' };
  }
  if (second.startsWith(first)) {
    return { stable: true, appendedChars: second.length - first.length };
  }

  let shared = 0;
  const limit = Math.min(first.length, second.length);
  while (shared < limit && first[shared] === second[shared]) shared += 1;
  return {
    stable: false,
    reason: 'prefix_diverged',
    sharedChars: shared,
    firstLength: first.length,
    secondLength: second.length,

    note: '后续发送文本不是前一轮文本的逐字追加；'
      + '本项仅判断字符串关系，不据此推断会话缓存命中或驱逐。',
  };
}
