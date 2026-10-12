[English](../en/prompt-ledger-experiment.md) | [简体中文](../zh-CN/prompt-ledger-experiment.md)

# Clarification prefix ledger observation experiment

Recording start date: 2026-10-12. Status: observing. The review date is specified manually by the user after real clarification-continuation samples have accumulated; no automatic deadline is currently set, and the mechanism will not be deleted automatically. The review should record the date, the sample time range and the decision.

## Frozen scope and invariants

`src/prompt-ledger.mjs` independently owns clarification continuation, the three in-memory ledgers and the sent-text record. `Bridge` only provides interfaces for tasks, sessions, submissions and status updates. This extraction preserves the original fallback order: trusted task record → in-memory sent text for the same task/session/generation → persistent send buffer → contract and committed clarification history. The original decisions for preparation, commit, rollback and the commit marker remain unchanged.

During the observation period the fallback chain is frozen against feature expansion; no new sources, fallback conditions or text-assembly logic are added. If the experiment is later kept or removed, the module is the adjustment boundary, and the following must continue to hold:

- An uncommitted answer must be rolled back and must not remain in the committed clarification history.
- A sent fact must not be overwritten by an unsent intent; after recovery the online text must still retain the previously sent answer and exclude the unsent answer.

These are correctness requirements and cannot wait for the experimental result to be guaranteed. Tests use a fake ACP that independently records the received text, cross-checked against the bridge's record.

## Statistics entry point

```sh
node src/cli.mjs inspect --state-root <state directory>
```

The emitted `promptLedger` contains four event counts: `prefix_appended`, `prefix_diverged`, `prefix_stability_unverified`, `last_prompt_text_not_recorded`; it also contains `baseSources`, `reasons` (including `base_unavailable`), the occurrence count of the `persistedHistoryIncomplete` flag, the first and last event times, and statistics-file read problems.

Events are saved in `prompt-ledger-events.jsonl` in the same state directory, with new files having mode 0600; only the event type, task id, sequence number, base source and diagnostic flags are kept, and no prompt body is newly stored. Counts survive bridge restarts, are not backfilled from old console logs, and are not cleared automatically. When the statistics file does not exist, `present=false`, meaning no events have been collected yet. Corrupted lines are counted separately in `malformedLines` while the remaining valid events continue to be counted; a read failure reports `readProblem`, and a zero value at that point must not be interpreted as no events having occurred.

A statistics write failure does not change task execution or the fallback choice, and reports `prompt_ledger_event_not_recorded` to the original log channel. When such a diagnostic appears, the counts may be incomplete and the original logs should be kept for joint review.

`prefix_*` events are produced while preparing continuation text and may correspond to an answer that was later not committed. The counts are not the number of sent rounds, nor a cache hit rate, and cannot by themselves prove DSH's context-assembly behavior. `persistedHistoryIncomplete` counts the number of events carrying that flag, not the number of distinct failures or successful rescues. A retrospective review must combine task submission records, the text before and after recovery, and actual worker evidence.

## Criteria for manual user review

1. In real samples, `prefix_appended` accounts for the overwhelming majority, `prefix_diverged` and `base_unavailable` never appear, and the evidence supports that the fallback chain did not carry out recovery work: consider downgrading the fallback chain to pure logging.
2. Paths related to incomplete persistent history actually performed a rescue: distinguish between in-memory fallback and persistent send-buffer recovery after restart by base source, record the specific cases, and then consider formalizing the mechanism and adding documentation. In-memory state is not saved across processes before a restart, so recovery after a restart must not be attributed directly to the old process's memory.
3. The evidence is insufficient to distinguish: extend the observation period and keep the structure and function frozen.

All of the above require a user decision and are not triggered automatically by a count threshold. Real-model smoke tests still require authorization each time. Native Windows/macOS official Desktop, ARM64 and active WebUI session sharing continue to be recorded as unverified; this experiment does not change the release languages or npm's `private: true`.

## Acceptance record for this batch (2026-10-12)

188 offline regressions, 74 unit tests and a fake smoke passed. Both invariants passed before and after the extraction; a mechanical comparison of the original clarification and send-record statements was consistent. An isolated real-model smoke passed on Linux Desktop, including one real clarification continuation; after exit, a new process read one `prefix_appended` (source `persisted`), the other three specified event counts were zero, and the send record was consistent with the persistent text buffer.

This is only the acceptance sample for this batch, not a long-term observation conclusion; the fallback chain was not deleted or extended on this basis. The cancellation scenario had no tool call, so it cannot be claimed that in-flight tool interruption has been verified. The original reports and test state are kept only in a local, ignored directory.
