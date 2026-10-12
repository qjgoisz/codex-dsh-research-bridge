[English](../en/architecture.md) | [简体中文](../zh-CN/architecture.md)

# Architecture and invariants

```text
Codex → MCP stdio → durable coordinator → ACP stdio → DSH worker
                        ↓                   ↑
                 tasks / session map    updates / approvals
```

The main body continues to use Node.js 24 ESM and retains the reference implementation's protocol and lifecycle logic, which is covered by fault tests. Platform code is concentrated in src/platform; launch arguments, installation discovery and runtime capability are treated as adapter facts, and the core does not read Desktop private configuration or credentials.

| Module | Responsibility |
| --- | --- |
| cli / config | Commands, deployment configuration, overall validation and precedence |
| mcp-server / acp-client | Protocol framing on both sides, request correlation, versions and errors |
| orchestration | Intent persistence, session acquisition, task dispatch, settlement and recovery |
| state / store / session-map | Pure state transitions, single-writer atomic storage, session generation |
| workspace-queue | Queueing for overlapping directories to avoid different sessions competing for the same files |
| prompt-ledger | Frozen clarification fallback, sent-text ledger and experimental event statistics |
| prompts | Tasks, independent objections, clarification history and research conventions |
| collector / observation / usage / fingerprint | Body and usage observation, submission evidence and deliverable byte fingerprints |
| permissions | Actual approval forwarding, option validation, deadlines and audit |
| worker / platform | Installation discovery, full argv, POSIX/Windows reclamation |
| shutdown | Bounded shutdown shared by signals, EOF and the watchdog |

A task must first be persisted as queued, then persisted as dispatching, before a prompt is started or sent. Model execution and the MCP wait budget are separate; exhausting the wait does not mean the execution failed. When an approval appears, the waiting tool returns the pending information early so that the controller does not keep waiting on a task blocked by its own approval.

The task contract fingerprint guarantees idempotency. Prompts within the same session are serialized; overlapping workspaces are also serialized. The connection index and the ownership ledger for all workers are separate; after a bad connection is deleted it is still responsible for reclaiming its processes. Sending a signal is not the same as observing an exit.

Submission facts are recorded by the actual request write/response path. Only a definite non-submission can be no_prompt; a possible submission whose result is invisible must be unknown. Unsettled tasks are not replayed after startup; adjudication and replay are performed separately. An approval cannot be returned if persisting the approval request or decision fails.

The worker's protocol version, capabilities, entry point, platform and runtime are saved as a snapshot; the model route is set before execution and saved as a task snapshot. The historical capabilities field is kept for compatibility, and its content is only a model route fingerprint, not tool permissions. There is currently no general automatic-discovery guarantee for the effective tool set.

usage used/size represents context occupancy and must not be interpreted as cached tokens or cost. No valid samples means unobserved. Prefix consistency is only string evidence. completed, agreement between models or file fingerprints cannot prove that a research conclusion is correct.

The current reverse path is still an explicit clarification that ends the round, after which the controller answers and the task continues. An independent Codex consultation instance is not implemented; that feature would need an explicit consultation budget, authorization and a recursive stop boundary.
