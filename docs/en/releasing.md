[English](../en/releasing.md) | [简体中文](../zh-CN/releasing.md)

# Release process

The current version is 0.2.0, under GPL-3.0-only, with the full terms in the root LICENSE. Source repository releases and npm package releases are handled separately. `private=true` in `package.json` only forbids npm publish and does not prevent publishing the source repository. When releasing, preserve the existing copyright and license notices of the reference code and third-party content.

## Pre-release validation

```sh
npm run check
npm run test:unit
npm test
npm run smoke
git status --short
git diff --check
npm pack --dry-run
```

The offline commands do not call a real model. Check the Git commit scope and the npm package scope: the former is controlled by `.gitignore`, the latter by `files` in `package.json`, and the two cannot substitute for each other. Local configuration, historical handover materials, sessions, reports, credentials and configuration backups must not enter a release. `.gitignore` does not exclude files that are already tracked.

## Source repository

After determining the LICENSE, repository address and support scope, commit the source code, tests, general examples, documentation and CI. After confirming the remote CI result, create the version tag and Release, describing the measured platform scope and known limitations. CI for a new repository that has not run yet must not be written as passing.

## npm package

The following commands are for the maintainer to run when publishing deliberately; the repository currently still keeps `private=true`. The commands apply to PowerShell and macOS/Linux terminals. An npm account is required; a GitHub account is not automatically an npm account.

### 1. Determine the package name and log in

Using `codex-dsh-research-bridge`, consistent with the repository, is recommended; first check the name and existing maintainers:

```sh
npm view codex-dsh-research-bridge name version maintainers --registry=https://registry.npmjs.org/
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

If the query returns E404, re-check the spelling, registry and network state; if the name is already taken by someone else, use `@<npm account>/codex-dsh-research-bridge`. The rest of this document uses the unscoped name as an example; when a scope is actually used, replace the name and the tarball filename accordingly.

Publishing a public package requires the account to have two-factor authentication enabled, or a granular token with publish permission that is allowed to bypass 2FA; for manual publishing, prefer following the npm login and authentication prompts, and do not write the token into the repository. [npm publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

### 2. Prepare release metadata

Run these in the source repository root:

```sh
npm pkg set name=codex-dsh-research-bridge
npm pkg set repository.type=git repository.url=git+https://github.com/qjgoisz/codex-dsh-research-bridge.git
npm pkg set homepage=https://github.com/qjgoisz/codex-dsh-research-bridge#readme
npm pkg set bugs.url=https://github.com/qjgoisz/codex-dsh-research-bridge/issues
```

Keep `license=GPL-3.0-only`, the Node.js 24+ requirement and the `dsh-bridge` CLI name. Confirm that `version` is the version planned for release and not yet published; later versions can use `npm version patch/minor/major`, which usually also creates a commit and Git tag. Do not overwrite an already published package with the same name and version. [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

### 3. Pack and inspect in an isolated directory

First run the source validation commands on this page, then run:

```sh
npm pack --dry-run
npm pack
npm install --prefix ../bridge-package-check ./codex-dsh-research-bridge-0.2.0.tgz --ignore-scripts --offline --no-audit --no-fund
node ../bridge-package-check/node_modules/codex-dsh-research-bridge/src/cli.mjs --help
node ../bridge-package-check/node_modules/codex-dsh-research-bridge/scripts/configure-bridge.mjs --check
```

Replace the `.tgz` filename with the actual version, and the check directory must be brand new. Verify that the package contains LICENSE, NOTICE, code, general examples and usage documentation, and that it does not contain credentials, real configuration or session materials. Source development tests and the default fake smoke need `test/`, which a trimmed npm package does not contain, so these commands should be run in the source repository.

### 4. Publish deliberately and verify the result

After the checks pass, remove the npm publish protection and commit the metadata changes:

```sh
npm pkg delete private
git diff --check
git add package.json
git commit -m "Prepare npm release"
npm publish --dry-run --access public --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
npm view codex-dsh-research-bridge version dist-tags --registry=https://registry.npmjs.org/
```

`--dry-run` does not publish and cannot guarantee that the login, permission or authentication checks of the real publish will pass. An unscoped package is public; a public scoped package must explicitly use `--access public`. A real publish uploads the package to the public registry and does not require pushing to GitHub first; for traceability, the corresponding source commit and version tag should still be pushed together.

After publishing, users can install it:

```sh
npm install -g codex-dsh-research-bridge
dsh-bridge --help
dsh-bridge config --init
dsh-bridge preflight
```

After a global install, the interactive configuration entry point is at `codex-dsh-research-bridge/scripts/configure-bridge.mjs` under the directory returned by `npm root -g`; run that file with Node and pass `--config` explicitly. For a graphical MCP client, use the actual Node executable and the absolute path of the in-package `src/cli.mjs`; on Windows, do not use the npm `.cmd` launcher as the worker executable.
