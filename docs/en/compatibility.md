[English](../en/compatibility.md) | [简体中文](../zh-CN/compatibility.md)

# Compatibility and validation

The bridge uses Node.js 24+ and ACP v1. Platform launch adaptation and offline simulation are not equivalent to actual client compatibility; after upgrading DSH, accept it again using an isolated workspace, configuration and state.

| Entry point or platform | Validation method | Limits |
| --- | --- | --- |
| bridge + fake ACP | Offline regression, approvals/deliverables, session reuse, clarification, cancellation, unknown, EOF shutdown | Does not prove real provider or Desktop behavior |
| npm DSH + ACP profile | probe and explicit real-model smoke | Isolated ACP session; does not guarantee the active shared WebUI chat or all web plugins |
| posix-pipes | Explicitly selected and independently probed on Linux | Linux-only optional transport |
| Linux Desktop CLI/ACP | The new bridge passed an isolated model smoke through MCP: deliverables, model routing, session reuse, clarification, cancellation response, input protection and EOF shutdown | Does not prove graphical-interface operation, in-flight tool interruption or compatibility with other builds; different versions still need independent acceptance |
| Windows/macOS shared daemon | Offline CI support: syntax and unit tests on Linux, Windows and macOS, with the full historical regression additionally on Linux | CI configuration existing does not mean remote CI has passed; check actual run records |
| Windows/macOS official Desktop | Configure the launcher/runtime and full argv, then perform independent acceptance | Native client not yet accepted; deferred/unverified, not unsupported |
| ARM64 | Validate against the corresponding installation and architecture | Not yet accepted; deferred/unverified, not unsupported |
| Active WebUI session sharing | Independent acceptance against a real installation | Deferred/unverified, not unsupported |

WebUI and ACP profiles may load different plugins; sharing a DSH core does not prove that configuration, tools and session behavior are all identical. The handshake records the protocol version, agent identity and capability, and the model route is checked against the actual configOptions without silently replacing models.

When inspecting the session list, distinguish active sessions from closed sessions; some implementations filter active sessions. Test create, close, list and resume, and keep the original responses; a missing list entry alone does not prove a persistence failure.

The ACP approval kind uses allow_once/reject_once, and the optionId is an opaque value provided by the original request. The bridge locates the option by kind and returns the original optionId; it does not construct options or automatically choose allow_always. [ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)

## Offline validation

```sh
npm run check
npm run test:unit
npm test
npm run smoke
```

The CI configuration runs syntax and unit tests on Linux, Windows and macOS; the full historical regression currently runs on Linux because it still contains POSIX path and process-observation tests. The existence of a CI configuration does not mean remote CI has passed; defer to actual run records.

## Real DSH validation

```sh
node scripts/probe.mjs --config <config> --report <new report file>
node scripts/probe.mjs --config <config> --transport posix-pipes --report <another new report file>
node scripts/smoke.mjs --allow-model --config <config> --report <new research acceptance report>
```

probe does not send model prompts, but it starts DSH and creates a test session. A real-model smoke test must explicitly choose `--allow-model` and use an isolated test instance and state directory. Record the system, architecture, runtime, DSH/ACP versions, launch entry point, effective configuration and raw observations; reports are kept in a Git-ignored directory and are not published with the source.

The real smoke test checks the arithmetic file, input byte protection, active-session reuse, clarification, cancellation response and shutdown. An arithmetic fixture cannot prove a physical theory; a cancelled response alone also cannot prove that a running shell or tool has been interrupted. Window closing, process exit and tool interruption need to be verified separately, and a research instance the operator is using must not be closed.

Initialization timeouts or EOF need a side-by-side comparison between an independent fake worker and a real worker, recording the runtime environment and the raw error; do not automatically attribute them to the sandbox, and do not make running outside a sandbox a default deployment requirement.
