[English](../en/usage.md) | [简体中文](../zh-CN/usage.md)

# Usage and deployment

Node.js 24+ and a DSH installation with an ACP v1 entry point are required. First confirm that DSH itself can use the required provider/model; the bridge does not configure credentials, does not initialize a profile, and does not modify Codex or DSH configuration. Using the ACP worker of an existing DSH installation does not mean sharing the active chat of the WebUI.

## Windows and macOS quick start

The following is based on using the source repository and requires Node.js 24+, Git and a working DSH ACP entry point to be installed first. No Bash or extra npm dependencies are needed.

### Windows (PowerShell)

```powershell
git clone https://github.com/qjgoisz/codex-dsh-research-bridge.git
cd codex-dsh-research-bridge
node --version
node scripts/configure-bridge.mjs
node src/cli.mjs preflight
```

The configuration uses `transport=direct`. If automatic discovery cannot locate DSH, set `nodeBin` to the actual `node.exe` path and `workerEntry` to the DSH JS CLI entry, with `workerArgs=null` to use the default profile arguments; to customize the full arguments, provide a JSON array. Do not use `.cmd` / `.bat` as `workerCommand`. Backslashes in JSON must be written as `\\`, or use forward slashes.

Register the actual `node.exe` with the MCP client as the command, and the items after `node` in the following command as args, using absolute paths:

```powershell
node "<bridge directory>/src/cli.mjs" serve --config "<config file>" --state-root "<isolated state directory>"
```

### macOS (Terminal)

```sh
git clone https://github.com/qjgoisz/codex-dsh-research-bridge.git
cd codex-dsh-research-bridge
node --version
node scripts/configure-bridge.mjs
node src/cli.mjs preflight
```

Also use `transport=direct`; do not choose the Linux-specific `posix-pipes`. Register Node's absolute path with the MCP client (use `command -v node` to find it), and use the absolute paths for `src/cli.mjs serve --config ... --state-root ...` as args. Graphical applications do not necessarily inherit the terminal PATH.

For Desktop on both platforms, first confirm that the corresponding client version actually provides a CLI/ACP entry point; configure an explicit runtime and entry point when needed, and do not assume internal installation-bundle paths. Native Windows/macOS official Desktop has not been accepted yet; the above are launch and configuration steps. `preflight` is an installation/configuration pre-check; for full protocol validation you can run `node scripts/probe.mjs --config <config> --report <new report file>`, which starts a test worker but does not send a model prompt.

## Configuration

Using the interactive configuration is recommended:

```sh
node scripts/configure-bridge.mjs
# Linux/macOS can also use the thin entry point
sh scripts/configure-bridge.sh
# or
npm run configure
```

When connecting to Desktop, you can let the configuration script locate the CLI launcher inside the installation directory:

```sh
node scripts/configure-bridge.mjs --desktop
# or specify the directory, preview only, do not save
node scripts/configure-bridge.mjs --desktop-root "<Desktop installation directory>" --check
```

A path description is shown before the interactive directory questions:

| Input type | Common ending or example |
| --- | --- |
| macOS application bundle | `/Applications/<app name>.app` |
| macOS resources directory | `<app name>.app/Contents/Resources`, note the capitalization |
| Linux installation root | e.g. `/usr/lib/<app-name>`, with no fixed suffix |
| Linux/Windows resources directory | usually ending in `/resources` |

The script looks for `runtime/cli/bin/dsh` (or `dsh.exe` on Windows) under these directories. This is the installation entry point, not the user configuration directory `~/.dsh`; no additional launch wrapper script is needed.

#### Desktop WeChat/account authentication

`deepseek-account` uses the Desktop account login, including WeChat login; `deepseek-official` is an API route that requires `DEEPSEEK_API_KEY`. The Desktop preset keeps the existing provider/model and does not switch authentication automatically. If you want to reuse the account login, explicitly select the account route, and the bridge's `dshHome` (or `DSH_HOME`) should be the same as Desktop's, usually `~/.dsh`; the bridge still uses the `acp` profile and does not copy Desktop's entire profile patches or credential store.

```sh
node scripts/configure-bridge.mjs --desktop-root "<installation root, .app or resources directory>" --set provider deepseek-account --set model deepseek-flash --set profile acp --check
```

After confirming the preview, remove `--check`, save as prompted, and restart the bridge. The model id is subject to the actual worker catalogue; successfully reading the directory or validating the structure does not mean authentication succeeded, and a real model answer must be verified separately. If it still reports that `DEEPSEEK_API_KEY` is missing, check whether the effective route is still `deepseek-official`. Do not put login tokens or API keys in the bridge configuration or documentation. Native account invocation on Windows/macOS has not been accepted yet.

`--desktop` first asks for the installation directory and then enters the usual field questions and save confirmation. You can also pass a macOS `.app` or `Resources` directory. The script checks `resources/runtime/cli/bin/`, `Contents/Resources/runtime/cli/bin/` and a directly provided Resources directory; on Linux/macOS it looks for an executable `dsh`, and on Windows for `dsh.exe`. These are a limited set of candidate layouts and do not guarantee that every Desktop version has the same entry point; if only `.cmd/.bat` exists or no entry point is found, it reports an explicit error and does not execute a graphical launcher. Native Windows/macOS compatibility still needs independent verification.

The Desktop preset sets `workerCommand` and `transport=direct`, and clears old npm root and JS runtime overrides; it preserves provider/model, reasoning effort, profile, dshHome and approval policy. `workerArgs=null` means the default arguments are built for the current profile. Explicit `--set` takes precedence over the preset; the final preview is authoritative. It does not start Desktop, modify its configuration, migrate credentials or silently switch models. After saving, first run preflight and an independent probe; model routing and real delegation need separate acceptance.

Enter keeps the current value; a nullable field accepts `null`, and `workerArgs` accepts a JSON string array. The script previews and validates the full schema 2 configuration, and only saves after a final `y`. An existing file is backed up byte-for-byte as `bridge.config.json.bak.*`; if the content is unchanged, nothing is written and no backup is made. `_` / `$` comment fields in the original configuration are preserved; saving an old schema 1 upgrades it to schema 2. If an external modification, symlink or another configuration process's lock is detected, overwriting is refused. The default configuration path is the launch directory; use `--config` to specify another location.

The interactive script reads the bridge configuration and the selected DSH profile model definitions without starting DSH or calling a model. It falls back to the existing `models.json` cache or manual input when static discovery is unavailable; `--cached-models` selects only the cache/manual path. Ordinary bridge configuration saves do not change DSH profiles or credentials. Explicit provider synchronization can write the target profile after both confirmations described below. The menu is not proof of authentication or online model availability. Approval defaults to `ask`; `allow-once` selects automatic one-time approval for actual ACP permission requests.

Batch setting and read-only preview use the original parameters:

```sh
node scripts/configure-bridge.mjs --set reasoningEffort null --check
node scripts/configure-bridge.mjs --config ./custom.json --set provider deepseek-official --set model deepseek-flash --yes
node scripts/configure-bridge.mjs --help
```

`--check` asks no questions and writes no files; `--yes` uses the specified values or the current defaults and saves directly after preview and validation. `--set` may be repeated; it skips field questions but still requires save confirmation unless `--yes` is also used. The original `--mount-acp` has not been ported; DSH configuration continues to be managed by DSH.

Run these from the bridge directory:

```sh
node src/cli.mjs config --init
node src/cli.mjs config
node src/cli.mjs preflight
```

Configuration precedence is CLI arguments, configuration file, built-in defaults. The default configuration and state are located in the launch directory and are not written into the installation package directory. Use `--config <file>` for a custom configuration; built-in values are used when the default configuration is missing, while an explicitly specified configuration file that is missing is an error.

| Configuration | Behavior |
| --- | --- |
| schema | 2 for new configurations; old schema 1 can be read |
| provider / model | Readable route; the bridge encodes the protocol-selected values |
| reasoningEffort | Non-empty provider effort level; null follows the provider default |
| exposeModelChoice | Default false; true exposes dsh_models and task routing overrides |
| profile | Default acp; must have an ACP entry point |
| dshHome / dshRoot | Optional DSH home and npm installation root; no credentials |
| workerCommand / workerArgs | Explicit executable and full argv; args=null uses the default profile arguments |
| workerEntry / nodeBin | JS entry and runtime; for explicit installations/bundled runtimes |
| transport | direct; Linux may explicitly select posix-pipes |
| promptTimeoutMs | Per-execution model budget, default 30 minutes |
| requestTimeoutMs | ACP control request budget, default 30 seconds |
| approvalMode | ask (default), deny, allow-once |
| approvalTimeoutMs | Pending approval budget, default 5 minutes |

For a DSH npm installation, the bridge preferably discovers the actual package root through the launcher on PATH, then runs the JS entry with the current Node. Desktop uses a verified explicit executable/runtime with the full argv; the bridge does not assume private directories of the Windows/macOS bundle. Windows .cmd/.bat launchers must be replaced with node.exe and a JS entry to avoid shell interpolation.

## MCP service

Register the following command with the controller client as the MCP stdio server launch command. File and state paths should use absolute paths on the local machine to avoid changes in the client launch directory.

```sh
node <bridge directory>/src/cli.mjs serve --config <config file> --state-root <isolated state directory>
```

`serve` starts or reuses a shared background process for the same state directory by default. Tool-discovery connections from multiple chats and clients share tasks, sessions and approvals, with the background process exclusively holding `bridge.lock`; each client's JSON-RPC request IDs are independent. The background process listens only on the local loopback address, and the connection token is stored in `daemon.json` in the state directory (new files have mode 0600); keep the entire state directory in a location only you can access, and do not commit this file. Background logs are in `daemon.log`.

A single client disconnecting does not cancel other clients' tasks. After the last client leaves, the background process waits 30 seconds by default before reclaiming workers and releasing the lock through the existing flow; this can be adjusted with `--idle-timeout-ms`. On a disconnect the client does not resend unacknowledged requests; after reconnecting, query the task status first. Task IDs are globally unique within the same state directory.

All shared clients should use the same bridge code and effective configuration. After the configuration or code changes, close all clients using that state directory, wait for the background process to exit, then reconnect; incompatible configuration is reported explicitly. Model catalogue queries for each connection use that client's working directory, and delegated tasks must still specify the workspace explicitly. A single CLI write command cannot occupy the same state directory at the same time as the background process; operate on tasks through the MCP tools instead.

An old bridge started before an upgrade has no shared entry point; stop it normally through the client and confirm the lock is released before connecting the new version. Do not delete an active write lock; a residual lock left by an abnormal exit still requires verification before an explicit `unlock --stale`.

Use `serve --standalone` when the old single-process lifecycle is needed: that mode exclusively occupies the state directory and finishes immediately on stdin EOF. Offline end-to-end tests and model smoke use this mode; shared-connection tests separately verify concurrency and shutdown after the last client disconnects. When registering the MCP with Codex, also set a `cwd` that always exists, so the child process can start after the project is moved.

| Tool | Purpose |
| --- | --- |
| dsh_delegate | Validate, persist and dispatch asynchronously; waits up to 30 seconds by default, waitMs=0 returns immediately |
| dsh_status / dsh_result | Query status, body, usage and deliverable fingerprints |
| dsh_reply | Answer needs_clarification, with parameters id and answer |
| dsh_cancel | Request cancellation; only cancelled means cancellation is confirmed |
| dsh_resolve / dsh_retry | First adjudicate unknown, then retry explicitly; at most one replay per task |
| dsh_approvals / dsh_approve | View the original pending approval options, and return the authorized option and reason |
| dsh_models | Read/refresh the runtime catalogue after model selection is enabled |

The minimal contract requires id, objective, phase, workspace, plan and acceptance. workspace must be an absolute path to an existing directory on this platform; a missing directory or a file passed in is returned together with other contract errors, and a validation failure does not create a task record. Phases can be explore, numerics, writing, maintenance or generic. research can record the model, units, assumptions, parameter ranges, input commits and open questions; deliverables specifies the files that need descriptions and computed fingerprints.

See examples/task.json for an example. The file uses a `__WORKSPACE__` placeholder that must be replaced with the actual absolute path before submission. Spaces and Chinese characters in paths are supported. Do not apply a Windows path string directly as a POSIX path.

New tasks do not need permissions; the old readPaths/writePaths are task conventions and deliverable evidence, not a filesystem authorization. network=false expresses an offline requirement in the prompt; the actual access scope is determined by DSH's own runtime environment. When an old tools list is explicitly provided it is still used for approval handling; when omitted, the configured approval policy is used.

The default ask pauses the operation when DSH actually emits an approval, and the controller can query it at the same time. The optionId of dsh_approve must come from dsh_approvals, and reason should record the existing user authorization or the approval rationale. It does not expand user authorization on its own. allow-once is an automatic one-time approval policy explicitly chosen by the operator and cannot select allow_always; deny refuses the request. Approval only covers requests actually emitted by DSH and cannot guarantee that all tools pass through this channel.

## Sessions and recovery

A session is reused for the same project, phase, workspace, contextRevision and model route. An active session on the same connection continues directly; after reconnecting, resume is attempted; a failed resume records the reason and rotates the generation. Input or branch changes require the caller to adjust contextRevision; the bridge does not detect Git branches automatically. Overlapping workspaces run serially, while non-overlapping directories may run in parallel.

The same task id with an identical contract returns the existing record and does not re-execute; different content reports a conflict. A timeout or disconnect may leave side effects, and unknown results are not replayed automatically. A bridge restart only reports unsettled tasks; verify the workspace and worker first, then adjudicate and retry explicitly. resolve only accepts unknown and does not accept cancelling, which may still be running.

The clarification prefix ledger is retained for now as a long-term observation experiment, and the fallback chain is frozen against feature expansion. `inspect` outputs persistent event statistics; see the [prefix ledger experiment](prompt-ledger-experiment.md) for the criteria, counting boundaries and the manual user-review method.

## Diagnostics and maintenance

```sh
node scripts/probe.mjs --config <config file> --report <new report file>
node src/cli.mjs inspect --state-root <state directory>
node src/cli.mjs models --config <config file> --state-root <state directory> --workspace <test directory> --refresh
node src/cli.mjs unlock --state-root <state directory> --stale
```

Batch status queries, `inspect` and recovery inventories continue to list valid tasks and report unreadable task files separately under `problems` (task id, error code and reason). Corrupted files are not modified, deleted or automatically replayed; querying that task directly still reports a strict error. `Store.readAll()` keeps the Map return value and attaches the `problems` array from this inventory.

probe does not send model prompts; it creates a new test directory, a test session, and attempts to close/resume it, and DSH may save metadata. After an upstream upgrade, validate with isolated state and do not rewrite old research state. The lock of an active writer cannot be preempted by age; unlock --stale still refuses active writers.

When the shared background process exits or the standalone MCP service exits, its workers are reclaimed in a bounded way and the write lock is released; when the exit cannot be observed, this is reported as-is. Uninstalling only requires removing the controller's MCP registration and stopping the bridge; research state is kept at the user's discretion, and the bridge does not automatically delete DSH sessions or research data.

The CLI delegate/reply/retry are single-execution tools that require an explicit --approval-mode deny or allow-once and exit after settlement. For interactive approvals and asynchronous tasks, use the long-running serve/MCP tools; the CLI does not claim that a background model task continues after exit. --wait is retained as a compatibility parameter.

### Reading the DSH model catalogue during configuration

Run `node scripts/configure-bridge.mjs`, first confirm the DSH home, profile and worker installation entry point, then read the provider and model menu from the current profile's bundle, profile patches and home patches. A Desktop installation can still use `--desktop` or `--desktop-root`.

The read does not start DSH, call a model, parse credentials or initialize a profile; dynamic conditions are not executed and the catalogue may be incomplete. The menu reflects the local configuration and does not guarantee that the account is logged in or that the models are online. Re-run the configuration script to refresh the menu after changing the profile or installation. When an override with custom workerArgs cannot be statically inferred, use the cache or enter values manually.

The read depends on the read-only configuration interface of an installed DSH and currently supports DeepSeek account/API and pi-ai providers. Internal interface changes, an uninitialized profile, an unreadable ASAR-only installation and similar cases are reported explicitly, falling back to the existing `models.json` cache or manual input; `--cached-models` can skip configuration reading deliberately. The cache is specified with `--state-root`. It does not call `dsh --dump-config`, which has profile-writing side effects, to obtain the menu.

If a provider is configured only in the `desktop` profile used by Desktop while the bridge uses `acp`, the script shows the routes and sources of other profiles separately and does not misreport them as available to the current worker. Changing only the provider/model in the bridge configuration does not synchronize the DSH plugin configuration; before use, the provider configuration must be synchronized to ACP, and the bridge's profile cannot simply be changed to desktop to replace the ACP protocol entry point.

### Double-confirmation provider sync

When interactive configuration discovers extra routes in other profiles, it asks per provider whether to synchronize. First answer `y`, then review the source/target, the add or replace scope, the model list and the backup notes; only entering the exact `SYNC` writes to the target profile's `cordis.patch.yml`. Any other answer or end of input does not trigger that write. `--yes`, `--check` and `--cached-models` do not synchronize automatically.

The sync copies the complete configuration of the selected provider, including existing authentication references and possibly inline configuration values, without reading credential files or displaying keys/headers. A provider with the same name is replaced, while other providers and other configuration in the target plugin are preserved; the entire Desktop profile is not copied, and the bridge's ACP protocol entry point is not changed. The target plugin must already be enabled and unique; if a home patch causes a conflict, it stops and does not automatically modify global patches or install plugins.

The DSH write and the bridge configuration save are separate: the sync happens immediately after the second confirmation, and cancelling the bridge configuration save afterwards does not undo it. The original patch file is backed up byte-for-byte, and the relevant configuration is checked for changes before writing; when the format allows, an overriding patch is appended, otherwise the list is re-serialized, as described in the preview. After success, the menu is re-read; an already running worker may need a restart to use the new route. To restore, overwrite the target patch file with the prompted backup while no configuration-writing process is running; if the original file did not exist, restore by deleting the newly created patch file. Relative paths/expressions in authentication references are still interpreted in the target profile's environment and must be checked separately; this does not mean model calls have been verified.

## CLI language and error output

CLI errors default to English. `--lang en`, `--lang zh-CN` or the `DSH_BRIDGE_LANG` environment variable selects the language of error output; when both are given, the command-line flag wins. This policy applies to CLI errors and help output; interactive prompts, menus and previews are not claimed to be fully translated.

Human-facing errors retain stable machine-readable codes and the original upstream diagnostic text, so that callers and tooling can match on the code rather than on prose. Historical task records, JSON payloads, protocol records and research prompts are not rewritten into another language. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the corresponding contribution policy.

```sh
node src/cli.mjs preflight --lang en
node src/cli.mjs config --lang zh-CN
node scripts/configure-bridge.mjs --help --lang en
```

Known bridge diagnostics are translated at the CLI presentation boundary. Unrecognized diagnostic text remains literal so upstream details are not guessed or discarded. Paths, task IDs, provider/model values and existing error codes remain unchanged.
