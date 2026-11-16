# 项目推送规则

- 仓库公开性、服务端分支保护：未核实；不绕过服务器限制。
- 允许目标：origin，https://github.com/Dikui/dk-dsh-subscriptions.git，main。
- 提交约定：沿用 feat/fix/docs 等前缀。
- 测试数据：test/ 下使用合成数据，不默认豁免整个目录。
- 内部信息：未发现已配置的内部资料入口，不放行真实账户数据。
- 本文件随仓库维护，提交推送时一并入库。
- 本次经用户确认保留 docs/research/grok-browser-verification.md，作为 README 配套的授权域名安全边界说明；不默认放行其他调研产物。

## 版本文件

- 插件版本文件：根目录 `package.json` 的 `version`；默认升修订号，用户明确指定版本或要求不升时除外。

## 追加与调整

```safe-push-deny
```

## 限定豁免

仅适用于已人工核实的合成凭证与变量引用，不放行真实凭据。

```safe-push-allow
# 规则文件自身的 allow 行；只放行本文件内的 test 规则定义。
docs/agents/push-rules.md ^test/[a-z0-9-]+[.]test[.]js 
test/catalog-runtime.test.js (XAI_API_KEY = |apiKey: |access_token: |refresh_token: )['"]SYNTHETIC-[A-Z-]+['"]
test/catalog-runtime.test.js apiKey: options[.]apiKey, headers: options[.]headers
test/core.test.js auth: \{ apiKey: provider[.]auth[.]apiKey \}
test/grok-tools.test.js ^const token = 'SYNTHETIC-XAI-ACCESS';$
test/grok-tools.test.js 'https://user:password@x[.]com/'
test/speed.test.js apiKey: 'SYNTHETIC'
# 本次用户确认：仅放行远端目录测试的三处合成值或变量引用。
test/remote-models.test.js ^[[:space:]]*return \{ source: 'OAuth', auth: provider === 'kimi-coding' \? \{ headers: \{ Authorization: `Bearer \$\{credential\?[.]access\}` \} \} : \{ apiKey: credential\?[.]access \} \};$
test/catalog-runtime.test.js ^[[:space:]]*base_url: 'https://untrusted[.]invalid', api_key: 'REMOTE-PAID', headers: \{ authorization: 'Bearer REMOTE-PAID' \} \},$
test/catalog-runtime.test.js ^[[:space:]]*return \{ access_token: accessFor\(id, '-ROTATED'\), refresh_token: `SYNTHETIC-ROTATED-REFRESH-\$\{id\}`, expires_in: 3600 \};$
```
