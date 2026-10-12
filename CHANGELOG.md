[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

## 0.2.0 — pending release

- Adopted GNU GPL v3.0 (GPL-3.0-only).
- Rebuilt on the 0.1.0 reference version as a Node.js 24 ESM research delegation bridge with zero direct dependencies; split prompts, result collection, observation, approvals and platform-adaptation modules.
- Configuration schema 2, with compatible reads of schema 1; supports an explicit worker executable, full argv, a JS entry and a runtime.
- Forwards ACP approvals by default and provides pending-approval query and approval tools; retains task idempotency, no replay of unknown results, session reuse/resume, clarification continuation and bounded shutdown.
- The MCP stdio client reuses a shared background process that holds the state lock by default, supporting concurrent connections from multiple chats and tool discovery; incompatible configuration is explicitly rejected, shutdown is delayed after the last client leaves, and the `--standalone` single-process mode is retained.
- Overlapping workspaces run serially, and deliverables record byte fingerprints and observation evidence.
- Added a cross-platform Node interactive configuration script with cached menus, preview, backup, read-only checking and external-modification detection.
- The configuration script can locate the CLI launcher from a Desktop installation directory and generate a direct launch configuration; it reports an explicit error when an entry point is missing.
- Provided offline regression, fake smoke, independent protocol probing, an explicit real-model smoke test and offline CI on three systems.
- Batch inventory reports damaged task files separately while retaining healthy tasks; workspace admission validates existing directories before durable intent, and queues receive workspace explicitly.
- Isolated the frozen clarification/prefix ledger and added persistent event counters to `inspect`; no new fallback paths were introduced.
- CLI diagnostic language selection is available: errors default to English, and `--lang en` / `--lang zh-CN` or `DSH_BRIDGE_LANG` selects the error language, with the flag winning.
- Added bilingual documentation (English and Simplified Chinese) with reciprocal language links.

The real DSH/ACP chain requires independent acceptance for the installed environment. Native Windows/macOS official Desktop, ARM64, active WebUI chat sharing and in-flight tool interruption remain unverified. See the [compatibility records](docs/en/compatibility.md) for the detailed scope; see [configuration and state compatibility](docs/en/migration.md) for migration notes.
