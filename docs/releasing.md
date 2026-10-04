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

如需 npm 发布，另外确认包名、发布账户、许可证、repository 字段和版本号，再移除 `private=true`。先执行 `npm pack`，在全新目录安装生成的压缩包，验证 `dsh-bridge --help` 与配置入口；最后由获授权的维护者执行 publish。源码仓库中的开发检查命令需要测试文件，精简 npm 包不包含开发测试。
