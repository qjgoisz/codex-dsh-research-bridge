// Explicit no-model ACP lifecycle check. It starts a test worker/session; DSH
// may persist session metadata. Never uses a user's active research session.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpClient } from '../src/acp-client.mjs';
import { createWorkerSpec } from '../src/worker.mjs';
import { loadConfigFile, defaultConfigPath } from '../src/config.mjs';
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
const { config } = loadConfigFile(resolve(value('--config') ?? defaultConfigPath()));
const workspace = mkdtempSync(join(tmpdir(), 'bridge-probe-'));
const launch = createWorkerSpec({ workspace, dshHome: config.dshHome ?? undefined,
  installationRoot: config.dshRoot ?? undefined, command: config.workerCommand ?? undefined,
  args: config.workerArgs ?? undefined, entry: config.workerEntry ?? undefined, nodeBin: config.nodeBin ?? undefined,
  profile: config.profile, transport: value('--transport') ?? config.transport });
const client = new AcpClient({ ...launch, requestTimeoutMs: config.requestTimeoutMs });
const report = { at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
  entry: launch.command, args: launch.args, transport: launch.transport, workspace, modelPromptSent: false, checks: {} };
let sessionId;
try {
  const handshake = await client.initialize(); report.handshake = handshake;
  const created = await client.newSession({ cwd: workspace }); sessionId = created.sessionId;
  report.checks.newSession = typeof sessionId === 'string'; report.sessionId = sessionId;
  report.configOptions = created.configOptions;
  const sessions = await client.listSessions({ cwd: workspace });
  report.checks.listSession = Array.isArray(sessions.sessions);
  report.listWhileActive = sessions;
  report.checks.activeSessionExcluded = !JSON.stringify(sessions).includes(sessionId);
  await client.closeSession(sessionId); sessionId = null; report.checks.closeSession = true;
  const closed = await client.listSessions({ cwd: workspace }); report.listAfterClose = closed;
  if (JSON.stringify(closed).includes(created.sessionId)) {
    const resumed = await client.resumeSession({ sessionId: created.sessionId, cwd: workspace });
    sessionId = created.sessionId; report.checks.resume = Boolean(resumed);
    await client.closeSession(sessionId); sessionId = null;
  } else report.resume = 'unverified: empty no-prompt session was not listed after close';
} catch (error) { report.error = { code: error.code, message: error.message, rpc: error.rpc }; process.exitCode = 1; }
finally {
  if (sessionId) { try { await client.closeSession(sessionId); } catch { /* retain primary diagnostic */ } }
  report.shutdown = await client.shutdown();
  if (!report.shutdown.observed) process.exitCode = 1;
  const target = resolve(value('--report') ?? join(workspace, 'probe-report.json'));
  writeFileSync(target, JSON.stringify(report, null, 2)+'\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: target, ...report }, null, 2));
}
