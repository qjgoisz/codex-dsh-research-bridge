[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing

The project is licensed under GPL-3.0-only. A contribution must be one you have the right to provide under that license, and existing copyright and license notices must be preserved. See LICENSE for the full terms.

Node.js 24+ is required. The project currently has no direct dependencies; after cloning you can run:

```sh
npm run check
npm run check:docs
npm run test:unit
npm test
npm run smoke
```

`test:unit` covers cross-platform configuration, contracts, launch arguments and interactive configuration checks. The full historical regression `npm test` currently uses Linux as its baseline. CI runs syntax and unit tests on Linux, Windows and macOS, with the full regression additionally on Linux. Offline tests need no DSH, credentials, network or model quota.

When changing the protocol, state machine or shutdown behavior, provide a fake ACP message or fault-injection test that reproduces the problem. Distinguish prompts that were sent, responses that were received, and independent acceptance; unknown results are not automatically replayed. Agreement between two models cannot replace facts or research evidence.

Real DSH probing creates a test session; a real-model smoke test also consumes quota and requires an explicit operator choice. Use an isolated workspace, configuration and state directory, and do not reuse research sessions. Do not commit credentials, research data, real session records, local machine configuration, logs or personal installation paths. When reporting compatibility, state the system, architecture, Node/DSH/ACP versions and the actual entry point; offline simulation is not equivalent to native client acceptance.

A commit message should state the problem, the changed behavior, the reproduction or verification commands, and the limits. Keep configuration, the CLI/MCP interfaces and the documentation consistent. When raising an objection, provide testable evidence and an alternative, and do not silently change the task scope.

## Bilingual documentation policy

The public documentation is maintained in English (`*.md`, `docs/en/`) and Simplified Chinese (`*.zh-CN.md`, `docs/zh-CN/`), with English as the default entry. Corresponding files keep the same base filename and every page carries reciprocal language links.

- Behavior changes must update both languages in the same pull request.
- Wording, typo and formatting fixes may touch only one language.
- A delayed translation must be marked with the source revision or date it lags behind, for example `Translation pending: source revision <commit or date>`.
- Identifiers, option names, error codes and JSON field names/values remain untranslated in both languages.

## CLI error language policy

CLI errors default to English. `--lang en`, `--lang zh-CN` or the `DSH_BRIDGE_LANG` environment variable selects the language of error output; when both are given, the command-line flag wins. The policy covers CLI errors and help output; interactive prompts are not claimed to be fully translated. Human-facing errors keep stable codes and the original upstream diagnostics, and historical task/JSON/protocol records and research prompts are not rewritten. See [Usage and deployment](docs/en/usage.md#cli-language-and-error-output).

The diagnostic catalogue is maintained in `src/cli-language.mjs`. When changing a bridge diagnostic, update its English counterpart and test it at the CLI boundary. Placeholder values such as paths, task IDs and provider/model identifiers must remain literal. `npm run check:docs` checks paired filenames, reciprocal language links and local links/heading anchors without network access.

Known bridge diagnostics are translated at the CLI presentation boundary. Unrecognized diagnostic text remains literal so upstream details are not guessed or discarded. Paths, task IDs, provider/model values and existing error codes remain unchanged.
