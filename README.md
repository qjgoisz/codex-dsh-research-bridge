[English](README.md) | [简体中文](README.zh-CN.md)

# codex-dsh-bridge

A durable MCP → ACP research delegation bridge. Codex organizes the goal, context and acceptance criteria; DSH performs derivations, computation and file work; the bridge records tasks, sessions, routing and result evidence. `completed` means an execution round has ended; research conclusions still require independent acceptance.

The current implementation uses Node.js 24 ESM with no direct dependencies. It supports stdio MCP, ACP v1, task idempotency, clarification continuation, session resume, model routing and bounded shutdown. No tool manifest is required by default, and the bridge is not forced offline. Approvals actually emitted by DSH are forwarded to the controller through `dsh_approvals` / `dsh_approve` by default.

```sh
node src/cli.mjs --help
node scripts/configure-bridge.mjs
node src/cli.mjs preflight
node src/cli.mjs serve --state-root ./bridge-state
```

Run these from the repository directory. The interactive configuration script is cross-platform: it previews and validates before asking you to confirm the save, and preserves an original backup when modifying an existing file; `config --init` can also create a default configuration only. The template defaults to deepseek-official/deepseek-flash/high; the runtime catalogue is the basis for routing and reasoning options and does not switch models automatically. Credentials continue to be managed by DSH.

When using Desktop, run `node scripts/configure-bridge.mjs --desktop` and provide the installation directory as prompted so the CLI can be located; it does not start the graphical application or call a model. The interactive questions mention the common endings `.app`, `Contents/Resources` and `resources`. WeChat/account login should select `deepseek-account` and share Desktop's DSH home; `deepseek-official` requires an API key, and the Desktop preset will not switch routing automatically. See the usage documentation for entry layouts and platform limits.

Connecting a real DSH installation requires independent probing and acceptance for the installed version. Offline regression, model-free protocol probing and an explicit real-model smoke test are provided; Windows/macOS official Desktop, ARM64 and active WebUI chat sharing remain unverified. See the compatibility notes for details.

- [Usage and deployment](docs/en/usage.md)
- [Windows and macOS quick start](docs/en/usage.md#windows-and-macos-quick-start)
- [Architecture and invariants](docs/en/architecture.md)
- [Compatibility and validation records](docs/en/compatibility.md)
- [Configuration and state compatibility](docs/en/migration.md)
- [License](LICENSE)
- [Origin and copyright notice](NOTICE.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Release process](docs/en/releasing.md)
- [Clarification prefix ledger experiment](docs/en/prompt-ledger-experiment.md)

```sh
npm run check
npm test
npm run test:unit
npm run smoke
```

The default tests use a fake ACP worker and need no DSH, credentials, network or model usage. `probe` starts a real DSH and creates an isolated test session, but does not send a model prompt. Only `smoke -- --allow-model --config <config file>` calls a real model; it uses an isolated test workspace and state and does not reuse research sessions.

This project is licensed under GNU GPL v3.0 (GPL-3.0-only), see LICENSE. It currently keeps private=true and has not published an npm package; npm publication is pending.

## Documentation languages

The public documentation is maintained in English and Simplified Chinese, with English as the default entry. Every page carries reciprocal language links, and corresponding files keep the same base filename. Behavior changes must update both languages in the same pull request; wording fixes may touch a single language, and a delayed translation is marked with the source revision or date it lags. Identifiers, options, error codes and JSON remain untranslated. See [CONTRIBUTING.md](CONTRIBUTING.md).

## CLI error language

CLI errors default to English. `--lang en`, `--lang zh-CN` or the `DSH_BRIDGE_LANG` environment variable selects the language of error output; when both are given, the command-line flag wins. This policy applies to CLI errors and help output. Interactive configuration prompts, menus and previews are not claimed to be fully translated. Human-facing errors keep stable codes and the original upstream diagnostic text. Historical task records, JSON payloads, protocol records and research prompts are not rewritten. See [Usage and deployment](docs/en/usage.md#cli-language-and-error-output).
