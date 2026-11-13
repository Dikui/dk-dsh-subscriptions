# dk-subscriptions

一个独立的、非官方订阅连接插件。复用 DeepSeek Harness 自带的 `@deepseek-ai/dsh-llm-pi-ai` OAuth、消息转换和推理协议；OpenAI、Kimi、Grok 共用远端模型目录自动同步，不再使用 SDK 静态目录充当可选模型列表。不复制 OAuth 协议，不修改 DSH 核心，不替换已有订阅插件。

## 首版范围

| 厂商 | 接入范围 | 模型路由 |
| --- | --- | --- |
| OpenAI | ChatGPT / Codex OAuth，读取账号返回的模型列表 | `subscription-openai-codex` |
| Kimi | Kimi Code 订阅 OAuth，自动读取 Coding 模型目录及思考能力 | `subscription-kimi-coding` |
| Grok | 复用官方 SDK 的 xAI OAuth，自动同步 API 远端文本模型目录 | `subscription-xai` |

代码接入不代表账户权益已验证。OpenAI 列表只包含账号接口标为可显示、且未标为禁止 API 使用的模型；它不是剩余额度或每次推理成功的保证。Kimi / Grok 的目录成功也不代表逐模型权限已验证；Grok 的 `scope: vendor` 明确表示厂商目录，而不是订阅权益列表。本项目不承诺官方背书，不提供虚构的余额或配额数据。Kimi Datasource 与 Grok X Search 已完成独立工具适配，是否开放由插件配置决定；这不代表所有数据库、搜索或账号权益已验证。其他游戏、通用网页搜索等产品工具不在范围内。

Grok 复用已安装官方 SDK 的设备码登录、令牌刷新和 Responses 传输，不另写 OAuth 或安装 CLI。xAI 已公开支持 [OpenCode](https://x.ai/news/grok-opencode) 及 [Grok Build/ACP](https://docs.x.ai/build/cli/headless-scripting)，但这不等于 DSH 客户端的授权适用范围已获确认。**不回退 API key 只能限制客户端认证方式，不能保证服务端不使用预付 credits 或产生额外收费。** 使用前应核对账号计费限制；面板测试会再次提示，真实授权及计费仍需用户另行验证。

## 使用

1. 在 DSH 安装本目录作为本地 bundle（由 `plugin_manager install_bundle` 完成，勿直接改 profile）。
2. 打开 **设置 → dk-subscriptions → 模型接入**，选择 OpenAI、Kimi 或 Grok 登录。**数据工具**是独立子页，两类内容不会同时显示。Grok 需要当前官方 SDK 提供 xAI OAuth；旧 SDK 不支持时保持不可用。
3. 点击连接会先打开等待页，取得官方授权链接后跳转。若弹窗受限，可直接点击面板里的 **打开官方授权页面**，或 **复制授权链接** 到浏览器，再使用显示的授权码。由用户确认账户和授权；插件及代理工具不代填账号密码、不代点授权同意。
4. 三个厂商均在已登录启动、授权完成及读取模型列表时自动同步；60 秒内复用缓存，后续访问自动重查。也可点击 **刷新模型目录 · 不发送推理请求** 强制更新。新模型无需手工添加或等待 SDK 名单更新。另行点击模型测试并确认后才会发送很短的编码问题，**消耗额度；Grok 还可能额外收费**。
5. 主会话的模型选择器使用上表的独立路由。已有其他插件的路由保持不变。

兼容性仅声明 **DSH 0.2.1-rc.5、0.2.2-rc.1 和 0.2.2-rc.2**，官方 `@deepseek-ai/dsh-llm-pi-ai` 使用相同版本范围。0.1.8 修复旧版精确锁定导致 0.2.2-rc.1 安装或启动时被兼容性检查拒绝的问题；0.1.19 增加 0.2.2-rc.2 并通过真实适配器的离线回归，均不需要版本豁免。虽然 `PiAiAdapter` 是包导出，其构造 profile 的结构仍可能变化；其他版本需重新验证，不使用宽泛范围绕过版本限制。更新本地 bundle 后需完全退出并重启 DSH；若安装的是打包副本而非本目录链接，先通过插件管理器重新安装新版。

## 订阅额度

额度只显示在 DSH 左侧边栏底部（用户头像上方）的小仪表图标；悬停展开已连接账号的额度窗口、剩余比例、重置时间与更新时间。未知字段不代表零或无限额度；只列出有可用额度来源的账号，未连接或没有额度接口的订阅（如 Grok）不显示额度行。移开或按 Esc 收起，触屏和键盘可点击展开，每次展开拉取一次窄快照。支持但暂时失败的账号仍显示错误。OpenAI 读取 `GET /backend-api/wham/usage`，Kimi 读取 `GET /coding/v1/usages`，兼容当前 `usages` 比例及旧版 `usage` / `limits`。复用共享 OAuth、官方刷新锁和插件网络作用域；不发送推理，默认不读取 API key（OpenCode Go 额度是显式开启的例外，见下）。与模型目录一样，启动、登录完成及状态访问按需同步，成功或失败缓存 60 秒，不后台轮询；**刷新额度 · 不发送推理请求**或 `subscription_accounts { action: "quota", provider: "openai-codex" }` 可强制刷新。

接口错误不会隐藏授权或模型状态。当前仅展示 OpenAI 主／次窗口；存在额外独立限额时标为「部分额度信息不可用」。不展示 credits、钱包或货币余额，不把目录成功当作额度保证。Grok 没有已验证的官方 OAuth 订阅额度接口，因此不显示额度行；也不调用需要独立管理密钥的计费 API。数据是查询时快照，刷新不保证推理权益或订阅专属扣费。

### OpenCode Go（API key，默认关闭）

OpenCode Go 的用量来自官方客户端使用的 `GET https://opencode.ai/zen/go/v1/usage`：Console API key 直接作为 Bearer，不需要 workspace/org header，返回 `rolling`、`weekly`、`monthly` 三个百分比窗口。该端点来自官方客户端实现，不是公开文档承诺的稳定接口；变更时只影响额度显示，不影响推理。

默认关闭。在插件配置中设置 `opencodeGoQuota: true`，并用 `opencodeApiKeyRef` 指定凭证引用（默认 `OPENCODE_GO_API_KEY`）后，侧边栏仪表会把它作为一个额度来源列出；Models 页和订阅账号面板都不显示额度。设置页不增加第四张卡，`status()` 仍只返回三个 OAuth 路由。插件只解析该引用，用 key 的 SHA-256 做账号隔离，不记录或返回 key；查询不发送推理，不回退其他凭证。关闭时完全不读取 API key。修改配置后需完全退出并重启 DSH。手动编辑 profile 的 `cordis.patch.yml` 时，覆盖块的 `id` 必须是 `subscriptions-lite`（bundle 插入的 id），不是插件名 `dsh-subscriptions`；否则 DSH 会忽略该块。

来源：[OpenAI usage 请求](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)、[窗口结构](https://github.com/openai/codex/blob/main/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs)、[Kimi 当前结构](https://github.com/MoonshotAI/kimi-code/blob/eb2035f3cad57cc12d4d5082ec626f7f0ea5f651/packages/oauth/src/managed-usage.ts)、[Kimi 旧结构](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py)、[OpenCode Go 文档](https://opencode.ai/docs/go/)。验证只使用合成凭证和模拟网络；OpenCode 端点另用现有 key 做过一次只读 GET，未在已安装 GUI 中验证显示。

## Kimi 数据工具（显式启用）

打开 **设置 → dk-subscriptions → 数据工具**。页面只保留标题、状态和必要操作，费用提示收进默认关闭的 **费用说明**。未连接时点击 **前往连接** 返回模型接入页，不会自动开始授权；切换子页不打断授权，也不发送查询。

在聊天中可以这样提问：**用 Kimi 世界银行数据查询中国最近五个有数据年份的 GDP，列成表格并注明单位与来源。** 这不是“只读说明”的功能限制，也不要求当前模型是 Kimi；实际调用仍需确认可能产生的额度或余额消耗。

已独立注册 `kimi_get_data_source_desc` 与 `kimi_call_data_source_tool`，不经过模型推理流，也不要求主模型是 Kimi。实现见 [kimi-tools.js](<kimi-tools.js>)。

- 无配置时默认关闭，返回 `KIMI_DATASOURCE_DISABLED`，在读取凭证、访问附件或联网前停止。**本地 bundle 已按用户要求在 [cordis.patch.yml](<cordis.patch.yml>) 设置 `config.kimiDatasource: true`**；改为 `false` 可关闭，重新加载插件后生效。设置页状态接口与 `subscription_accounts` 共用 `vendorTools.kimiDatasource`，不会用启用或登录成功冒充数据权益已验证。
- 已接好现有共享 Kimi OAuth 与插件作用域代理。离线检查覆盖动态 API 参数、两种请求体、取消、错误脱敏及不重试；不读取 Kimi CLI 凭证，不安装或执行官方插件，不回退 API key，不冒充官方客户端。
- 解析器将完整 JSON 响应存为宿主附件，只内联最多 16,000 个字符的文本预览并标记截断；嵌入的文件保留在 JSON 中，不自动解码或按上游路径写文件。当前请求上限 64 KiB、响应上限 32 MiB、网络与授权阶段最长 30 秒，附件存储不支持时拒绝发起查询。首版排除需要单独 `MP_API_KEY` 的 `materials_project`。
- 第三方客户端细则、全部源权益与精确计费仍未知；启用不是厂商支持承诺。**包括说明查询在内，都可能扣套餐额度或 ExtraUsage 余额**，请明确授权后再调用。本项目始终使用真实名称与版本，不伪装成 Kimi Code。已取回 World Bank 的真实说明，修正 JSON 字符串解析后离线重放通过；实际取数、其他源与 GUI 端到端仍未验证。

## Grok X Search（显式启用）

独立工具 `grok_x_search` 可被任意主模型调用，复用共享 Grok OAuth、官方刷新锁和插件作用域代理；搜索仍需额外调用 Grok 推理，并非免费的原始搜索接口。实现见 [grok-tools.js](<grok-tools.js>)。

- 无配置时默认关闭，返回 `GROK_X_SEARCH_DISABLED`，不读取凭证、不访问附件、不联网。本地 bundle 已按本次实现请求在 [cordis.patch.yml](<cordis.patch.yml>) 设置 `config.grokXSearch: true`；设置页和 `subscription_accounts` 共用 `vendorTools.grokXSearch`。已通过本地链接安装的旧进程需完全退出并重启 DSH；刷新页面不会替换已加载的宿主模块。
- 参数为 `query`，可选 `model`（默认 `grok-4.7`）、互斥的 `allowed_x_handles` / `excluded_x_handles`（1–20 个、不含 @）、UTC 日期 `from_date`（含）/ `to_date`（不含），以及 `max_turns`（1–5，默认 2）。用户名与日期过滤不约束线程抓取。示例：**用 Grok X Search 搜索 @xai 关于 Grok 的公开帖子，最多一轮，附来源；我同意本次可能产生的推理及搜索费用。**
- 只向 `https://api.x.ai/v1/responses` 发送 `tools: [{type: 'x_search'}]` 与 `tool_choice: 'required'`；禁用图片/视频理解，`store: false`，不自动重试、不回退 API key。SDK 的 `auth.apiKey` 字段可承载 OAuth access token，接入时仍强制验证 `source: 'OAuth'`，不是 API-key 认证回退。
- 返回最多 16,000 字符正文、20 个去重来源 URL、服务端 token/抓取用量以及 `searched`、完成/截断状态。`searched: false` 代表未确认实际执行搜索；无结果不伪造来源。完整脱敏 JSON 作为附件保存，响应上限 8 MiB、授权及网络阶段最长 120 秒；附件服务不可用时拒绝发起收费请求。第三方帖子和模型摘要都是不可信数据，不是指令。
- **OAuth 不保证仅扣订阅额度。** 目前官方计价为每 1,000 条抓取帖子 $5、每 1,000 个用户资料 $10，另加模型 token 费用。`max_turns` 限制循环轮次，不限制并行调用、抓取数量或总费用；1,024 个可见输出 token 上限也不包含推理/工具 token。调用前需获得费用授权。依据：[X Search](https://docs.x.ai/developers/tools/x-search)、[用量与轮次](https://docs.x.ai/developers/tools/tool-usage-details)、[定价](https://docs.x.ai/developers/pricing)。
- 本次真实测试已确认当前账号 OAuth 可完成一次 X Search 调用，但返回 0 条帖子、无引用；不据此宣称帖子检索质量、其他模型或订阅专属计费已验证。

## 会话速度档位

模型选择器旁仅显示当前速度档位，不显示额外的「Speed」标题。选择按会话、提供商、模型和凭证作用域保存，并记住每个模型最近一次的档位，供新会话继承（切换到其他模型、凭证作用域不同时不继承，显式选择正常速度会覆盖记忆）。从下一模型步骤生效，重试保持该步骤的选择。用户选择档位后直接保存，不弹出二次确认；可能增加额度或费用的说明保留在档位提示中。不修改推理强度、不切换认证方式，不向工具的辅助模型请求继承速度选择。

- **Codex**：读取账号目录的 `service_tiers`，保留实际档位 ID、名称和说明；兼容旧 `additional_speed_tiers: ["fast"]` → `priority`。正常档位不发送 `service_tier`，不会自动应用目录中可能增加消耗的默认值。未知或下线档位不猜测替代。依据：[官方模型能力定义](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)、[速度说明](https://developers.openai.com/codex/speed/)。
- **Grok**：文本 Responses 模型提供正常／Priority，按[官方 Priority Processing 契约](https://docs.x.ai/developers/advanced-api-usage/priority-processing.md)发送 `service_tier: "priority"`，并按[官方接口定义](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions.md)兼容 `fast` 别名，不重复提供两个档位。该参数不保证进入 Grok Build 的独立 Fast 部署；实际是否获批由服务端决定。OAuth 套餐权益和仅扣订阅额度仍未验证，档位提示保留此说明，不自动付费重试或回退。
- **Kimi 等未声明速度能力的模型**：始终使用默认速度，不发送速度参数；已有保存值也不能启用不存在的档位。不根据模型 ID 推导速度，不提供模型切换。

所有模型共用一条能力解析路线：**模型声明 → 有明确提供商／接口／模型类型适用范围的接口能力 → 默认速度**。两种来源都经过同一套档位校验、去重和别名归一化；别名只在声明它的能力内有效，有冲突时拒绝匹配，不因接口协议名相同就推断支持。模型显式声明空列表或仅默认时，不再继承接口级的额外档位。选择、保存、历史值读取和请求快照共用规范档位 ID，`fast` 与 `priority` 不会因别名关系变成两个选项。解析本身不发起推理请求、不消耗推理 token。

界面只消费解析结果，不按厂商名称排除模型；始终保留当前速度显示，没有其他档位时显示默认速度、禁用切换，不再隐藏整个控件。

通用能力由 [speed.js](<speed.js>) 的模型／请求能力解析、会话选择和请求快照组成；[speed-host.js](<speed-host.js>) 使用宿主的独立 storageDomain sidecar 保存，不写入提示词或实验性会话事件。sidecar 不随会话导出或分叉自动复制；缺少会话选择时沿用该模型最近一次选择，所以新会话与分叉会话默认沿用，切换到其他模型回到正常速度，显式选择正常速度会写回记忆。更换凭证作用域不会继承高消耗选择。前端选择是所请求的档位，不代表服务端保证达到对应速度。

速度存储、请求快照引用和网络清理由 Cordis effect 生命周期管理，卸载时释放后才能重新加载，避免存储域仍被占用导致速度路由 404。插件加载会等待速度模块初始化，初始化错误不再被后台子模块静默吞掉。真实 Cordis／DomainFacility／Connection 的离线回归覆盖卸载后重新注册速度路由。

本地更新后需完全退出并重启 DSH；仅刷新网页不会加载新的后台逻辑，旧进程中已泄漏的存储域也需要重启释放。已完成离线请求捕获与事件测试，不代表厂商真实账号权益已验证。

## 通用模型自动同步

- [models.js](<models.js>) 统一处理描述校验、60 秒内存缓存、并发合并、超时、取消、账号隔离及失败状态。[model-sources.js](<model-sources.js>) 仅处理厂商端点、字段映射和目录范围；三个厂商使用同一生命周期。
- **OpenAI**：`GET https://chatgpt.com/backend-api/codex/models`，使用共享 OAuth、账号标识与已安装 SDK 版本，过滤不可显示/不支持 API 的模型。
- **Kimi**：`GET https://api.kimi.com/coding/v1/models`，遵循[官方 CLI 的模型发现接口](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/platforms.py)。名称、上下文、图像和思考档位读取远端声明，包括 K3.1 Pro 及高速版；只支持思考时不提供 off，默认档位同步到选择器和调用。只支持思考但没有声明任何可用档位的模型不声明思考控制（Harness 拒绝空档位列表，会连带隐藏整个厂商），按厂商默认行为思考。视频目前不声明为 Harness 输入能力。参见[模型说明](https://www.kimi.com/code/docs/kimi-code/models.html)。
- **Grok**：用现有共享 OAuth 读取 `https://api.x.ai/v1/models`，与 `/v1/language-models` 按精确 ID 合并，排除生成图片/视频和不支持客户端 function tools 的 multi-agent。参考[模型接口](https://docs.x.ai/developers/rest-api-reference/inference/models.md)及[multi-agent 限制](https://docs.x.ai/developers/model-capabilities/text/multi-agent.md)。当前账号的两次 GET 已返回 200，但这只是远端 API 目录，`scope: vendor` **不代表逐模型订阅权限或仅扣订阅费用已验证**；不冒充 Grok Build 客户端，不切换到 CLI proxy 推理路由。
- 设置页、各主会话独立路由、模型解析、prepared call 和测试共用远端名单。SDK 只提供传输契约及精确同 ID 的缺失元数据，不混入静态名称或自行扩展别名。未知模型缺少输出上限时采用本地 16,384 token 生成上限（不是服务端能力声明）；缺少上下文时保守采用 32,768。
- 启动预热（后台执行，不阻塞插件加载）和授权成功后自动同步，列表/状态/调用在缓存过期后重查，显式刷新跳过缓存；没有后台轮询计时器。共享同步任务覆盖官方 OAuth 解析和目录请求，合计限时 10 秒，失败同样缓存 60 秒；缓存命中只在本地核对凭证指纹。单个调用方取消不伤共享请求；退出、凭证变化或卸载使旧结果失效。prepared call 保留已校验的元数据。
- 三厂统一复用官方加锁 OAuth 刷新，不回退 API key；固定可信端点、禁重定向、响应上限 1 MiB / 1,000 模型，忽略远端任意 URL/头/凭证字段。失败清空选择列表并显示脱敏错误，**不回退静态名单**。未注册同步源明确不可用。
- 更新后需重新加载插件后台并刷新当前页面；若后台仍是旧版本，界面拒绝所有厂商的旧静态目录。仍有效的 OAuth 不必重新登录。真实验证只发送目录元数据，不执行会消耗推理额度的模型测试。

## 连接时没有授权页面

- **正在获取链接**：Kimi / Grok 先请求设备授权数据，成功后才产生链接和授权码。当前内置适配器的单次 HTTP 请求限时为 30 秒；这不等于整个登录的期限。界面会显示等待提示，超时或请求失败后可以重新连接。
- **浏览器拦截弹窗**：使用面板里一直保留的官方链接及复制按钮；剪贴板不可用时，链接和授权码仍能选中后手动复制。不会为此切换成 API-key 计费。
- **重新打开面板**：同一 DSH 进程里仍在运行的授权会继续显示链接、授权码和取消按钮，不再因丢失前端的发起标记而隐藏。整个 DSH 进程重启后需重新连接。
- **链接不是受信任域名**：面板会明确拒绝打开，而不是静默跳到其他网站；不会自动放宽域名限制。Kimi 的设备授权 API 在 `auth.kimi.com`，实际返回的浏览器验证页在 `www.kimi.com`，两个精确域名均受支持；不放行任意子域名、HTTP 或异常端口。
- **Grok 的域名边界**：只允许官方源码确认的账号/授权页面来源 `accounts.x.ai`；不因 OAuth API 在 `auth.x.ai` 就把它当作浏览器验证页，也不放行 `*.x.ai`。实际设备码响应的域名尚未观察，若返回其他域名则拒绝打开和复制，不自动扩大白名单。[域名证据与验证缺口](<docs/research/grok-browser-verification.md>)。
- 等待页如果被用户导航到别的网站，插件不再跳转或关闭该页。授权页打开后也不会被组件卸载自动关闭。

## 网页已登录，但 DSH 仍显示授权失败

浏览器登录之后，**DSH 后台**还要向 OpenAI 交换令牌。浏览器能访问不代表后台使用相同网络。

- **自动代理（macOS）**：插件加载时读取系统已启用的手动 HTTPS 代理，自动获取地址和端口，不启动代理服务、不写入代理配置或进程环境。安装带异步作用域的连接 dispatcher：仅本插件的 OpenAI/Kimi/Grok 授权、令牌刷新、已注册的账号模型查询及模型请求走系统代理，其余请求委托安装前的 dispatcher。不会替换全局 `fetch`，避免 billion-context 等插件的 fetch 链重定向跳过代理；卸载时仅在仍拥有 dispatcher 时恢复。Codex 在自动代理启用时使用官方 SSE 传输，避免 WebSocket 绕过代理。
- **显式设置优先**：存在任一非空的 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`（含小写形式）时，完全沿用 DSH 既有路由，不自动回退系统代理。自动模式也遵循 `no_proxy` / `NO_PROXY`、系统的域名排除列表和简单主机名排除设置；回环请求直连。不重试直连来掩盖代理失败。
- **范围限制**：只自动识别手动 HTTPS 代理，不解析 PAC、自动发现或 SOCKS，也不扩展系统排除列表中的 CIDR 规则。需要这些规则时请显式配置受 DSH 支持的代理及排除项。其他系统不进行自动发现。
- **生效时间**：完全退出并重启 DSH 后加载；之后修改系统代理地址或端口，也需要重启以重新读取。再发起一次新授权，不重复提交已失败的授权码。
- 若需要手动覆盖，DSH 0.2.1-rc.5 从用户级 `~/.dsh/.env`（或自定义 `DSH_HOME`）读取代理。**不要写进项目 `.env`**。这类显式环境设置影响整个 DSH，继承自启动进程的同名变量优先；与本插件的局部自动模式不同。
- 若提示 **国家或地区被拒绝（HTTP 403）**，检查实际后台网络是否在 OpenAI 支持的地区。这不是模型额度不足的提示。若提示回调不匹配、账号 ID 解析失败或凭证未保存，应检查回调、官方适配器版本或凭证服务；修改代理不能修复所有授权错误。面板仅显示脱敏类别，不输出原始令牌响应。
- `subscription_accounts` 的 `status` 还返回模型列表来源/查询状态、代理模式、未启用原因、经过自动 dispatcher 的请求数和最近 HTTP 状态码。状态查询可能同步三个厂商的远端模型元数据，并通过官方机制刷新到期凭证，但不发送推理请求。不会记录 URL、请求头、授权码或令牌。自动代理复用 Undici 自带的兼容包装器，兼容桌面 Node 24 的原生 `fetch`。

## 安全边界

- 只接受官方 `llm-pi-ai/<provider>` 下 `kind: grant`、`type: oauth` 的凭证；UI 和工具不返回 access/refresh token。
- 新路由移除了 API-key 认证 handler，并禁用环境/本地文件凭证发现。没有 OAuth 就失败，**不会退到 API key 或其他厂商**。该保证覆盖本插件的三个 OAuth 路由；OpenCode Go 是独立的 quota-only 读取，不能用于推理、登录或模型目录，也不改变其他已安装插件。
- 复用官方凭证及刷新锁。退出在同一写锁中清除共享 OAuth 的密钥，留下不含密钥的 `subscription-revoked` 标记，**也会使官方 pi-ai 对应路由退出**。该版本存储接口没有条件删除能力，保留标记可避免误删并发写入的 API key，并阻止原路由发现环境密钥。重新登录会替换标记。退出不会取消订阅，不代表远程令牌撤销，也不保证终止已发送请求或另一入口后来发起的登录。
- 登录和回答授权提示仅在设置界面提供。`subscription_accounts` 工具提供状态、账号模型刷新、短测试、退出；不会返回授权验证码、链接、账号标识或令牌。
- HTTP 接口由 DSH Connection 认证保护；POST 额外校验同源、JSON 和专用请求头。授权尝试有 15 分钟期限，界面退出时尽力取消自己发起的尝试。
- 当前官方授权服务收到取消时会先停止等待，但已排队的凭证保存仍可能完成。**取消不等于撤销授权**；若取消后出现凭证，请使用移除凭证操作。这是已确认的上游限制，未改动官方包。
- 只显示脱敏错误码，不透传可能含 token 的上游异常文本。
- 不自动迁移、导出或读取其他插件的凭证，不安装厂商 CLI，不修改现有 API 配置。

## 界面位置

订阅账号（Model connections）和 Data tools 通过官方 `settings.models.footer` 插槽挂在 **Settings → Models** 页面底部，不再单独占用左侧 Subscriptions 设置页；两个 tab 仍可切换。订阅账号卡片只保留连接、模型和测试操作；所有额度（含 OpenCode Go）统一在左下角仪表显示。

## 名称变更

界面显示名称为 `Subscriptions`，包名保持 `dk-subscriptions`，GitHub 仓库为 [Dikui/dk-subscriptions](https://github.com/Dikui/dk-subscriptions)。改名不迁移或删除 OAuth 凭证，不改变现有模型路由；内部插件 id、HTTP 路径和请求头保留兼容名称，以免影响已有调用。

## 开发与验证

```sh
npm test
npm run check
npm pack --dry-run
```

零新增运行时依赖。使用当前官方适配器安装位置解析其配套 pi-ai，不引入第二套 SDK。测试覆盖 OAuth 类型边界、无 API fallback、刷新与注销、提示身份/取消、脱敏、路由选择和 HTTP 同源要求，以及连接点击、异步授权链接、弹窗/剪贴板备用入口、恢复授权和窗口清理。面板事件测试使用确定性的 hook 测试夹具与合成授权数据，不是真实 React/浏览器测试，不验证浏览器弹窗策略或厂商接口连通性。

[兼容性回归](<test/compatibility-runtime.test.js>) 使用所选 DSH 安装中的真实 `evaluatePluginCompatibility` 检查安装/启动门禁：已声明版本无需豁免即可通过，未验证版本仍被拒绝，同时检查 `engines.dsh` 与适配器 peer 声明。以下命令在 macOS 桌面版 0.2.2-rc.2 下执行全部离线测试（MockAgent 禁止真实厂商请求，不修改 profile 或账号凭证）：

```sh
ELECTRON_RUN_AS_NODE=1 \
  DSH_TEST_UNDICI='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/undici' \
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/*.test.js
```

原生 `fetch` 的 dispatcher 协议随 Node 版本变化；代理回归检查应使用 **DSH 实际启动的 Node 运行时**，而不只使用终端的 `node`。将 `DSH_TEST_UNDICI` 指向 DSH 配套的 Undici 目录后，运行 `--test test/network-runtime.test.js`。该检查使用 MockAgent，禁用真实网络，覆盖桌面 Node 24 协议兼容和全局 fetch 防递归补丁跳回原始 fetch 的场景；依赖不可用时默认跳过，不把跳过算作通过。

同样设置 `DSH_TEST_UNDICI` 后运行 `--test test/catalog-runtime.test.js`，可检查真实官方适配器的账号模型列表、主路由解析和 prepared-call 元数据冻结；这部分元数据检查的推理传输用立即停止的替身。Grok 部分则通过 MockAgent 验证原生 OAuth 刷新、Responses SSE 和短测试：缺失 OAuth 或存有 API key 时，即使存在环境/调用方密钥也不发送请求；401/403/429 只返回脱敏失败，不重试或付费回退。检查通过公开插件入口注册适配器，凭证仅存在于内存，所有 HTTP 均被模拟且禁止外连，不查询真实账户、不消耗推理额度。

单元测试使用内存凭证，不能替代真实厂商授权验证。安装后需要在实际 DSH 设置页确认显示、完成用户授权、测试一个模型，然后按需退出验证。未授权时不应报告“订阅已验证”。
