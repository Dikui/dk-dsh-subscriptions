import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const proxyNames = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];

export async function createAutoProxy(loadUndici, {
  env = process.env, platform = process.platform, readSystem = exec,
} = {}) {
  const direct = { enabled: false, run: fn => fn(), wrap: stream => stream, dispose: async () => {} };
  // Explicit routing belongs to DSH, including invalid/unsupported proxy values.
  if (platform !== 'darwin') return direct;
  if (proxyNames.some(name => env[name]?.trim())) return direct;
  let stdout;
  try {
    ({ stdout } = await readSystem('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024,
    }));
  } catch { return direct; }
  // Top-level keys only: scoped interface settings need not be the active route.
  const value = key => new RegExp(`^  ${key} : (.+)$`, 'm').exec(stdout)?.[1].trim();
  if (value('HTTPSEnable') !== '1' || value('ProxyAutoConfigEnable') === '1'
    || value('ProxyAutoDiscoveryEnable') === '1') return direct;
  const host = value('HTTPSProxy'), portText = value('HTTPSPort') ?? '', port = Number(portText);
  if (!host || !/^\d+$/.test(portText) || port < 1 || port > 65535) return direct;
  let url;
  try {
    url = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return direct;
  } catch { return direct; }
  // ponytail: manual system HTTPS proxy only; PAC/SOCKS need a separate resolver.
  const exceptions = /^  ExceptionsList : <array> \{\n([\s\S]*?)^  \}/m.exec(stdout)?.[1] ?? '';
  const bypass = [...exceptions.matchAll(/^    \d+ : (.+)$/gm)].map(match => match[1].trim());
  const { EnvHttpProxyAgent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } = await loadUndici();
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: '', httpsProxy: url.href,
    noProxy: [env.no_proxy?.trim() || env.NO_PROXY, ...bypass, 'localhost', '.localhost', '127.0.0.1', '::1', '[::1]'].filter(Boolean).join(',') });
  const excludeSimple = value('ExcludeSimpleHostnames') === '1';
  const scope = new AsyncLocalStorage();
  const previous = getGlobalDispatcher();
  let enabled = true;
  // Route below fetch hooks: billion-context can re-anchor them to native fetch.
  const routed = Dispatcher.prototype.compose.call(previous, dispatch => (options, handler) => {
    if (!enabled || !scope.getStore()) return dispatch(options, handler);
    let target;
    try { target = new URL(options.origin); }
    catch { return dispatch(options, handler); }
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.startsWith('127.')
      || ['::1', '::', '0.0.0.0'].includes(hostname);
    if (target.protocol !== 'https:' || local || (excludeSimple && !hostname.includes('.') && !hostname.includes(':'))) return dispatch(options, handler);
    return dispatcher.dispatch(options, handler);
  });
  // Undici installs its v1 compatibility wrapper for desktop Node's native fetch.
  setGlobalDispatcher(routed);
  const run = fn => scope.run(true, fn);
  return {
    enabled: true,
    run,
    // Both stream() and prepareCall() reach this lazy iterator; scope every step.
    wrap: stream => ({
      [Symbol.asyncIterator]() { return this; },
      next: value => run(() => stream.next(value)),
      return: value => run(() => stream.return(value)),
      throw: error => run(() => stream.throw(error)),
    }),
    async dispose() {
      enabled = false;
      if (getGlobalDispatcher() === routed) setGlobalDispatcher(previous);
      await dispatcher.close();
    },
  };
}
