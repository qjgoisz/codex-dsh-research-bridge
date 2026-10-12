// Experimental clarification/prefix ledger. Behavior is frozen during observation.
// This is a mechanical extraction: preserve fallback order, submission markers,
// rollback decisions and task/session/generation identity; do not add fallback paths.
import { renderPrompt, renderFollowUp } from './prompts.mjs';
import { checkPrefixStability } from './usage.mjs';
import { transition, isTerminal } from './state.mjs';
const nowIso = clock => new Date(clock()).toISOString();
export class PromptLedger {
  #pendingPromptText = new Map();
  #deliverySeq = new Map();
  #deliveryText = new Map();
  #ErrorType;
  #committed;
  #store;
  #sessions;
  #clock;
  #inflight;
  #require;
  #ensureSession;
  #runPrompt;
  #markUnknown;
  #publicView;
  #log;
  constructor(context) {
    this.#store = context.store;
    this.#sessions = context.sessions;
    this.#clock = context.clock;
    this.#inflight = context.inflight;
    this.#require = context.require;
    this.#ensureSession = context.ensureSession;
    this.#runPrompt = context.runPrompt;
    this.#markUnknown = context.markUnknown;
    this.#publicView = context.publicView;
    this.#log = context.log;
    this.#ErrorType = context.ErrorType;
    this.#committed = context.committed;
  }
  forgetForTest() { this.#deliverySeq.clear(); this.#deliveryText.clear(); }
  async reply(id, text) {
    const BridgeError = this.#ErrorType, COMMITTED = this.#committed;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new BridgeError('invalid_reply', '回复内容不能为空。');
    }
    const record = this.#require(id);
    if (record.status !== 'needs_clarification') {
      throw new BridgeError('not_waiting', `任务 ${id} 当前状态为 ${record.status}，只有 needs_clarification 可以回复。`);
    }
    const key = record.sessionKey;

    const priorRounds = Array.isArray(record.clarifications) ? record.clarifications : [];
    const thisRound = {
      question: record.clarification?.question ?? null,
      answer: text,
      answeredAt: nowIso(this.#clock),

      submitted: false,
    };
    const settled = transition(record, 'running', {
      at: nowIso(this.#clock),
      patch: {
        clarification: { ...record.clarification, answer: text, answeredAt: thisRound.answeredAt },
        clarifications: [...priorRounds, thisRound],
      },
      event: { event: 'clarification_answered' },
    });
    this.#store.write(settled, { expectRevision: record.revision });

    const previousExchanges = (Array.isArray(record.clarifications) ? record.clarifications : [])
      .filter(entry => entry?.submitted === true);

    const persistedSeq = record.lastSubmittedSeq ?? 0;
    const seenSeq = this.#deliverySeq.get(key) ?? 0;
    const seq = Math.max(seenSeq, persistedSeq) + 1;
    const recordedText = typeof record.lastPromptText === 'string' && record.lastPromptText.length > 0
      ? record.lastPromptText
      : null;

    let persistedLog = null;
    try {

      persistedLog = this.#store.lastPromptTextFor?.(key, {
        taskId: id,
        sessionId: record.sessionId,
        generation: record.sessionGeneration ?? 0,
      }) ?? null;
    } catch (error) {
      this.#log({ event: 'prompt_text_log_read_failed', id, message: error?.message ?? String(error) });
    }
    const ledgerEntry = this.#deliveryText.get(key) ?? null;
    const memoryText = ledgerEntry !== null
      && ledgerEntry.taskId === id
      && ledgerEntry.sessionId === record.sessionId
      && ledgerEntry.generation === (record.sessionGeneration ?? 0)
      ? ledgerEntry.text
      : null;

    const historyIncomplete = record.incompletePromptHistory === true;
    const persistedIsCurrent = recordedText !== null
      && !historyIncomplete                       // ← 这一条是关键
      && persistedSeq >= seq - 1
      && (memoryText === null || memoryText === recordedText);
    let baseSource = 'none';
    let base = renderPrompt(record.contract);
    if (persistedIsCurrent) {
      base = recordedText;
      baseSource = 'persisted';
    } else if (memoryText !== null && memoryText.length > 0) {

      base = memoryText;
      baseSource = 'memory';
    } else if (persistedLog !== null) {

      base = persistedLog.text;
      baseSource = 'persisted-log';
    } else if (record.incompletePromptHistory === true) {

      baseSource = 'none';
    }
    const followUp = renderFollowUp(
      { ...record.contract, clarification: record.clarification },
      text,
      {
        base,

        history: previousExchanges.map(entry => ({ question: entry.question, answer: entry.answer })),
      },
    );

    if (baseSource === 'none') {

      this.#log({
        event: 'prefix_stability_unverified', id, replySeq: seq,
        reason: 'base_unavailable',
        note: '上一轮发送文本未落盘且内存副本已过时，因此不比较、不宣称追加成功',
      });
    } else {
      const stability = checkPrefixStability(base, followUp);
      if (!stability.stable) {

        this.#log({ event: 'prefix_diverged', id, replySeq: seq, baseSource, ...stability });
      } else {
        this.#log({
          event: 'prefix_appended', id, replySeq: seq, baseSource,
          appendedChars: stability.appendedChars,

          ...(baseSource === 'memory' ? { persistedHistoryIncomplete: true } : {}),
        });
      }
    }

    let submitted = false;

    let deliveryAttempted = false;
    const promise = this.#ensureSession(key, record.contract, record.policy)

      .then(ensured => {

        const current = this.#require(id);
        const entry = this.#sessions.get(key);
        const nextSessionId = ensured ?? current.sessionId;
        const nextGeneration = entry?.generation ?? current.sessionGeneration ?? 0;
        const changed = nextSessionId !== current.sessionId
          || nextGeneration !== (current.sessionGeneration ?? 0);
        if (changed) {

          const previousRoute = current.appliedRoute ?? null;
          const nextRoute = entry?.route
            ? { ...entry.route, sessionId: nextSessionId, generation: nextGeneration }
            : null;

          this.#store.write({
            ...current,
            sessionId: nextSessionId,
            sessionGeneration: nextGeneration,
            appliedRoute: nextRoute,
            routeHistory: previousRoute
              ? [...(current.routeHistory ?? []), {
                ...previousRoute,
                supersededAt: nowIso(this.#clock),
                supersededBy: 'session_rebound_on_reply',
                sessionId: current.sessionId,
                generation: current.sessionGeneration ?? 0,
              }].slice(-32)
              : (current.routeHistory ?? []),
            updatedAt: nowIso(this.#clock),
            history: [...current.history, {
              at: nowIso(this.#clock), to: current.status,
              event: 'session_rebound_on_reply', sessionId: nextSessionId, generation: nextGeneration,
            }].slice(-64),
          }, { expectRevision: current.revision });
          this.#log({
            event: 'session_rebound_on_reply', id, sessionId: nextSessionId,
            generation: nextGeneration, previous: current.sessionId,
          });
        }

        deliveryAttempted = true;

        try {
          const before = this.#require(id);
          this.#store.write({
            ...before,
            clarifications: before.clarifications ?? [],
            updatedAt: nowIso(this.#clock),
          }, { expectRevision: before.revision });
          this.#pendingPromptText.delete(key);
        } catch (error) {

          const before = this.#require(id);
          this.#pendingPromptText.set(key, { text: followUp, revision: before.revision });

          this.#deliverySeq.set(key, seq);
          this.#deliveryText.set(key, { text: followUp, taskId: id, sessionId: record.sessionId, generation: record.sessionGeneration ?? 0 });

          try {
            const now = this.#require(id);
            this.#store.write({
              ...now,
              incompletePromptHistory: true,
              updatedAt: nowIso(this.#clock),
            }, { expectRevision: now.revision });
          } catch { /* 连标记都写不下：日志里仍有留痕 */ }
          this.#log({
            event: 'last_prompt_text_not_recorded', id,
            persistedHistoryIncomplete: true,
            deliveredSeq: seq,
            message: error?.message ?? String(error),
            note: '已保留内存副本供下一轮使用；重启后不得宣称前缀稳定已被证实',
          });
        }
        return this.#runPrompt({
          id, sessionKey: key, text: followUp, sessionId: nextSessionId,
          policy: record.policy, phase: record.contract.phase,
        }).then(view => {

          if (view?.[COMMITTED] !== true) {
            this.#log({
              event: 'clarification_reply_not_committed', id, replySeq: seq,
              taskStatus: view?.status ?? null,
              note: '解析出的视图不带提交标记（失败或未知），本轮答案不得标为已提交',
            });

            const RECEIPT_NO_PROMPT = view?.result?.observation?.receipt === 'no_prompt';
            const PRE_WRITE = new Set(['write_failed', 'worker_exit', 'connection_lost']);
            if (RECEIPT_NO_PROMPT || PRE_WRITE.has(view?.error?.code)) {
              const current = this.#require(id);
              if (!isTerminal(current.status) || current.status === 'failed') {
                this.#store.write(transition(
                  { ...current, status: 'running' }, 'needs_clarification', {
                    at: nowIso(this.#clock),
                    patch: {
                      clarifications: (current.clarifications ?? []).filter(entry => entry?.submitted === true),
                      clarification: {
                        ...current.clarification,
                        answer: null,
                        answeredAt: null,
                        lastReplyError: {
                          code: view?.error?.code ?? 'no_prompt',
                          message: view?.error?.message ?? '请求未写上线',
                          at: nowIso(this.#clock),
                        },
                      },
                      error: null,
                    },
                    event: { event: 'clarification_reply_rolled_back', reason: 'not_written' },
                  }), { expectRevision: current.revision });
                this.#log({ event: 'clarification_reply_rolled_back', id, replySeq: seq,
                  reason: view?.error?.code ?? 'no_prompt' });
                return this.#publicView(this.#require(id));
              }
            }
            return view;
          }

          submitted = true;
          try {
            const settledView = this.#require(id);
            const rounds = (settledView.clarifications ?? []).map((entry, index, all) => (
              index === all.length - 1 ? { ...entry, submitted: true } : entry));
            this.#store.write({
              ...settledView,
              clarifications: rounds,
              lastPromptText: followUp,
              lastSubmittedSeq: seq,
              incompletePromptHistory: false,
              updatedAt: nowIso(this.#clock),
            }, { expectRevision: settledView.revision });
            this.#deliverySeq.set(key, seq);
            this.#deliveryText.delete(key);
          } catch (error) {

            this.#deliverySeq.set(key, seq);
            this.#deliveryText.set(key, { text: followUp, taskId: id, sessionId: record.sessionId, generation: record.sessionGeneration ?? 0 });

            try {
              const now = this.#require(id);
              this.#store.write({
                ...now,
                incompletePromptHistory: true,
                updatedAt: nowIso(this.#clock),
              }, { expectRevision: now.revision });
            } catch { /* 连标记都写不下：日志里仍有留痕 */ }
            this.#log({
              event: 'last_prompt_text_not_recorded', id,
              persistedHistoryIncomplete: true,
              deliveredSeq: seq,
              message: error?.message ?? String(error),
              note: '请求已提交；文本未能落盘，已保留内存副本',
            });
          }
          return view;
        });
      })
      .catch(error => {

        const beacon = typeof error?.submitted === 'boolean' ? error.submitted : null;

        const PRE_WRITE_FAILURES = new Set(['write_failed', 'worker_exit', 'connection_lost']);
        const definitelyNotWritten = beacon === false || PRE_WRITE_FAILURES.has(error?.code);
        if (deliveryAttempted && !definitelyNotWritten) {
          this.#deliverySeq.set(key, seq);
          this.#deliveryText.set(key, { text: followUp, taskId: id, sessionId: record.sessionId, generation: record.sessionGeneration ?? 0 });
          return this.#markUnknown(id, error, { receipt: 'unobserved', deliveredSeq: seq });
        }

        this.#log({
          event: 'clarification_reply_not_submitted', id,
          code: error?.code ?? 'error', workerMessage: error?.message ?? String(error),
        });
        const current = this.#require(id);
        if (isTerminal(current.status)) return this.#publicView(current);

        const history = [...current.history, {
          at: nowIso(this.#clock),
          to: 'needs_clarification',
          event: 'clarification_reply_not_submitted',
          code: error?.code ?? 'error',
        }].slice(-64);
        this.#store.write(transition(current, 'needs_clarification', {
          at: nowIso(this.#clock),

          patch: {

            lastSubmittedSeq: current.lastSubmittedSeq ?? 0,

            clarifications: (current.clarifications ?? []).filter(entry => entry?.submitted === true),
            clarification: {
              ...current.clarification,
              answer: null,
              answeredAt: null,
              lastReplyError: {
                code: error?.code ?? 'resume_failed',
                message: error?.message ?? String(error),
                at: nowIso(this.#clock),
              },
            },
            error: {
              code: error?.code ?? 'resume_failed',
              message: error?.message ?? String(error),
              hint: '回复没有提交出去（会话无法确保）。任务已回到等待澄清：修好后用同样的答案再 reply 一次即可。',
            },
          },
          event: { event: 'clarification_reply_not_submitted' },
        }), { expectRevision: current.revision });
        return this.#publicView(this.#require(id));
      })
      .finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, promise);
    return this.#publicView(this.#store.read(id) ?? settled);
  }

  recordSubmitted({ id, sessionKey, text, activeSessionId }) {
      const settledRecord = this.#require(id);
      this.#deliverySeq.set(sessionKey, (this.#deliverySeq.get(sessionKey) ?? 0) + 1);

      try {
        const before = this.#require(id);
        this.#store.write({
          ...before,
          lastPromptText: text,
          lastSubmittedSeq: this.#deliverySeq.get(sessionKey) ?? 1,
          updatedAt: nowIso(this.#clock),
        }, { expectRevision: before.revision });
      } catch (error) {
        this.#log({ event: 'last_prompt_text_not_recorded', id,
          persistedHistoryIncomplete: true, message: error?.message ?? String(error) });
      }

      try {
        this.#store.appendPromptText?.(sessionKey, {
          text, taskId: id, sessionId: activeSessionId,
          generation: settledRecord.sessionGeneration ?? 0,
          at: nowIso(this.#clock),
        });
      } catch (error) {
        this.#log({ event: 'prompt_text_log_failed', id, message: error?.message ?? String(error) });
      }

      this.#deliveryText.set(sessionKey, {
        text,
        taskId: id,
        sessionId: activeSessionId,
        generation: settledRecord.sessionGeneration ?? 0,
      });
  }
}

// Counts are diagnostic events, not proof of submission, caching or context assembly.
export const PROMPT_LEDGER_EVENTS = Object.freeze([
  'prefix_appended', 'prefix_diverged', 'prefix_stability_unverified', 'last_prompt_text_not_recorded',
]);
export function promptLedgerEvent(event) {
  if (!PROMPT_LEDGER_EVENTS.includes(event?.event)) return null;
  const entry = { schema: 1, at: event.at ?? new Date().toISOString(), event: event.event };
  for (const key of ['id', 'replySeq', 'baseSource', 'reason', 'persistedHistoryIncomplete', 'deliveredSeq']) {
    if (event[key] !== undefined) entry[key] = event[key];
  }
  return entry;
}
export function summarizePromptLedger(text, { present = false, readProblem = null } = {}) {
  const summary = { present, counts: Object.fromEntries(PROMPT_LEDGER_EVENTS.map(event => [event, 0])),
    baseSources: {}, reasons: {}, persistedHistoryIncomplete: 0, malformedLines: 0, ignoredEvents: 0,
    firstEventAt: null, lastEventAt: null, readProblem };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { summary.malformedLines++; continue; }
    if (!PROMPT_LEDGER_EVENTS.includes(entry?.event)) { summary.ignoredEvents++; continue; }
    summary.counts[entry.event]++;
    for (const [key, target] of [['baseSource', summary.baseSources], ['reason', summary.reasons]]) {
      if (typeof entry[key] === 'string') target[entry[key]] = (target[entry[key]] ?? 0) + 1;
    }
    if (entry.persistedHistoryIncomplete === true) summary.persistedHistoryIncomplete++;
    if (typeof entry.at === 'string') {
      if (summary.firstEventAt === null || entry.at < summary.firstEventAt) summary.firstEventAt = entry.at;
      if (summary.lastEventAt === null || entry.at > summary.lastEventAt) summary.lastEventAt = entry.at;
    }
  }
  return summary;
}
