import { runSuites } from './harness.mjs';
import { killTrackedWorkers } from '../src/transport.mjs';
process.env.DSH_TEST_TRACK_WORKERS = '1';
const names = ['state','store','models','acp-client','orchestration','provenance','usage','resolution','shutdown','mcp-server','e2e'];
const suites = [];
for (const name of names) suites.push((await import(`./${name}.test.mjs`)).suite);
try {
  const result = await runSuites(suites, { filter: process.argv[2] });
  process.exitCode = result.failed ? 1 : 0;
} finally {
  killTrackedWorkers();
  const timer = setTimeout(() => { process.stderr.write('Test cleanup did not finish\n'); process.exit(1); }, 3000);
  timer.unref();
}
