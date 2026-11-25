# dsh-agy

在 DeepSeek Harness 中使用本机 Antigravity CLI 选择模型、发送消息并查看流式回复。插件在当前项目目录启动 `agy acp --sandbox`，由 `agy` 管理账号登录、对话上下文和工具执行。

## 安装

需要 Node.js 24.9.0 或更高版本、DeepSeek Harness 0.2.2-rc.5，以及支持 `agy acp` 的 Antigravity CLI。先在运行 Harness 的机器上打开 `agy`，按提示完成登录。可以用 `agy models` 查看当前账号可用的模型。

首次安装前，先打开一次 DeepSeek Harness 桌面应用，让它创建 `desktop` 配置，然后完全退出应用。在本仓库根目录执行以下命令。安装包保存在源码目录之外，供 Harness 后续使用。

```sh
npm ci
pkg_dir="${DSH_HOME:-$HOME/.dsh}/local-packages/dsh-agy"
mkdir -p "$pkg_dir"
npm pack --pack-destination "$pkg_dir"
dsh plugin --profile desktop add "$pkg_dir/dsh-antigravity-0.2.0-beta.3.tgz"
```

安装命令会将插件加入 `desktop` 配置。完成后重新打开 Harness。

## 使用

1. 在 Harness 中打开一个本机项目会话，点击会话标题栏的 **Antigravity**。
2. 在面板中选择模型。列表由本次连接的 `agy` 提供。
3. 输入消息并点击 **发送**，或按 ⌘+Enter / Ctrl+Enter。回复会逐步显示，可以在同一会话中继续追问。
4. 当 `agy` 请求工具授权时，在面板中选择允许或拒绝。**停止本轮**会中止当前请求，**隐藏**可收起面板并保留会话，**结束会话**会关闭对应的 CLI 进程。

如果桌面应用找不到 `agy`，在插件配置中将 `acpBinaryPath` 设为 `command -v agy` 返回的绝对路径。

## 开发

安装依赖后，运行 `npm run check` 执行类型检查、构建和测试。插件使用 [MIT 许可证](LICENSE)。
