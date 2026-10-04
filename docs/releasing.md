# 发布流程

当前版本为 0.2.0，采用 GPL-3.0-only，完整条款见根目录 LICENSE。源码仓库发布和 npm 包发布分别处理。`package.json` 的 `private=true` 只禁止 npm publish，不妨碍发布源码仓库。发布时保留参考代码及第三方内容的已有版权和许可声明。

## 发布前验证

```sh
npm run check
npm run test:unit
npm test
npm run smoke
git status --short
git diff --check
npm pack --dry-run
```

离线命令不调用真实模型。核对 Git 提交范围和 npm 打包范围：前者由 `.gitignore` 控制，后者由 `package.json` 的 `files` 控制，两者不能相互替代。本机配置、历史交接资料、会话、报告、凭据和配置备份均不应进入发布。`.gitignore` 不会排除已经被跟踪的文件。

## 源码仓库

确定 LICENSE、仓库地址与支持范围后，提交源代码、测试、通用示例、文档和 CI。确认远端 CI 结果后创建版本标签与 Release，说明平台实测范围和已知限制。新仓库尚未运行的 CI 不应写成通过。

## npm 包

以下命令供维护者主动发布时执行；当前仓库仍保留 `private=true`。命令适用于 PowerShell 和 macOS/Linux 终端。需要 npm 账户，GitHub 账号不自动等于 npm 账号。

### 1. 确定包名并登录

建议使用与仓库一致的 `codex-dsh-research-bridge`，先查询名称和现有维护者：

```sh
npm view codex-dsh-research-bridge name version maintainers --registry=https://registry.npmjs.org/
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

若查询返回 E404，再确认拼写、registry 与网络状态；若名称已被其他人占用，可使用 `@<npm账号>/codex-dsh-research-bridge`。本文后续以未加 scope 的名称为例，实际使用 scope 时同步替换名称和压缩包文件名。

发布公开包需要账户启用双因素认证，或使用具有发布权限且允许绕过 2FA 的 granular token；手动发布优先按 npm 登录和认证提示操作，不把 token 写入仓库。[npm 发布指南](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

### 2. 准备发布元数据

在源码仓库根目录执行：

```sh
npm pkg set name=codex-dsh-research-bridge
npm pkg set repository.type=git repository.url=git+https://github.com/qjgoisz/codex-dsh-research-bridge.git
npm pkg set homepage=https://github.com/qjgoisz/codex-dsh-research-bridge#readme
npm pkg set bugs.url=https://github.com/qjgoisz/codex-dsh-research-bridge/issues
```

保留 `license=GPL-3.0-only`、Node.js 24+ 要求及 `dsh-bridge` CLI 名称。确认 `version` 是计划发布且尚未发布的版本；后续版本可用 `npm version patch/minor/major` 更新，该命令通常也会创建提交和 Git 标签。不要覆盖已发布的同名同版本包。[npm publish 说明](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

### 3. 打包并在独立目录检查

先执行本页的源码验证命令，然后执行：

```sh
npm pack --dry-run
npm pack
npm install --prefix ../bridge-package-check ./codex-dsh-research-bridge-0.2.0.tgz --ignore-scripts --offline --no-audit --no-fund
node ../bridge-package-check/node_modules/codex-dsh-research-bridge/src/cli.mjs --help
node ../bridge-package-check/node_modules/codex-dsh-research-bridge/scripts/configure-bridge.mjs --check
```

按实际版本替换 `.tgz` 文件名，检查目录必须是全新目录。核对包内含 LICENSE、NOTICE、代码、通用示例和使用文档，且不含凭据、真实配置与会话资料。源码开发测试及默认 fake 冒烟需要 `test/`，精简 npm 包不包含该目录，因此这些命令应在源码仓库执行。

### 4. 明确发布并核对结果

检查通过后再解除 npm 发布保护、提交元数据改动：

```sh
npm pkg delete private
git diff --check
git add package.json
git commit -m "Prepare npm release"
npm publish --dry-run --access public --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
npm view codex-dsh-research-bridge version dist-tags --registry=https://registry.npmjs.org/
```

`--dry-run` 不发布，也不能保证正式发布的登录、权限或认证检查通过。无 scope 的包为公开包；公开 scoped 包明确使用 `--access public`。正式 publish 会向公共 registry 上传包，不需要 push GitHub 才能执行；为便于追溯，仍应同步推送对应源码提交与版本标签。

发布后用户可安装：

```sh
npm install -g codex-dsh-research-bridge
dsh-bridge --help
dsh-bridge config --init
dsh-bridge preflight
```

全局安装后的交互配置入口位于 `npm root -g` 返回目录下的 `codex-dsh-research-bridge/scripts/configure-bridge.mjs`，用 Node 执行该文件并显式传入 `--config`。图形 MCP 客户端建议使用实际 Node 可执行文件和包内 `src/cli.mjs` 的绝对路径；Windows 不将 npm 的 `.cmd` 启动器作为 worker 可执行文件。
