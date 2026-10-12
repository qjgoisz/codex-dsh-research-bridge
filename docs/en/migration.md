[English](../en/migration.md) | [简体中文](../zh-CN/migration.md)

# Configuration and state compatibility

A new bridge.config.json is schema 2. Schema 1 is loaded read-only by the validator with the new fields filled in memory; there is no automatic write-back. Worker entry and approval configuration are new. The default configuration path is changed to the current launch directory, and an explicit --config is recommended for deployment. A missing explicit configuration, an unknown CLI option, a repeated scalar argument or an illegal override is an error and does not fall back to another configuration or route.

reasoningEffort is validated only as a string structure and is finally validated against the configOptions published by the worker. null (compatible with the old empty string) means the provider default; explicitly turning reasoning off requires an option actually supported by the provider.

New tasks do not require permissions, reversePolicy or allowRecursiveDelegation; when omitted, the semantics remain consultation-only and non-recursive. An old tools list participates in approval only when explicitly provided; old readPaths/writePaths do not expand the runtime environment's permissions. To adopt the new approval behavior, omit tools in a **new task**; do not rewrite the contract of a task that has already executed.

The outer layer of task and session storage is still schema 1, retaining old fields and fingerprints; the new workerSnapshot and approval events are additional fields. Old tasks can be read, but unsettled records serve only as a recovery report and are not replayed automatically. Changes to the bridge's default model/reasoning cannot rewrite the applied snapshot of a historical task.

By default the bridge does not take over the state of the original bridge. Before reusing old state, stop the old writer, confirm the workers have exited, back up the entire state directory, and run `inspect` on a copy; the two bridge versions must not write to the same directory. No live research state was migrated in this round.

The old offline-admission policy of configuration schema 1 is not ported; network=true is now an allowed contract. The old permissions.network=false continues to express a task's offline intent. Environment approval, file access and credential management continue to be handled by DSH's existing mechanisms.

The capabilities field in the session map is a historical compatibility name and currently encodes only provider/model/reasoning; the new interface internally names it modelRouteFingerprint. Git branches, input commits and the tool set are not automatically included in the session identity; input changes require an explicit contextRevision update.

Independent Codex consultation instances and automatic upgrade/monitoring are not implemented. Desktop installation discovery is available through `--desktop` / `--desktop-root` (see [Usage and deployment](usage.md)); native Windows/macOS official Desktop acceptance remains deferred. The license is GPL-3.0-only; see the repository LICENSE. Verify upstream capabilities in new test directories after upgrades without changing or replaying research sessions.
