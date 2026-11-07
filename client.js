window.__ModuleLoader__.load({
  id: 'dk-subscriptions',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const namespace = 'dk-subscriptions';
    const messages = {
      en: {
        title: 'dk-subscriptions', navigation: 'Subscription pages', modelsPage: 'Model connections', toolsPage: 'Data tools',
        close: 'Close', loading: 'Loading subscriptions…', retry: 'Retry', connect: 'Connect', reconnect: 'Reconnect', cancel: 'Cancel authorization', logout: 'Remove credential',
        saved: 'Credential saved · entitlement not verified', missing: 'No subscription credential saved', apiKey: 'An API key exists; it is not a subscription credential.', unavailable: 'Unavailable',
        running: 'Waiting for authorization', authorized: 'Authorization finished', cancelled: 'Stopped waiting. A pending credential save may still finish; remove it if it appears.', failed: 'Authorization failed',
        toolsTitle: 'Kimi data tools',
        toolsEnabled: 'Enabled', toolsDisabled: 'Disabled', toolsUnknown: 'Status unknown',
        toolsSharedCredential: 'Connected', toolsNeedsCredential: 'Not connected', toolsConnect: 'Go to connections',
        billing: 'Billing', toolsCost: 'Requests may use Kimi quota or ExtraUsage balance.',
        xai: 'Uses the official SDK’s Grok OAuth flow; DSH authorization scope is not independently confirmed. Check billing limits before use: subscription-only billing is not guaranteed and extra charges may apply.',
        grokNews: 'Grok and OpenCode', grokDocs: 'Official headless scripting docs',
        model: 'Local model catalog', noModels: 'No local models available',
        accountModels: 'Account model list', accountNoModels: 'No selectable account models loaded',
        refreshModels: 'Refresh account models · no inference quota', refreshingModels: 'Refreshing account models…',
        catalogError: 'Could not fetch the account model list. Check the backend network, then refresh. No static model names were substituted.',
        catalogDenied: 'The account model endpoint rejected this credential or connection (HTTP 401/403). Check authorization and the backend network, then refresh.',
        catalogInvalid: 'The account model endpoint returned an unsupported response. No static model names were substituted.',
        catalogRateLimit: 'Account model discovery was rate limited. Wait before refreshing; no inference request was sent.',
        catalogChanged: 'The credential changed during discovery. Refresh the account model list.',
        catalogUnavailable: 'This provider has no registered account model source. A local SDK catalog is not proof of account availability.',
        test: 'Test selected model · uses quota', testing: 'Testing…', testResult: 'Test response',
        testConfirm: 'Send one real request with the selected model? This consumes subscription quota.',
        logoutConfirm: 'Clear the shared OAuth secrets, leaving a secret-free signed-out marker? Other DSH features using this same credential will also lose access.',
        authorize: 'Open official authorization', code: 'Authorization code', submit: 'Submit answer', choose: 'Choose an option',
        preparing: 'Preparing the authorization link. Keep this panel open. If no link appears after about 30 seconds, cancel, check your network, and retry.',
        preparingTab: 'Preparing authorization. Return to dk-subscriptions for progress or to cancel.',
        opened: 'The authorization page was opened in a new tab. You can also use the link below.',
        popupBlocked: 'Popup blocked or closed. Open the official link below, or copy it into your browser.',
        authorizationLink: 'Official authorization link', copyLink: 'Copy authorization link', copyCode: 'Copy code',
        copied: 'Copied', copyHelp: 'Clipboard access failed. Select and copy the text above manually.',
        resumed: 'This authorization is already running. Continue with the link and code below, or cancel to start again.',
        noAuthLink: 'No authorization link was received. Resolve the error above, then reconnect. No API-key fallback was used.',
        authHelp: 'Sign in on the official provider site yourself. Never enter your account password here; submit only the requested authorization response.',
        foreign: 'Authorization is running in another panel. Finish or cancel it there.', unsafeLink: 'This authorization link is not on a verified HTTPS host and cannot be opened here.',
        requestError: 'The request did not complete. Check authorization and retry.', badResponse: 'The server returned an unexpected response.',
        unavailableError: 'This provider does not support subscription authorization in this DSH installation.',
        inFlightError: 'An authorization or test is already running. Wait for it to finish.', staleError: 'This authorization step expired. Refresh and connect again.',
        missingError: 'Connect a subscription credential first.', modelError: 'This model is not in the current model list. Refresh and select another.',
        credentialError: 'The shared record is not a subscription credential; it was not deleted.', answerError: 'Enter a valid answer for the current authorization prompt.',
        testError: 'The model test failed. A saved credential does not guarantee access to this model.',
        regionError: 'OpenAI rejected the country or region of the DSH backend connection (HTTP 403). Check DSH’s HTTPS_PROXY setting and supported-region access; browser access alone does not verify the backend network. On macOS this plugin reads the system HTTPS proxy when loaded; explicit proxy variables win. Restart DSH after changing those settings.',
        exchangeError: 'The authorization code could not be exchanged for a token. Start a new authorization; if it fails again, check the DSH backend network and proxy settings.',
        callbackError: 'The callback does not match this authorization or has no code. Start a new authorization and use its latest callback.',
        accountError: 'The official adapter could not read the account ID from the returned token. Check the installed adapter version before retrying.',
        networkError: 'The DSH backend could not reach the provider. Check its network and proxy settings; the browser may use a different connection.',
        saveError: 'The authorization flow finished without saving a usable credential. Reconnect; if it repeats, check the official adapter and credential service.',
      },
      zh: {
        title: 'dk-subscriptions', navigation: '订阅管理子页', modelsPage: '模型接入', toolsPage: '数据工具',
        close: '关闭', loading: '正在加载订阅…', retry: '重试', connect: '连接', reconnect: '重新连接', cancel: '取消授权', logout: '移除凭证',
        saved: '凭证已保存 · 订阅权益未验证', missing: '尚未保存订阅凭证', apiKey: '存在 API 密钥，但它不是订阅凭证。', unavailable: '暂不可用',
        running: '等待授权', authorized: '授权已完成', cancelled: '已停止等待。进行中的凭证保存可能仍会完成；如出现凭证，请移除。', failed: '授权失败',
        toolsTitle: 'Kimi 数据工具',
        toolsEnabled: '已启用', toolsDisabled: '已关闭', toolsUnknown: '状态未知',
        toolsSharedCredential: '已连接', toolsNeedsCredential: '未连接', toolsConnect: '前往连接',
        billing: '费用说明', toolsCost: '查询可能消耗 Kimi 额度或 ExtraUsage 余额。',
        xai: '复用官方 SDK 的 Grok OAuth 流程，DSH 客户端的授权适用范围尚未独立确认。使用前请核对账号计费限制：无法保证仅消耗订阅额度，可能产生额外收费。',
        grokNews: 'Grok 与 OpenCode', grokDocs: '官方无头脚本文档',
        model: '本地模型目录', noModels: '暂无本地模型',
        accountModels: '账号模型列表', accountNoModels: '尚未加载可选择的账号模型',
        refreshModels: '刷新账号模型 · 不消耗推理额度', refreshingModels: '正在刷新账号模型…',
        catalogError: '未能获取账号模型列表。请检查后台网络后刷新；没有使用静态模型名称代替。',
        catalogDenied: '账号模型接口拒绝了此凭证或连接（HTTP 401/403）。请检查授权和后台网络后刷新。',
        catalogInvalid: '账号模型接口返回了无法支持的数据，没有使用静态模型名称代替。',
        catalogRateLimit: '账号模型查询被限流，请稍后刷新；未发送推理请求。',
        catalogChanged: '查询期间凭证发生变化，请刷新账号模型列表。',
        catalogUnavailable: '此厂商尚未接入账号模型查询；本地 SDK 目录不代表账号可用模型。',
        test: '测试所选模型 · 消耗额度', testing: '正在测试…', testResult: '测试回复',
        testConfirm: '使用所选模型发送一次真实请求？这会消耗订阅额度。',
        logoutConfirm: '清除与官方提供商共用的 OAuth 密钥，仅保留不含密钥的退出标记？其他使用同一凭证的 DSH 功能也将失去访问权限。',
        authorize: '打开官方授权页面', code: '授权码', submit: '提交回答', choose: '请选择',
        preparing: '正在获取授权链接，请保持此面板打开。如果约 30 秒后仍未出现链接，请取消、检查网络后重试。',
        preparingTab: '正在准备授权，请返回「dk-subscriptions」查看进度或取消。',
        opened: '已在新标签页打开授权页面，也可以使用下方链接。',
        popupBlocked: '弹窗被拦截或已关闭，请点击下方官方链接，或复制到浏览器打开。',
        authorizationLink: '官方授权链接', copyLink: '复制授权链接', copyCode: '复制授权码',
        copied: '已复制', copyHelp: '无法写入剪贴板，请选中上方文本手动复制。',
        resumed: '此授权正在进行，可以使用下方链接和授权码继续，也可以取消后重新连接。',
        noAuthLink: '尚未取得授权链接。请根据上方错误处理后重新连接；没有改用 API 密钥。',
        authHelp: '请自行在提供商的官方网站登录。不要在此输入账号密码，仅提交授权流程要求的回答。',
        foreign: '其他面板正在进行授权，请在原面板完成或取消。', unsafeLink: '此授权链接不属于已验证的 HTTPS 域名，无法在此打开。',
        requestError: '请求未完成，请检查授权后重试。', badResponse: '服务器返回了无法识别的数据。',
        unavailableError: '当前 DSH 安装中的此提供商不支持订阅授权。',
        inFlightError: '已有授权或测试正在进行，请等待完成。', staleError: '此授权步骤已过期，请刷新后重新连接。',
        missingError: '请先连接订阅凭证。', modelError: '此模型不在当前模型列表中，请刷新后重新选择。',
        credentialError: '共用记录不是订阅凭证，未执行删除。', answerError: '请为当前授权问题填写有效回答。',
        testError: '模型测试失败。已保存凭证不代表有权访问此模型。',
        regionError: 'OpenAI 拒绝了 DSH 后台连接所在的国家或地区（HTTP 403）。请检查 DSH 的 HTTPS_PROXY 配置及支持地区；浏览器能访问不代表后台网络正常。本插件在 macOS 上加载时会读取系统 HTTPS 代理，显式代理环境变量优先；修改设置后请重启 DSH。',
        exchangeError: '授权码换取令牌失败。请重新发起授权；如果再次失败，请检查 DSH 后台的网络和代理配置。',
        callbackError: '回调与本次授权不匹配，或缺少授权码。请重新发起授权，并使用本次最新的回调。',
        accountError: '官方适配器无法从返回的令牌中读取账号 ID。请检查已安装的适配器版本后再重试。',
        networkError: 'DSH 后台无法连接提供商。请检查后台的网络和代理配置；浏览器可能使用了不同的连接。',
        saveError: '授权流程结束，但未保存有效凭证。请重新连接；若再次出现，请检查官方适配器和凭证服务。',
      },
    };
    const errorKeys = {
      BAD_RESPONSE: 'badResponse', UNAVAILABLE: 'unavailableError', ALREADY_IN_FLIGHT: 'inFlightError', TEST_IN_PROGRESS: 'inFlightError',
      STALE_ATTEMPT: 'staleError', STALE_PROMPT: 'staleError', MISSING_CREDENTIAL: 'missingError', UNKNOWN_MODEL: 'modelError',
      NOT_SUBSCRIPTION_CREDENTIAL: 'credentialError', INVALID_ANSWER: 'answerError', TEST_FAILED: 'testError',
      NO_FLOW: 'unavailableError', UNKNOWN_METHOD: 'unavailableError', NOT_COMMITTED: 'saveError',
      OAUTH_REGION_UNSUPPORTED: 'regionError', OAUTH_EXCHANGE_FAILED: 'exchangeError',
      OAUTH_CALLBACK_MISMATCH: 'callbackError', OAUTH_ACCOUNT_INVALID: 'accountError', NETWORK_FAILED: 'networkError',
      MODEL_CATALOG_FAILED: 'catalogError', MODEL_CATALOG_DENIED: 'catalogDenied', MODEL_CATALOG_INVALID: 'catalogInvalid',
      MODEL_CATALOG_RATE_LIMIT: 'catalogRateLimit', MODEL_CATALOG_CHANGED: 'catalogChanged', MODEL_CATALOG_UNAVAILABLE: 'catalogUnavailable',
    };
    // Kimi's device-code API and browser verification page use different hosts.
    // xAI's official CLI pins accounts.x.ai as its accounts/consent origin; unknown device hosts fail closed.
    const authHosts = { 'openai-codex': ['auth.openai.com'], 'kimi-coding': ['auth.kimi.com', 'www.kimi.com'], xai: ['accounts.x.ai'] };
    function trustedLink(value, provider) {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && authHosts[provider]?.includes(url.hostname) && !url.port && !url.username && !url.password ? url.href : null;
      } catch { return null; }
    }
    function validAttempt(attempt) {
      return attempt && typeof attempt.id === 'string' && ['running', 'authorized', 'cancelled', 'failed'].includes(attempt.state)
        && Array.isArray(attempt.notices) && attempt.notices.every(n => n && typeof n.message === 'string'
          && (n.url == null || typeof n.url === 'string') && (n.code == null || typeof n.code === 'string'))
        && (attempt.error == null || typeof attempt.error === 'string')
        && (attempt.prompt === null || (attempt.prompt && typeof attempt.prompt.id === 'string' && typeof attempt.prompt.message === 'string'
          && ['text', 'secret', 'select'].includes(attempt.prompt.kind)
          && (attempt.prompt.placeholder == null || typeof attempt.prompt.placeholder === 'string')
          && (attempt.prompt.kind !== 'select' || (Array.isArray(attempt.prompt.options)
            && attempt.prompt.options.every(o => o && typeof o.id === 'string' && typeof o.label === 'string')))));
    }
    function validStatus(data) {
      return data && (data.vendorTools === undefined || typeof data.vendorTools?.kimiDatasource?.enabled === 'boolean')
        && Array.isArray(data.providers) && data.providers.length === 3 && new Set(data.providers.map(p => p?.id)).size === 3
        && data.providers.every(p => p && Object.hasOwn(authHosts, p.id) && typeof p.name === 'string'
          && (p.route === null || typeof p.route === 'string') && typeof p.available === 'boolean' && typeof p.configured === 'boolean'
          && [null, 'grant', 'api-key'].includes(p.credentialKind) && Array.isArray(p.models)
          && p.models.every(m => m && typeof m.id === 'string' && typeof m.name === 'string')
          && p.modelCatalog && ['account', 'local', 'none'].includes(p.modelCatalog.source)
          && ['unloaded', 'loading', 'ready', 'error', 'unavailable'].includes(p.modelCatalog.state)
          && (p.modelCatalog.error === null || typeof p.modelCatalog.error === 'string')
          && (p.modelCatalog.updatedAt === null || (Number.isFinite(p.modelCatalog.updatedAt) && p.modelCatalog.updatedAt >= 0))
          && (p.id !== 'openai-codex' || p.modelCatalog.source === 'account')
          && (p.modelCatalog.source !== 'account' || (p.configured && p.modelCatalog.state === 'ready') || !p.models.length)
          && (p.attempt === null || validAttempt(p.attempt)));
    }
    async function request(body, signal, keepalive = false) {
      const response = await fetch('/api/subscriptions-lite', {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal, keepalive,
        ...(body ? { headers: { 'Content-Type': 'application/json', 'X-Subscriptions-Lite': '1' }, body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'REQUEST_FAILED');
      return data;
    }
    const styles = `
      .subscriptions-lite{color:var(--dsw-alias-label-primary);display:grid;gap:20px;font-size:14px;line-height:1.5;min-width:0;width:100%;max-width:840px;margin-inline:auto}
      .subscriptions-lite *{box-sizing:border-box}.subscriptions-lite h2,.subscriptions-lite h3,.subscriptions-lite p{margin:0}
      .subscriptions-lite h2{font-size:20px}.subscriptions-lite h3{font-size:16px}
      .subscriptions-lite header,.subscriptions-lite .sl-actions,.subscriptions-lite .sl-model{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .subscriptions-lite header{justify-content:space-between}.subscriptions-lite .sl-card{padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);display:grid;gap:12px;min-width:0}
      .subscriptions-lite .sl-muted{color:var(--dsw-alias-label-secondary)}.subscriptions-lite .sl-status{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .subscriptions-lite .sl-saved{color:var(--dsw-alias-state-success-primary)}.subscriptions-lite .sl-error{color:var(--dsw-alias-state-error-primary)}
      .subscriptions-lite button,.subscriptions-lite input,.subscriptions-lite select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px 10px;min-height:36px;max-width:100%}
      .subscriptions-lite button{cursor:pointer}.subscriptions-lite button:disabled{cursor:not-allowed;opacity:.5}.subscriptions-lite button:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}
      .subscriptions-lite :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.subscriptions-lite a{color:var(--dsw-alias-brand-primary);text-underline-offset:3px}
      .subscriptions-lite .sl-model label{flex:1 1 220px;display:grid;gap:4px;min-width:0}.subscriptions-lite select{width:100%}
      .subscriptions-lite .sl-flow{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;display:grid;gap:10px}
      .subscriptions-lite form{display:grid;gap:8px}.subscriptions-lite form label{display:grid;gap:4px}.subscriptions-lite form button{justify-self:start}
      .subscriptions-lite pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;background:var(--dsw-alias-bg-layer-2);padding:10px;border-radius:6px;font-size:13px}
      .subscriptions-lite .sl-notice{display:grid;gap:5px;overflow-wrap:anywhere}.subscriptions-lite .sl-notice label{display:grid;gap:4px}.subscriptions-lite .sl-notice input{width:100%}.subscriptions-lite .sl-code{font-family:monospace;user-select:all}
      .subscriptions-lite .sl-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
      .subscriptions-lite .sl-nav button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;min-height:40px}
      .subscriptions-lite .sl-nav button[aria-current=page]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 3px #0001}
      .subscriptions-lite .sl-page{display:grid;gap:16px;min-width:0}.subscriptions-lite .sl-data{padding:20px;gap:18px}
      .subscriptions-lite .sl-badge{padding:3px 9px;border-radius:20px;background:var(--dsw-alias-bg-layer-2);white-space:nowrap}
      .subscriptions-lite .sl-details{border-top:1px solid var(--dsw-alias-border-l1);padding-top:14px}.subscriptions-lite .sl-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
      .subscriptions-lite .sl-details>div{display:grid;gap:10px;margin-top:12px}
    `;
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const unregister = Object.entries(messages).map(([locale, dict]) => ctx.locale.register(namespace, locale, dict));
          return () => unregister.forEach(dispose => dispose());
        });
        const t = ctx.locale.bind(namespace);
        const subscribe = listener => ctx.locale.subscribe(listener);
        const snapshot = () => ctx.locale.getSnapshot();
        function Prompt({ prompt, disabled, answer }) {
          const [value, setValue] = React.useState('');
          const inputId = React.useId();
          return h('form', { onSubmit: async event => {
            event.preventDefault();
            if (!disabled && value && await answer(prompt.kind === 'select' ? prompt.options[Number(value)].id : value)) setValue('');
          } }, h('label', { htmlFor: inputId }, prompt.message,
            prompt.kind === 'select'
              ? h('select', { id: inputId, value, required: true, disabled, onChange: event => setValue(event.target.value) },
                h('option', { value: '', disabled: true }, t('choose')), prompt.options.map((option, index) => h('option', { key: index, value: String(index) }, option.label)))
              : h('input', { id: inputId, type: prompt.kind === 'secret' ? 'password' : 'text', value, required: true, disabled,
                autoComplete: 'off', spellCheck: false, maxLength: 16384, placeholder: prompt.placeholder,
                onChange: event => setValue(event.target.value) })),
          h('button', { type: 'submit', disabled: disabled || !value }, t('submit')));
        }
        function Panel({ close }) {
          React.useSyncExternalStore(subscribe, snapshot, snapshot);
          const [page, setPage] = React.useState('modelsPage');
          const pageId = React.useId();
          const modelsPageButton = React.useRef(null);
          const [status, setStatus] = React.useState({ providers: [], loading: true, error: null });
          const [busy, setBusy] = React.useState({});
          const [results, setResults] = React.useState({});
          const [models, setModels] = React.useState({});
          const [launchStates, setLaunchStates] = React.useState({});
          const [copyStates, setCopyStates] = React.useState({});
          const owned = React.useRef(new Map());
          const authWindows = React.useRef(new Map());
          const locks = React.useRef(new Set());
          const control = React.useRef(null);
          function ownsWaitingWindow(pending) {
            if (!pending?.document || pending.launched) return false;
            try {
              return !pending.window.closed && pending.window.document === pending.document
                && pending.window.location.href === 'about:blank';
            } catch { return false; } // A user-navigated, cross-origin tab is not ours.
          }
          function releaseAuthWindow(provider) {
            const pending = authWindows.current.get(provider);
            authWindows.current.delete(provider);
            // Only our untouched waiting tab may be closed. A provider page
            // belongs to the user, even after the attempt ends or unmounts.
            if (ownsWaitingWindow(pending)) {
              try { pending.window.close(); } catch { /* Already gone. */ }
            }
          }
          function updateAuthWindow(provider, attempt) {
            const pending = authWindows.current.get(provider);
            if (!pending?.attemptId || pending.attemptId !== attempt?.id) return;
            if (attempt.state !== 'running') { releaseAuthWindow(provider); return; }
            if (pending.launched) return;
            const url = attempt.notices.map(notice => notice.url && trustedLink(notice.url, provider)).find(Boolean);
            if (!url) {
              if (attempt.notices.some(notice => notice.url)) {
                releaseAuthWindow(provider);
                setLaunchStates(previous => ({ ...previous, [provider]: null }));
              }
              return;
            }
            try {
              if (!ownsWaitingWindow(pending)) throw new Error('POPUP_BLOCKED');
              pending.window.location.replace(url);
              pending.launched = true;
              setLaunchStates(previous => ({ ...previous, [provider]: 'opened' }));
            } catch {
              releaseAuthWindow(provider);
              setLaunchStates(previous => ({ ...previous, [provider]: 'blocked' }));
            }
          }
          React.useEffect(() => {
            const controller = new AbortController();
            let active = true, timer, pending = false, queued = false, running = false, revision = 0;
            async function refresh() {
              if (!active) return;
              clearTimeout(timer);
              if (pending) { queued = true; return; }
              pending = true;
              const currentRevision = revision;
              try {
                const data = await request(null, controller.signal);
                if (!validStatus(data)) throw new Error('BAD_RESPONSE');
                if (!active) return;
                if (currentRevision !== revision) { queued = true; return; }
                running = data.providers.some(p => p.attempt?.state === 'running');
                for (const p of data.providers) {
                  updateAuthWindow(p.id, p.attempt);
                  if (p.attempt && p.attempt.id === owned.current.get(p.id) && p.attempt.state !== 'running') owned.current.delete(p.id);
                }
                setStatus({ providers: data.providers, vendorTools: data.vendorTools, loading: false, error: null });
              } catch (error) {
                if (active) setStatus(previous => ({ ...previous, loading: false, error: error.message }));
              } finally {
                pending = false;
                if (active && (queued || running)) timer = setTimeout(refresh, queued ? 0 : 1000);
                queued = false;
              }
            }
            function dispose() {
              if (!active) return;
              active = false;
              controller.abort();
              clearTimeout(timer);
              for (const [provider, attemptId] of owned.current) request({ action: 'cancel', provider, attemptId }, undefined, true).catch(() => {});
              owned.current.clear();
              for (const provider of authWindows.current.keys()) releaseAuthWindow(provider);
            }
            control.current = { refresh, dispose, signal: controller.signal, active: () => active, invalidate: () => { revision++; } };
            refresh();
            return dispose;
          }, []);
          async function run(provider, action, extra = {}) {
            const current = control.current;
            if (!current?.active() || locks.current.has(provider)) return false;
            locks.current.add(provider);
            setBusy(previous => ({ ...previous, [provider]: action }));
            setResults(previous => ({ ...previous, [provider]: null }));
            current.invalidate();
            try {
              const data = await request({ action, provider, ...extra }, current.signal);
              if (action === 'login') {
                if (!validAttempt(data)) throw new Error('BAD_RESPONSE');
                if (data.state === 'running') {
                  if (!current.active()) request({ action: 'cancel', provider, attemptId: data.id }, undefined, true).catch(() => {});
                  else {
                    owned.current.set(provider, data.id);
                    const pending = authWindows.current.get(provider);
                    if (pending) pending.attemptId = data.id;
                    updateAuthWindow(provider, data);
                  }
                } else releaseAuthWindow(provider);
              } else if (data?.ok !== true || (action === 'test' && (typeof data.text !== 'string' || typeof data.model !== 'string'))) {
                throw new Error('BAD_RESPONSE');
              }
              if (!current.active()) return false;
              if (action === 'cancel' || action === 'logout') {
                owned.current.delete(provider);
                releaseAuthWindow(provider);
              }
              if (action === 'test') setResults(previous => ({ ...previous, [provider]: { text: data.text, model: data.model } }));
              return true;
            } catch (error) {
              if (action === 'login') releaseAuthWindow(provider);
              if (current.active()) setResults(previous => ({ ...previous, [provider]: { error: error.message } }));
              return false;
            } finally {
              locks.current.delete(provider);
              if (current.active()) {
                setBusy(previous => ({ ...previous, [provider]: null }));
                current.invalidate();
                current.refresh();
              }
            }
          }
          function startLogin(provider) {
            if (!control.current?.active() || locks.current.has(provider)) return false;
            releaseAuthWindow(provider);
            let popup = null, waitingDocument = null;
            // Reserve synchronously within the user's click, before awaiting
            // the device grant. Async window.open is blocked by browsers.
            try {
              popup = window.open('about:blank', '_blank');
              if (popup) {
                popup.opener = null;
                waitingDocument = popup.document;
                if (!waitingDocument) throw new Error('POPUP_UNAVAILABLE');
                const meta = waitingDocument.createElement('meta');
                meta.name = 'referrer'; meta.content = 'no-referrer';
                waitingDocument.head.append(meta);
                waitingDocument.title = t('running');
                waitingDocument.body.textContent = t('preparingTab');
              }
            } catch {
              if (ownsWaitingWindow({ window: popup, document: waitingDocument, launched: false })) {
                try { popup.close(); } catch { /* No accessible waiting window. */ }
              }
              popup = null; waitingDocument = null;
            }
            authWindows.current.set(provider, { window: popup, document: waitingDocument, attemptId: null, launched: false });
            setLaunchStates(previous => ({ ...previous, [provider]: popup ? 'preparing' : 'blocked' }));
            setCopyStates(previous => ({ ...previous, [provider]: null }));
            return run(provider, 'login');
          }
          async function copyAuthorization(provider, value) {
            try {
              if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
              await navigator.clipboard.writeText(value);
              if (control.current?.active()) setCopyStates(previous => ({ ...previous, [provider]: 'copied' }));
            } catch {
              if (control.current?.active()) setCopyStates(previous => ({ ...previous, [provider]: 'copyHelp' }));
            }
          }
          const kimi = status.providers.find(provider => provider.id === 'kimi-coding');
          const datasource = status.vendorTools?.kimiDatasource;
          const errorText = code => t(errorKeys[code] || 'requestError');
          const link = (url, label) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, label);
          return h('section', { className: 'subscriptions-lite', 'aria-label': t('title') },
            h('style', null, styles),
            h('header', null, h('h2', null, t('title')), h('button', { type: 'button', onClick: () => { control.current?.dispose(); close(); } }, t('close'))),
            h('nav', { className: 'sl-nav', 'aria-label': t('navigation') }, ['modelsPage', 'toolsPage'].map(id =>
              h('button', { key: id, type: 'button', ref: id === 'modelsPage' ? modelsPageButton : undefined,
                'aria-current': page === id ? 'page' : undefined, 'aria-controls': pageId, onClick: () => setPage(id) }, t(id)))),
            status.loading && h('p', { role: 'status' }, t('loading')),
            status.error && h('div', { role: 'alert' }, h('p', { className: 'sl-error' }, errorText(status.error)),
              h('button', { type: 'button', onClick: () => control.current?.refresh() }, t('retry'))),
            h('section', { id: pageId, className: 'sl-page', 'aria-label': t(page) }, page === 'toolsPage'
              ? kimi && h('article', { className: 'sl-card sl-data', 'aria-label': t('toolsTitle') },
                h('header', null, h('h3', null, t('toolsTitle')),
                  h('span', { className: `sl-status sl-badge${datasource?.enabled ? ' sl-saved' : ''}`, role: 'status' },
                    t(!datasource ? 'toolsUnknown' : datasource.enabled ? 'toolsEnabled' : 'toolsDisabled'))),
                h('div', { className: 'sl-actions' },
                  h('p', { className: 'sl-status', role: 'status' }, t(kimi.configured ? 'toolsSharedCredential' : 'toolsNeedsCredential')),
                  !kimi.configured && h('button', { type: 'button', onClick: () => {
                    setPage('modelsPage'); modelsPageButton.current?.focus();
                  } }, t('toolsConnect'))),
                h('details', { className: 'sl-details' }, h('summary', null, t('billing')), h('div', null,
                  h('p', { className: 'sl-muted' }, t('toolsCost')))))
              : status.providers.map(provider => {
              const attempt = provider.attempt;
              const isRunning = attempt?.state === 'running';
              const isOwned = isRunning && owned.current.get(provider.id) === attempt.id;
              const model = provider.models.some(m => m.id === models[provider.id]) ? models[provider.id] : (provider.models[0]?.id || '');
              const disabled = !!busy[provider.id];
              const result = results[provider.id];
              const accountCatalog = provider.modelCatalog.source === 'account';
              return h('article', { key: provider.id, className: 'sl-card', 'aria-label': provider.name },
                h('header', null, h('h3', null, provider.name), h('span', { className: `sl-status${provider.configured ? ' sl-saved' : ''}`, role: 'status' },
                  t(!provider.available ? 'unavailable' : provider.configured ? 'saved' : 'missing'))),
                provider.credentialKind === 'api-key' && h('p', { className: 'sl-muted' }, t('apiKey')),
                h('div', { className: 'sl-actions' },
                  h('button', { type: 'button', disabled: disabled || isRunning || !provider.available, onClick: () => startLogin(provider.id) }, t(provider.configured ? 'reconnect' : 'connect')),
                  isRunning && h('button', { type: 'button', disabled, onClick: () => run(provider.id, 'cancel', { attemptId: attempt.id }) }, t('cancel')),
                  provider.configured && h('button', { type: 'button', disabled: disabled || isRunning, onClick: () => {
                    if (window.confirm(t('logoutConfirm'))) run(provider.id, 'logout');
                  } }, t('logout'))),
                provider.id === 'xai' && h('details', { className: 'sl-details' }, h('summary', null, t('billing')), h('div', null,
                  h('p', { className: 'sl-muted' }, t('xai')),
                  h('div', { className: 'sl-actions' }, link('https://x.ai/news/grok-opencode', t('grokNews')), link('https://docs.x.ai/build/cli/headless-scripting', t('grokDocs'))))),
                provider.available && h(React.Fragment, null,
                  accountCatalog && provider.configured && h('button', { type: 'button', disabled: disabled || isRunning,
                    onClick: () => run(provider.id, 'models') }, t(busy[provider.id] === 'models' ? 'refreshingModels' : 'refreshModels')),
                  provider.modelCatalog.error && provider.modelCatalog.error !== result?.error
                    && h('p', { className: 'sl-error', role: 'alert' }, errorText(provider.modelCatalog.error)),
                  h('div', { className: 'sl-model' }, h('label', null, t(accountCatalog ? 'accountModels' : 'model'),
                    h('select', { value: model, disabled: disabled || isRunning || !provider.models.length, onChange: event => setModels(previous => ({ ...previous, [provider.id]: event.target.value })) },
                      !provider.models.length && h('option', { value: '' }, t(accountCatalog ? 'accountNoModels' : 'noModels')), provider.models.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
                  h('button', { type: 'button', disabled: disabled || isRunning || !provider.configured || !model, onClick: () => {
                    const warning = provider.id === 'xai' ? `\n${t('xai')}` : '';
                    if (window.confirm(`${t('testConfirm')}\n${model}${warning}`)) run(provider.id, 'test', { model });
                  } }, t(busy[provider.id] === 'test' ? 'testing' : 'test')))),
                attempt && h('div', { className: 'sl-flow' },
                  h('p', { role: 'status' }, t(attempt.state)),
                  attempt.error && h('p', { className: 'sl-error', role: 'alert' }, errorText(attempt.error)),
                  attempt.state === 'failed' && !attempt.notices.some(notice => notice.url) && h('p', { className: 'sl-error' }, t('noAuthLink')),
                  isRunning && h('p', { className: 'sl-muted' }, t(isOwned ? 'authHelp' : 'resumed')),
                  isRunning && !attempt.notices.some(notice => notice.url || notice.code) && !attempt.prompt
                    && h('p', { role: 'status' }, t('preparing')),
                  isRunning && launchStates[provider.id] === 'blocked' && h('p', { role: 'status' }, t('popupBlocked')),
                  isRunning && launchStates[provider.id] === 'opened' && h('p', { role: 'status' }, t('opened')),
                  isRunning && attempt.notices.map((notice, index) => {
                    const url = notice.url && trustedLink(notice.url, provider.id);
                    const readonly = { readOnly: true, spellCheck: false, autoComplete: 'off', onFocus: event => event.target.select() };
                    return h('div', { key: index, className: 'sl-notice' }, h('p', null, notice.message),
                      notice.code && h(React.Fragment, null,
                        h('label', null, t('code'), h('input', { ...readonly, className: 'sl-code', value: notice.code })),
                        h('div', { className: 'sl-actions' }, h('button', { type: 'button', onClick: () => copyAuthorization(provider.id, notice.code) }, t('copyCode')))),
                      url ? h(React.Fragment, null,
                        h('label', null, t('authorizationLink'), h('input', { ...readonly, value: url })),
                        h('div', { className: 'sl-actions' }, link(url, t('authorize')),
                          h('button', { type: 'button', onClick: () => copyAuthorization(provider.id, url) }, t('copyLink'))))
                        : notice.url && h('p', { className: 'sl-error', role: 'alert' }, t('unsafeLink')));
                  }),
                  isRunning && copyStates[provider.id] && h('p', { role: 'status' }, t(copyStates[provider.id])),
                  isRunning && attempt.prompt && h(Prompt, { key: attempt.prompt.id, prompt: attempt.prompt, disabled,
                    answer: value => run(provider.id, 'answer', { attemptId: attempt.id, promptId: attempt.prompt.id, value }) })),
                result && (result.error ? h('p', { className: 'sl-error', role: 'alert' }, errorText(result.error))
                  : h('div', { className: 'sl-notice', role: 'status' }, h('p', null, `${t('testResult')} · ${result.model}`), h('pre', null, result.text))));
            })));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'subscriptions-lite', order: 55, label: () => t('title'),
        }, Panel));
      },
    };
  },
});
