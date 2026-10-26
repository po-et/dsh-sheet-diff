import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy';
import { parse } from 'yaml';
import * as SheetDiff from '../src/plugin.js';

// This is a real Cordis host. Fixture I/O below is outside the tool under test.
export async function createHost(workspace, { mode = 'workspace-write', bundle = false } = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace });
    await ctx.plugin(LocalFileSystem, { cwd: workspace });
    let fiber;
    if (bundle) {
      await ctx.plugin(Loader, { baseUrl: new URL('../package.json', import.meta.url).href });
      if (!ctx.loader.internal) throw new Error('Bundle smoke requires node --expose-internals so the real loader resolves the package from its base URL');
      const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      const patch = parse(await readFile(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8'));
      assert.equal(patch.length, 1);
      assert.equal(patch[0].insert.length, 1);
      assert.equal(patch[0].insert[0].name, manifest.name);
      await ctx.loader.root.update(patch[0].insert);
      await ctx.loader.await();
      fiber = ctx.loader.resolve(patch[0].insert[0].id).fiber;
    } else {
      fiber = await ctx.plugin(SheetDiff);
    }
    assert.ok(ctx.tools.get('sheet_diff_compare'), 'host registered compare tool');
    assert.ok(ctx.tools.get('sheet_diff_review'), 'host registered review tool');
    assert.ok(ctx.tools.get('sheet_diff_handoff'), 'host registered handoff tool');
    return { ctx, fiber };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export function dispatch(ctx, name, args, signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: `smoke-${name}`, name, arguments: args, signal });
}

export async function runSmoke() {
  const workspace = await mkdtemp(join(tmpdir(), 'sheetdiff-host-'));
  const previousCwd = process.cwd();
  const original = 'id,name,amount\n1,Alice,10\n2,Bob,20\n';
  const revised = 'id,name,amount\n2,Bob,20\n1,Alice,11\n3,Carol,30\n';
  await writeFile(join(workspace, 'before.csv'), original);
  await writeFile(join(workspace, 'after.csv'), revised);
  const { ctx, fiber } = await createHost(workspace, { bundle: true });
  process.chdir(workspace);
  try {
    const args = { before: 'before.csv', after: 'after.csv', keyColumns: ['id'], outputDir: 'reports' };
    const compared = await dispatch(ctx, 'sheet_diff_compare', args);
    assert.equal(compared.isError, false, JSON.stringify(compared));
    assert.equal(compared.value.summary.changedCells, 1);
    assert.equal(compared.value.summary.addedRows, 1);
    assert.equal(compared.value.summary.removedRows, 0);
    const report = JSON.parse(await readFile(compared.value.paths.json, 'utf8'));
    const html = await readFile(compared.value.paths.html, 'utf8');
    assert.ok(html.includes(report.reportId));
    const change = report.changes.find(item => item.kind === 'cell-changed');
    const review = {
      schemaVersion: 1, reportId: report.reportId,
      sourceHashes: compared.value.sourceHashes,
      comments: [{ changeId: change.id, text: 'Please confirm the amount change.' }],
    };
    const reviewPath = join(workspace, 'review.json');
    await writeFile(reviewPath, JSON.stringify(review));
    const reviewed = await dispatch(ctx, 'sheet_diff_review', { reportJson: compared.value.paths.json, reviewJson: reviewPath });
    assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
    assert.deepEqual(reviewed.value.comments[0].change, change);
    const handoff = await dispatch(ctx, 'sheet_diff_handoff', {
      reportJson: compared.value.paths.json, reviewJson: reviewPath,
      before: 'before.csv', after: 'after.csv', outputDir: 'handoff',
    });
    assert.equal(handoff.isError, false, JSON.stringify(handoff));
    assert.equal(handoff.value.summary.pending, 2);
    assert.ok((await readFile(handoff.value.markdown, 'utf8')).includes('untrusted'));
    const collision = await dispatch(ctx, 'sheet_diff_compare', args);
    assert.equal(collision.isError, true);
    assert.match(JSON.stringify(collision.content), /never overwrites/);
    assert.equal(await readFile(join(workspace, 'before.csv'), 'utf8'), original);
    assert.equal(await readFile(join(workspace, 'after.csv'), 'utf8'), revised);
    await fiber.dispose();
    assert.equal(ctx.tools.get('sheet_diff_compare'), undefined, 'disposing the real plugin unregisters its tools');
    const versions = {};
    for (const packageName of ['cordis', 'dsh-tools', 'dsh-fs', 'dsh-sandbox-policy']) {
      const manifest = await import(`@deepseek-ai/${packageName}/package.json`, { with: { type: 'json' } });
      versions[packageName] = manifest.default.version;
    }
    return {
      ok: true, host: 'real Cordis Context, Loader, ToolRuntime, LocalFileSystem, SandboxPolicyService',
      bundle: 'manifest patch row imported by the real Cordis Loader',
      profileBoot: 'CLI profile install/boot is outside this smoke',
      versions, workspace, paths: compared.value.paths,
      summary: compared.value.summary, validatedComments: reviewed.value.comments.length,
      handoff: handoff.value,
    };
  } finally {
    process.chdir(previousCwd);
    await ctx.fiber.dispose();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await runSmoke(), null, 2));
}
