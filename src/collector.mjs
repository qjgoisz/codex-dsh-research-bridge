import { UsageSeries } from './usage.mjs';
const MAX_TEXT = 200_000;
export function createCollector(sessionId) {
  let text = '';
  let thoughts = 0;
  let toolCalls = 0;
  let turns = 0;
  const tools = [];
  let usage = null;

  const usageSeries = new UsageSeries();
  let usageSeq = 0;

  let usageUpdatesSeen = 0;
  let usageUpdatesInvalid = 0;

  const append = chunk => {
    const value = chunk?.content?.text;
    if (typeof value === 'string' && text.length < MAX_TEXT) text += value;
  };

  return {
    observe(notification) {
      if (!notification || notification.sessionId !== sessionId) return;
      const update = notification.update;
      if (!update || typeof update !== 'object') return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          append(update);
          break;
        case 'agent_thought_chunk':
          thoughts += 1;
          break;
        case 'user_message_chunk':
          turns += 1;
          break;
        case 'tool_call':
          toolCalls += 1;
          tools.push({ toolCallId: update.toolCallId, title: update.title ?? null, kind: update.kind ?? null });
          break;
        case 'tool_call_update':
          if (update.status) {
            const entry = tools.find(item => item.toolCallId === update.toolCallId);
            if (entry) entry.status = update.status;
          }
          break;
        case 'usage_update':
          usage = update;
          usageSeq += 1;
          usageUpdatesSeen += 1;

          if (usageSeries.observe(update, usageSeq) === false) usageUpdatesInvalid += 1;
          break;
        default:
          break;
      }
    },
    snapshot() {
      return {
        text, thoughts, toolCalls, turns, tools, usage,

        usageSeries: usageSeries.summary(),

        usageObservation: {
          seen: usageUpdatesSeen,
          invalid: usageUpdatesInvalid,
          accepted: usageUpdatesSeen - usageUpdatesInvalid,
        },
      };
    },
    get text() { return text; },
  };
}
