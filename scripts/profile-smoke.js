import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Usage: npm run smoke:profile -- /absolute/@deepseek-ai/dsh /absolute/plugin.tgz
// Install a packed release into a new profile; never read or change a user's profile.
const [installationArg, tarballArg] = process.argv.slice(2);
if (!installationArg || !tarballArg || !isAbsolute(installationArg) || !isAbsolute(tarballArg)) {
  throw new Error('Usage: smoke:profile -- /absolute/@deepseek-ai/dsh /absolute/plugin.tgz');
}
const installation = resolve(installationArg);
const tarball = resolve(tarballArg);
const manifest = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh');
assert.ok(['0.2.1-rc.2', '0.2.1-rc.3'].includes(manifest.version), 'use a supported host version');
const lab = await mkdtemp(join(tmpdir(), `sheetdiff-profile-${manifest.version}-`));
const workspace = join(lab, 'workspace');
await mkdir(workspace);
const home = join(lab, 'home');
const environment = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  DSH_HOME: home, DSH_AGENTS_HOME: join(lab, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write',
};
const argv = [join(installation, 'lib/bin.js'), 'plugin', '--profile', 'sheetdiff-smoke', 'add', tarball];
const installed = await new Promise((done, reject) => {
  const child = spawn(process.execPath, argv, { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (part) => { stdout += part; });
  child.stderr.on('data', (part) => { stderr += part; });
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 120000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, stderr }); });
});
await writeFile(join(lab, 'install.json'), `${JSON.stringify(installed, null, 2)}\n`);
assert.equal(installed.code, 0, JSON.stringify(installed));
const profile = join(home, 'profiles/sheetdiff-smoke');
const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
assert.ok(profileManifest.dsh.profile.bundles.includes('dsh-sheet-diff'));
const installedPlugin = join(profile, 'node_modules/dsh-sheet-diff');
const pluginManifest = JSON.parse(await readFile(join(installedPlugin, 'package.json'), 'utf8'));
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
assert.equal(pluginManifest.version, expectedVersion);
await writeFile(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n');
const original = 'id,name,amount\n1,Alice,10\n2,Bob,20\n';
const revised = 'id,name,amount\n2,Bob,20\n1,Alice,11\n3,Carol,30\n';
await writeFile(join(workspace, 'before.csv'), original);
await writeFile(join(workspace, 'after.csv'), revised);
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
process.chdir(workspace);
const hostRequire = createRequire(join(installation, 'package.json'));
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-launch-environment')).href);
const { runProfile } = await import(pathToFileURL(join(installation, 'lib/profile-boot.js')).href);
let ctx;
try {
  ({ ctx } = await runProfile({
    profile: 'sheetdiff-smoke', patchFiles: [], args: [],
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
  }));
  const toolNames = ['sheet_diff_compare', 'sheet_diff_review', 'sheet_diff_handoff'];
  for (const name of toolNames) assert.ok(ctx.tools.get(name), `${name} registered after official profile boot`);
  const execute = async (name, args) => {
    const result = await ctx.tools.execute({ callId: `profile-${name}`, name, arguments: args, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value;
  };
  const comparisonArgs = { before: 'before.csv', after: 'after.csv', keyColumns: ['id'], outputDir: 'report' };
  const comparison = await execute('sheet_diff_compare', comparisonArgs);
  assert.equal(comparison.summary.changedCells, 1);
  assert.equal(comparison.summary.addedRows, 1);
  const report = JSON.parse(await readFile(comparison.paths.json, 'utf8'));
  const change = report.changes.find((item) => item.kind === 'cell-changed');
  const review = {
    schemaVersion: 2, reportId: report.reportId, sourceHashes: comparison.sourceHashes,
    entries: [{ changeId: change.id, status: 'needs-change', text: 'Keep the original amount until the invoice is checked.' }],
  };
  const reviewJson = join(workspace, 'review.json');
  await writeFile(reviewJson, JSON.stringify(review));
  const reviewed = await execute('sheet_diff_review', { reportJson: comparison.paths.json, reviewJson });
  assert.equal(reviewed.comments[0].status, 'needs-change');
  assert.deepEqual(reviewed.comments[0].change, change);
  const handoffArgs = { reportJson: comparison.paths.json, reviewJson, before: 'before.csv', after: 'after.csv', outputDir: 'handoff' };
  const handoff = await execute('sheet_diff_handoff', handoffArgs);
  assert.equal(handoff.summary.needsChange, 1);
  assert.equal(handoff.summary.pending, 1);
  const feedback = JSON.parse(await readFile(handoff.json, 'utf8'));
  assert.equal(feedback.entries[0].text, review.entries[0].text);
  assert.ok((await readFile(handoff.markdown, 'utf8')).includes('untrusted'));
  const collision = await ctx.tools.execute({ callId: 'collision', name: 'sheet_diff_compare', arguments: comparisonArgs, signal: new AbortController().signal });
  assert.equal(collision.isError, true);
  assert.match(JSON.stringify(collision.content), /never overwrites/);
  assert.equal(await readFile(join(workspace, 'before.csv'), 'utf8'), original);
  assert.equal(await readFile(join(workspace, 'after.csv'), 'utf8'), revised);
  await writeFile(join(workspace, 'after.csv'), `${revised}4,Changed,40\n`);
  const stale = await ctx.tools.execute({ callId: 'stale', name: 'sheet_diff_handoff', arguments: { ...handoffArgs, outputDir: 'stale' }, signal: new AbortController().signal });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.content), /hash|changed|match/i);
  const pluginEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === 'dsh-sheet-diff');
  assert.ok(pluginEntry?.fiber, 'packed plugin is mounted in the profile composition');
  const fiber = pluginEntry.fiber;
  await fiber.dispose();
  for (const name of toolNames) assert.equal(ctx.tools.get(name), undefined, `${name} disposed`);
  const result = {
    ok: true, node: process.version, host: manifest.version, plugin: pluginManifest.version,
    lab, tarballSha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
    installation: 'official dsh plugin add of packed tarball into fresh isolated profile',
    boot: 'official runProfile entrypoint; HMR disabled in test profile only; no model call',
    assertions: ['three tools registered', 'key-aligned comparison', 'v2 review validation', 'hash-verified handoff', 'source bytes unchanged', 'overwrite rejected', 'stale source rejected', 'plugin disposal unregisters tools'],
    summary: comparison.summary, handoff: handoff.summary,
  };
  await writeFile(join(lab, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await ctx?.fiber.dispose();
}
