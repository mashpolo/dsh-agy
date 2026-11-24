# dsh-antigravity

将 Antigravity 接入 DeepSeek Harness：Google 登录、动态模型目录、流式文本与思考、工具调用，以及额度查询、搜索、网页读取和图片生成。

基于 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) 的协议实现，复用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的消息转换器。

## 版本

- Node.js ≥ 24.9.0。
- 本包针对 DeepSeek Harness **0.2.2-rc.5** 构建和验证。
- `0.2.1-rc.2` 缺少本插件使用的工具接口，不能直接加载；可以按下文命令运行指定版本的 Web 版，或先升级 Desktop。
- 固定复用 `pi-antigravity@0.15.0`、`@earendil-works/pi-ai@1.5.0`。
- 需要可以使用 Antigravity 服务的 Google 账号。实际模型、额度及图片模型可用性由账号决定。

## 安装与登录

以下以 Web 版为例。先解压源码包，在 `dsh-antigravity` 目录执行：

```sh
npm ci
npm run check
npm run login
```

终端会显示 Google 登录地址。打开地址完成登录，本机回调会自动完成认证；远程机器上可以把最终回调网址粘贴回终端。粘贴输入隐藏，按 Ctrl+C 可取消。

在项目目录运行 `npm pack` 生成安装包，再把下面命令中的路径替换为安装包的绝对路径。

```sh
npx --yes @deepseek-ai/dsh@0.2.2-rc.5 plugin --profile web add /absolute/path/dsh-antigravity-0.1.0.tgz
npx --yes @deepseek-ai/dsh@0.2.2-rc.5 web --no-open
```

已有 `dsh` 命令时，可直接用 `dsh plugin --profile web add ...`。安装包带有原生 bundle 清单，会注册插件，不需要手改 Harness 的源码。

只使用安装包也可以登录：

```sh
npm exec --yes --package=/absolute/path/dsh-antigravity-0.1.0.tgz -- dsh-antigravity-login
```

**登录和启动 Harness 必须使用相同的 `DSH_HOME`。** 未设置时，官方凭据服务使用 `~/.dsh`；凭据由官方 `LocalCredentialProvider` 写入 `.credentials.yaml`。登录命令不会打印访问令牌或刷新令牌。

完成登录后，重启 Harness，在会话的模型选择器中选择 `Antigravity` 下的模型。模型名称来自当前账号的服务端目录，不保证每个账号都能选到相同模型。

当前版本的 Harness 不会自动为此插件创建 Google 登录按钮，因此使用上述登录命令。Desktop 用户应使用桌面应用附带的 `dsh` 管理 `desktop` profile，并确保登录命令的 `DSH_HOME` 与桌面应用一致；普通 npm 版 CLI 仅按上面的 `web` profile 安装。

## 查看额度

点击会话标题栏的 **Antigravity** 即可展开额度面板。面板按账号显示邮箱、套餐、各额度窗口的进度条和重置倒计时，下方显示 AI credits 余额。将鼠标停在倒计时上可以查看具体重置时间。每次打开面板都会查询当前数据。

也可以在会话输入框中运行 `/antigravity-usage` 查看文字结果。两种入口都使用当前登录的 Google 账号，无需选择模型，也不消耗对话 token。

结果按额度组显示剩余百分比和重置日期、时间（含本机时区偏移）。如果服务端未提供分组，会查询各模型的额度；多个模型可能共用一个额度池。AI credits 余额按服务端返回的积分类型分别列出。数值为零时显示零，字段缺失时显示“未返回”，请求失败时会单独标明。再次运行命令即可刷新。

## 三个工具

工具注册后，模型可以按任务自行调用，无需输入专用命令。

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `antigravity_search` | `query`；可选 `instruction`、`urls`、`thinking` | 带来源引用的搜索结果 |
| `antigravity_read_url` | `url` | Markdown 正文；长页面完整内容保存到会话目录的 `.dsh/antigravity/pages/` |
| `antigravity_generate_image` | `prompt`；可选 `aspectRatio`、`model`、`referenceImages` | Harness 持久图片附件，可在界面中查看 |

例如：

```text
搜索 TypeScript 最新发布说明，给出官方来源。
读取 https://example.com 的正文。
画一张 16:9 的森林插画。
使用项目中的 references/style.png 作为参考图生成一张海报。
```

参考图使用会话目录内的相对路径，支持 PNG、JPEG、WebP、GIF，最多四张，每张不超过 10 MB。图片由 Harness 的附件服务保存；本版本没有自定义图片输出路径参数。

网页读取通过 Google 的爬虫服务完成，支持公开 HTTP(S) 页面。需要登录或执行 JavaScript 的页面无法通过该工具读取。

## 结构与调用链

```text
src/
  index.ts       注册模型、登录流程、命令与工具
  auth.ts        Google OAuth、原生凭据读写、自动刷新、登录 CLI
  provider.ts    模型目录、Harness ↔ Pi 消息转换、流式事件
  usage.ts       账户额度、重置时间和 AI credits 余额查询
  client.jsx     将额度面板挂载到会话标题栏
  QuotaPopover.jsx、quota.css   额度面板的交互与样式
  usage-route.ts   客户端与宿主共用的额度查询路径
  tools.ts       搜索、网页读取、图片生成
test/            认证、对话、工具和打包后的行为测试
build.mjs        编译并隔离上游中的 Pi 专用状态
cordis.patch.yml Harness 原生安装清单
```

调用链为 `Harness → provider.ts → pi-antigravity 协议实现 → Google`。回复通过 Harness 官方转换器返回文本、思考、工具调用与签名回放信息；工具执行由 Harness 管理。

源码直接引用固定版本的上游实现。构建时将需要的 TypeScript 模块打包成 JavaScript，因此运行时无需 Pi CLI、TypeScript 加载器或克隆原项目。

## 配置与维护

插件配置只有 `maxPageChars`，默认 `60000`，控制单次网页工具输出的字符预算；完整正文仍会保存。可以在插件配置中调整，范围为 1000–200000 的整数。

保留上游的服务端路由、取消、重试和模型发现逻辑。模型目录在内存中缓存四小时；凭据变化会触发重新检查，发现失败时同一账号保留上次成功目录。首次发现失败时使用上游默认目录，因此暂列出的模型仍可能被服务端拒绝。

为让插件使用独立、明确的宿主状态，构建时做了几处集中处理：

- 使用 Harness 官方凭据库，当前只使用其中一个 Antigravity 登录账号。
- 移除上游读取 Pi 账号并自动切换的路径。
- 关闭自动消耗 AI credits 的功能。
- 不读取 Pi 或 Antigravity CLI 的设置文件；显式 `ANTIGRAVITY_*` 环境变量仍可用于上游支持的端点、模型与超时配置。
- 禁用上游的请求内容调试落盘；Google API 请求保留所需客户端版本，并附加 Harness 的应用标识。

这些处理都集中在 `build.mjs`，对预期源码进行精确匹配。升级上游版本时，构建会在匹配失效时停止，便于检查接口变化。环境变量不是通用配置承诺：`ANTIGRAVITY_USE_CREDITS` 与 `ANTIGRAVITY_DEBUG_DUMP` 在本插件中始终不启用。

更新或重新登录后，运行 `npm run login`，再重新打开模型列表。若账号信息已失效，重新登录即可。保持 `DSH_HOME` 一致是排查“未登录”的第一步。

## 开发与验证

```sh
npm ci
npm run check
npm pack
```

检查包括严格 TypeScript 类型检查、构建、OAuth/凭据刷新行为、工具输入和结果、思考签名与工具调用的多轮回放，以及打包后实际 HTTP 请求和 SSE 响应的模拟测试。

测试使用模拟 Google 响应，不消耗真实账号额度。真实 Google 授权、账号模型权限及线上生成需要在用户登录后验证。改动和验证记录见 [WORK_LOG.md](WORK_LOG.md)。

## 许可

MIT；复用代码的版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
