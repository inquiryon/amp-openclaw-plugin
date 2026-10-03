// Load the AMP internal hook (HOOK.md + handler.ts deployed into $OPENCLAW_STATE_DIR/hooks/amp)
// via OpenClaw's REAL internal-hook loader, then fire events via the REAL triggerInternalHook.
// Copied from the workspace compat harness (.tools/compat/openclaw); only default paths changed.
// Usage: node drive_hook.mjs [--with-home-config] [--out result.json]
// Env: OC_PKG, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, HOME (use a throwaway dir),
//      STUB_LOG (defaults to <tmpdir>/amp-oc-stub_requests.jsonl, same as stub_amp.py)
//   --with-home-config  also writes $HOME/.openclaw/hooks/amp/amp_config.json (HOME is a throwaway
//                       dir in env-*.sh) because handler.ts hardcodes $HOME/.openclaw (ignores OPENCLAW_STATE_DIR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(process.env.OC_PKG, 'dist');
const STATE = process.env.OPENCLAW_STATE_DIR;
const STUB_LOG = process.env.STUB_LOG || path.join(os.tmpdir(), 'amp-oc-stub_requests.jsonl');
const withHome = process.argv.includes('--with-home-config');
const imp = (p) => import(pathToFileURL(p).href);
const report = { openclawVersion: JSON.parse(fs.readFileSync(path.join(process.env.OC_PKG, 'package.json'))).version, withHomeConfig: withHome };

function findExport(re, sym) {
  for (const f of fs.readdirSync(dist)) {
    if (!re.test(f)) continue;
    const s = fs.readFileSync(path.join(dist, f), 'utf8');
    if (!s.includes(`function ${sym}`)) continue;
    const m = s.match(new RegExp(`\\b${sym} as ([\\w$]+)`)) || (s.match(new RegExp(`export \\{[^}]*\\b${sym}\\b`)) ? [0, sym] : null);
    if (m) return { file: f, alias: m[1] };
  }
  return null;
}
const off = () => (fs.existsSync(STUB_LOG) ? fs.statSync(STUB_LOG).size : 0);
const since = (o) => fs.readFileSync(STUB_LOG).subarray(o).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => `${e.method} ${e.path}${e.body?.message ? ` [${String(e.body.message).slice(0, 50)}]` : ''}`);

const homeCfg = path.join(process.env.HOME, '.openclaw/hooks/amp/amp_config.json');
if (withHome) { fs.mkdirSync(path.dirname(homeCfg), { recursive: true }); fs.copyFileSync(path.join(STATE, 'hooks/amp/amp_config.json'), homeCfg); }
else { try { fs.unlinkSync(homeCfg); } catch {} }
report.handlerConfigPathExists = fs.existsSync(homeCfg);

let base = {};
try { base = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8')); } catch {}
// equivalent of `openclaw hooks enable amp`
const cfg = { ...base, hooks: { ...(base.hooks || {}), internal: { enabled: true, entries: { amp: { enabled: true } } } } };

const ih = findExport(/^internal-hooks-[A-Za-z0-9_-]+\.m?js$/, 'triggerInternalHook');
const ihMod = await imp(path.join(dist, ih.file));
const pick = (name) => ihMod[name] || ihMod[Object.keys(ihMod).find((k) => ihMod[k]?.name === name)];
const trigger = pick('triggerInternalHook');
const createEvt = pick('createInternalHookEvent');
const getKeys = pick('getRegisteredEventKeys');

// Capture loader log lines (warnings about unknown events / load failures go to subsystem logger → console)
const captured = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { captured.push(`${k}: ${a.map(String).join(' ').slice(0, 400)}`); orig(...a); };
}

const prep = findExport(/^loader-[A-Za-z0-9_-]+\.m?js$/, 'prepareInternalHooks');
const legacy = findExport(/^loader-[A-Za-z0-9_-]+\.m?js$/, 'loadInternalHooks');
report.loaderApi = prep ? `prepareInternalHooks (${prep.file})` : legacy ? `loadInternalHooks (${legacy.file})` : 'NOT FOUND';
try {
  if (prep) {
    const fn = (await imp(path.join(dist, prep.file)))[prep.alias];
    const r = await fn(cfg, STATE, { failureMode: 'best-effort', managedHooksDir: path.join(STATE, 'hooks') });
    r.commit();
    report.loadedCount = r.loadedCount;
  } else {
    const fn = (await imp(path.join(dist, legacy.file)))[legacy.alias];
    report.loadedCount = await fn(cfg, STATE, { managedHooksDir: path.join(STATE, 'hooks') });
  }
} catch (e) { report.loadError = String(e?.message || e).slice(0, 600); }
report.registeredEventKeys = getKeys ? getKeys() : 'n/a';

const fire = async (type, action, context) => {
  const o = off(); const c0 = captured.length;
  await trigger(createEvt(type, action, 'agent:main:compat', context));
  await new Promise((r) => setTimeout(r, 500));
  return { event: `${type}:${action}`, stubRequests: since(o), handlerLogs: captured.slice(c0).filter((l) => l.includes('[AMP Hook]') || l.includes('Hook error')) };
};
report.events = [];
report.events.push(await fire('message', 'received', { from: 'user:1', content: 'hello', channelId: 'slack', conversationId: 'C1', messageId: 'm-in-1' }));
report.events.push(await fire('message', 'sent', { to: 'user:1', content: 'reply', success: true, channelId: 'slack', conversationId: 'C1', messageId: 'm-out-1' }));
report.events.push(await fire('tool', 'end', { toolName: 'exec' }));
report.events.push(await fire('task', 'start', {}));
report.loaderLogs = captured.filter((l) => /hook|Hook/.test(l)).slice(0, 20);
const json = JSON.stringify(report, null, 2);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(os.tmpdir(), `amp-oc-hook-result-${report.openclawVersion}-${withHome ? 'homecfg' : 'nohomecfg'}.json`);
fs.writeFileSync(OUT, json);
process.stdout.write(json + '\n');
process.exit(0);
