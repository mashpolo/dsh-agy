# dsh-agy

dsh-agy 在 DeepSeek Harness 的会话标题栏提供独立的 Antigravity CLI 会话和订阅额度面板。本版本同时保留原模型适配器。

## 使用独立 ACP 会话

进入本机项目会话，点击标题栏的 **ACP**。面板显示当前工作目录及 CLI 提供的模型。发送第一条消息后，可以持续在同一面板追问、查看流式回复和思考内容。遇到工具审批时，核对操作内容并选择允许或拒绝；**停止**中止当前回合。**隐藏**保留会话，**结束会话**关闭子进程。切换宿主会话或刷新页面也会关闭该面板的会话。长时间无客户端请求的子进程会在约 30 分钟后回收。面板的聊天记录保存在页面内存中。

此入口使用本机 `agy acp` 和 Google AI Studio 的 Gemini API key。将 `GEMINI_API_KEY` 设置在**启动 Harness 服务的进程环境**中，然后启动 Harness。在已打开的桌面应用之外另开终端设置变量，只会影响那个终端及其子进程。可用 `command -v agy` 查到 CLI 位置。若桌面服务的 PATH 找不到它，在插件配置项 `acpBinaryPath` 填入可执行文件的绝对路径。

每个面板使用独立的临时 CLI 配置，关闭后回收。模型、工具及用量按该 API key 和 CLI 实际提供的能力为准。搜索、读网页和生成图片这三个原 Harness 工具属于下面的模型适配器；首版 ACP 面板尚未将它们通过 MCP 提供给 CLI。订阅额度按钮与 API key 的用量分别来自不同账户配置。Google 对第三方编码工具的账号接入说明见 [Antigravity FAQ](https://antigravity.google/docs/faq)。

## 查看剩余额度

在会话标题栏点击 **Antigravity ▾**。面板顶部显示当前账号和套餐，每行依次显示模型组、剩余额度进度条、百分比和距离重置的时间。将鼠标停在倒计时上可以查看具体的重置日期和时间。

![DeepSeek Harness 标题栏展开的 Antigravity 额度面板，显示 Gemini 和 Claude/GPT 的 5 小时与每周额度](docs/images/quota-panel.png)

打开面板时会查询一次，也可以点击右上角的刷新按钮。下方的 **AI credits 余额** 取自账号服务。服务端明确返回 0 时显示 0，缺少余额字段时显示“未返回”。

在会话中输入 `/antigravity-usage` 可以查看同一份数据的文字版。部分账号只能取得各模型的额度，插件会在共享额度不可用时尝试按模型显示。多个模型可能共用一个额度池。

## 安装 0.2.0-beta.2

需要 Node.js 24.9.0 或更高版本、DeepSeek Harness 0.2.2-rc.5。ACP 面板还需要支持 ACP 的本机 Antigravity CLI 和 Gemini API key。以下命令均在本仓库根目录运行。仓库名是 `dsh-agy`，Harness 使用的插件包名是 `dsh-antigravity`。

先安装依赖并生成安装包。`npm pack` 会自动构建插件。

```sh
npm ci
npm pack
```

**桌面版**使用应用附带的 `dsh` 命令。正常退出 Harness 后，执行下面的命令安装插件。

```sh
dsh plugin --profile desktop add --config.strict-dep-builds=false "$PWD/dsh-antigravity-0.2.0-beta.2.tgz"
```

**Web 版**使用 `web` 配置安装。

```sh
npx --yes @deepseek-ai/dsh@0.2.2-rc.5 plugin --profile web add "$PWD/dsh-antigravity-0.2.0-beta.2.tgz"
```

### 原模型适配器的 OAuth 登录与模型选择

配置你有权使用的 Google 桌面应用 OAuth 客户端，再在源码目录运行登录命令。登录程序会给出 Google 授权网址。登录程序和启动 Harness 的进程都需要能读取同一份 OAuth 配置。

```sh
export ANTIGRAVITY_CLIENT_ID="你的桌面应用 OAuth 客户端 ID"
# 如果该客户端要求密钥，请通过本机环境变量设置 ANTIGRAVITY_CLIENT_SECRET。
npm run login
```

如果 Google 没有自动返回项目，请将环境变量 `ANTIGRAVITY_PROJECT_ID` 设为账号有权访问的实际项目。旧版登录凭据只能用原 OAuth 客户端刷新，换用自己的客户端时需要重新登录。

登录命令与 Harness 需要使用相同的 `DSH_HOME`，默认目录为 `~/.dsh`。如果只有安装包，可以在安装包所在目录运行 `npm exec --yes --package=./dsh-antigravity-0.2.0-beta.2.tgz -- dsh-antigravity-login`。

重新打开桌面应用，或用 `npx --yes @deepseek-ai/dsh@0.2.2-rc.5 web` 启动 Web 版。在会话的模型选择器中打开 **Antigravity**，选择当前账号可用的模型。

## 搜索、网页读取和图片生成

| 工具 | 在会话中可以这样使用 |
| --- | --- |
| `antigravity_search` | “搜索 TypeScript 的最新发布说明，并列出来源。” |
| `antigravity_read_url` | “读取这个公开网页，整理成 Markdown。” |
| `antigravity_generate_image` | “参考项目里的 `references/style.png`，生成一张 16:9 的森林插画。” |

网页正文超过 `maxPageChars`（默认 60,000 字符）时，工具返回节选，并提供会话目录中完整正文的保存路径。图片生成结果作为附件显示在会话里。参考图使用会话工作目录下的相对路径，最多 4 张，每张不超过 10 MB，支持 PNG、JPEG、WebP 和 GIF。

## 开发与许可

安装依赖后运行 `npm run check`，可完成 TypeScript 检查、构建和测试。插件代码位于 `src/`，测试位于 `test/`。

本项目使用 MIT 许可。外部依赖说明见 [第三方许可清单](THIRD_PARTY_NOTICES.md)。[项目许可](LICENSE) · [版本记录](CHANGELOG.md)
