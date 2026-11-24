# dsh-agy

在 DeepSeek Harness 的项目会话标题栏点击 **Antigravity**，即可使用本机 `agy` 选择模型、发送消息和接收流式回复。插件通过标准输入输出与 CLI 通信；账号登录、与 Google 的连接、会话上下文和工具执行均由 CLI 负责。

## 使用

1. 在运行 Harness 的机器上安装 Antigravity CLI，运行 `agy`，按 CLI 的提示完成自己的登录或配置。可用 `agy models` 检查 CLI 的可用模型。
2. 在 Harness 中打开本机项目，点击标题栏的 **Antigravity**。下拉框里的模型由这次 CLI 会话返回。面板会显示它使用的项目目录。
3. 选择模型并发送消息。同一面板内可以连续追问。CLI 发起权限请求时，面板展示操作和可选答复，并将你的选择交回 CLI。

**停止本轮**中止当前回复。**隐藏**保留正在进行的会话；**结束会话**关闭 CLI 子进程。刷新页面、切换项目会话或关闭面板所属页面也会结束该连接。聊天记录仅在当前面板展示。长时间没有客户端请求的子进程约 30 分钟后回收。

## 安装

需要 Node.js 24.9 或以上版本、DeepSeek Harness 0.2.2-rc.5 和支持 ACP 的 `agy`。在本仓库目录运行：

```sh
npm ci
npm pack
dsh plugin --profile desktop add --config.strict-dep-builds=false "$PWD/dsh-antigravity-0.2.0-beta.3.tgz"
```

重新打开 Harness 即可加载。使用 Web 配置时，将命令里的 `desktop` 改为 `web`。若桌面应用找不到 `agy`，可在插件配置的 `acpBinaryPath` 中设置 `command -v agy` 显示的绝对路径。

## 运行方式

插件在项目目录启动 `agy acp --sandbox`，继承 Harness 服务的操作系统用户和进程环境，使用 CLI 自己的配置目录。启动顺序是 ACP `initialize`、`session/new`；模型选择和消息都发回这个会话。若 CLI 要求登录，请在同一系统用户及配置环境中运行 `agy` 完成登录，再重新打开面板。CLI 可提供的模型、工具及服务权限取决于账号和运行环境。关于不同账号在第三方软件中的支持范围，见 [Google Antigravity FAQ](https://antigravity.google/docs/faq)。

`npm run check` 执行类型检查、打包和测试。项目使用 [MIT 许可](LICENSE)。
