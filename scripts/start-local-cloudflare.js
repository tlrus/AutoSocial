const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { validatePasswordHash } = require('../src/dashboard-auth');
const { config } = require('../src/config');
const tls = require('node:tls');
require('node:dns').setDefaultResultOrder('ipv4first');
if (typeof tls.setDefaultCACertificates === 'function') {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

const root = path.resolve(__dirname, '..');
const local = path.join(root, '.local');
const stateFile = path.join(local, 'cloudflare-live.json');
const appUrl = 'http://127.0.0.1:3000';
const tunnelPattern = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const publicPattern = /^https:\/\/autosocial-studio\.[a-z0-9-]+\.workers\.dev$/;

async function readState() {
  try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function status(url, options = {}) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual', ...options })).status; }
  catch { return 0; }
}
async function save(state) {
  await fs.writeFile(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}
async function detached(command, args, logName, env = process.env) {
  const log = await fs.open(path.join(local, logName), 'a');
  try {
    const child = spawn(command, args, { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { await log.close(); }
}
async function verifyLocalPassword() {
  const text = await fs.readFile(path.join(local, 'dashboard-access.txt'), 'utf8');
  const password = text.match(/password: (.+)/)?.[1];
  if (!password) throw new Error('The local dashboard password file is missing its password.');
  const response = await fetch(`${appUrl}/api/auth/login`, {
    signal: AbortSignal.timeout(8000), method: 'POST',
    headers: { Origin: appUrl, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error('The running dashboard does not accept its configured password.');
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  await fetch(`${appUrl}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: appUrl }, signal: AbortSignal.timeout(8000) });
  if (!/;\s*Secure/i.test(setCookie)) throw new Error('The dashboard needs trusted HTTPS proxy support. Restart it manually; the launcher will not stop an existing process.');
}
async function ensureDashboard(state) {
  let health = await status(`${appUrl}/healthz`);
  let started = false;
  if (!health) {
    if (alive(state.serverPid)) throw new Error('The existing dashboard process is not healthy. It will not be stopped automatically.');
    state.serverPid = await detached(process.execPath, ['src/dashboard-server.js'], 'dashboard-managed.log', {
      ...process.env, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '3000',
      DASHBOARD_ALLOW_REMOTE: 'false', DASHBOARD_TRUST_PROXY: 'true',
    });
    started = true;
    for (let attempt = 0; attempt < 30 && !health; attempt += 1) { await delay(500); health = await status(`${appUrl}/healthz`); }
  }
  if (health !== 200 || await status(`${appUrl}/api/accounts`) !== 401) {
    throw new Error('The local dashboard must be healthy and password protected before a tunnel can start.');
  }
  if (started || !state.localPasswordVerified) { await verifyLocalPassword(); state.localPasswordVerified = true; }
}
async function ensureTunnel(state) {
  if (alive(state.tunnelPid) && tunnelPattern.test(state.tunnelUrl || '')) return;
  const logName = `cloudflare-managed-${Date.now()}.log`;
  state.tunnelPid = await detached('cloudflared', [
    'tunnel', '--url', appUrl, '--no-autoupdate', '--protocol', 'quic', '--edge-ip-version', '4',
  ], logName);
  state.tunnelUrl = '';
  await save(state);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const log = await fs.readFile(path.join(local, logName), 'utf8');
    const url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (url && /Registered tunnel connection/.test(log)) { state.tunnelUrl = url; return; }
    if (!alive(state.tunnelPid)) throw new Error('Cloudflare Tunnel stopped. See its private local log.');
    await delay(500);
  }
  throw new Error('Cloudflare Tunnel has not connected yet. It will retry without changing TLS verification.');
}
async function deploy(state, workerHash) {
  if (!tunnelPattern.test(state.tunnelUrl || '')) throw new Error('No valid connected tunnel URL.');
  const args = ['--yes', 'wrangler@4.147.0', 'deploy', '--config', 'sites/wrangler.jsonc', '--var', `AUTOSOCIAL_ORIGIN:${state.tunnelUrl}`];
  const nodeOptions = `${process.env.NODE_OPTIONS || ''} --use-system-ca --dns-result-order=ipv4first`.trim();
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const commandArgs = process.platform === 'win32' ? ['/d', '/c', 'npx', ...args] : args;
  let output = '';
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, env: { ...process.env, NODE_OPTIONS: nodeOptions, WRANGLER_SEND_METRICS: 'false' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Cloudflare deployment failed. Check Wrangler login and the local connector. No paid plan was requested.')));
  });
  const url = output.match(/https:\/\/autosocial-studio\.[a-z0-9-]+\.workers\.dev/)?.[0];
  if (!url) throw new Error('Cloudflare did not return a verified Worker address.');
  state.publicUrl = url;
  state.deployedTunnelUrl = state.tunnelUrl;
  state.workerHash = workerHash;
}
async function watch() {
  if (!validatePasswordHash(config.dashboardPasswordHash)) throw new Error('Configure a dashboard password before starting Cloudflare.');
  const state = { ...await readState(), supervisorPid: process.pid, ready: false, localPasswordVerified: false };
  delete state.error;
  await save(state);
  while (true) {
    try {
      await ensureDashboard(state);
      await ensureTunnel(state);
      const workerHash = crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'sites', 'worker.mjs'))).digest('hex');
      if (state.deployedTunnelUrl !== state.tunnelUrl || state.workerHash !== workerHash || !publicPattern.test(state.publicUrl || '')) await deploy(state, workerHash);
      if (await status(`${state.publicUrl}/api/accounts`) !== 401) throw new Error('The public dashboard is not reachable with verified password protection yet.');
      state.ready = true;
      delete state.error;
    } catch (error) { state.ready = false; state.error = error.message; console.error(new Date().toISOString(), error.message); }
    await save(state);
    await delay(30000);
  }
}
async function main() {
  await fs.mkdir(local, { recursive: true });
  if (process.argv.includes('--watch')) return watch();
  const state = await readState();
  if (alive(state.supervisorPid) && state.ready && publicPattern.test(state.publicUrl || '')) { console.log(state.publicUrl); return; }
  if (!alive(state.supervisorPid)) await detached(process.execPath, [__filename, '--watch'], 'cloudflare-supervisor.log');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await delay(1000);
    const current = await readState();
    if (current.ready && publicPattern.test(current.publicUrl || '')) { console.log(current.publicUrl); return; }
    if (current.error) throw new Error(current.error);
  }
  throw new Error('Startup is still in progress. Read .local/cloudflare-supervisor.log.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
