// Loads a fresh copy of plugin/index.js against a temp OpenClaw state dir and
// an in-process stub AMP backend, and captures the hooks it registers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStub } from './stub-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ENTRY = path.resolve(HERE, '../../plugin/index.js');

let caseCounter = 0;

function makeFakeRuntime(calls) {
  const record = (name) => async (...args) => { calls.push({ name, args }); };
  return {
    channel: {
      slack: { sendMessageSlack: record('slack.sendMessageSlack') },
      whatsapp: { sendMessageWhatsApp: record('whatsapp.sendMessageWhatsApp') },
    },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.mode]      stub mode to start in (default 'allow')
 * @param {object} [options.modeOpts]  options for that mode (e.g. {boundRequest:true})
 * @param {string} [options.stateDir]  reuse this OpenClaw state dir (a second "process" on the
 *                                     same state; config rewritten, dir not removed by cleanup)
 * @param {object} [options.config]    overrides merged into amp_config.json
 * @param {string} [options.configText] raw amp_config.json contents (e.g. invalid JSON)
 * @param {object} [options.runtime]   replaces the fake api.runtime
 * @param {object} [options.stub]      reuse an existing stub (not closed by cleanup)
 * @param {object} [options.apiConfig] OpenClaw config exposed as api.config (operator hook overrides)
 */
export async function loadPlugin(options = {}) {
  const ownStub = !options.stub;
  const stub = options.stub ?? await startStub();
  if (options.mode) stub.setMode(options.mode, options.modeOpts);

  const ownStateDir = !options.stateDir;
  const stateDir = options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'amp-oc-test-'));
  const configDir = path.join(stateDir, 'hooks', 'amp');
  fs.mkdirSync(configDir, { recursive: true });
  const config = {
    AMP_BACKEND_URL: stub.url,
    AMP_API_KEY: 'amp_k_test',
    AMP_ORG_ID: 'O-1',
    AGENT_NAME: 'test-agent',
    AMP_USERNAME: 't@e.c',
    HITL_TIMEOUT_MINUTES: 0.05,
    HITL_POLL_INTERVAL_MS: 50,
    ...options.config,
  };
  fs.writeFileSync(path.join(configDir, 'amp_config.json'), options.configText ?? JSON.stringify(config, null, 2));

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const restoreEnv = () => {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
  };

  let mod;
  try {
    const href = `${pathToFileURL(PLUGIN_ENTRY).href}?case=${++caseCounter}`;
    mod = (await import(href)).default;
  } catch (err) {
    restoreEnv();
    throw err;
  }

  const handlers = {};
  const opts = {};
  const runtimeCalls = [];
  const loggerErrors = [];
  const fakeApi = {
    logger: { info() {}, warn() {}, error(msg) { loggerErrors.push(String(msg)); }, debug() {} },
    config: options.apiConfig,
    runtime: options.runtime ?? makeFakeRuntime(runtimeCalls),
    source: undefined, // keeps hook auto-deploy off
    on(name, fn, hookOpts) {
      handlers[name] = fn;
      opts[name] = hookOpts;
    },
  };
  mod.register(fakeApi);

  let toolCallCounter = 0;
  const callTool = (toolName, params = {}, ctx) => handlers.before_tool_call(
    { toolName, params, toolCallId: `tc-${++toolCallCounter}` },
    ctx ?? {},
  );

  const cleanup = async () => {
    restoreEnv();
    if (ownStateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    if (ownStub) await stub.close();
  };

  // Register the same module instance again (config reload); later api.on calls replace handlers.
  const reregister = (apiOverrides = {}) => mod.register({ ...fakeApi, ...apiOverrides });

  return { handlers, opts, stub, stateDir, config, runtimeCalls, loggerErrors, callTool, reregister, cleanup };
}
