import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let bootEntry;
try {
  const selected = require.resolve(process.env.DSH_TEST_UNDICI ?? 'undici');
  bootEntry = createRequire(selected).resolve('@deepseek-ai/dsh-app-boot');
} catch (error) { if (process.env.DSH_TEST_UNDICI) throw error; }

// small/regression — run the actual installation/startup gate with no exemptions.
// Reuse the selected DSH installation; no profile writes, credentials or network.
test('manifest passes the DSH compatibility gate only for verified releases', {
  skip: !bootEntry && 'Set DSH_TEST_UNDICI to select the installed DSH runtime.',
}, async () => {
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(pathToFileURL(bootEntry).href);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const peersOnly = { name: manifest.name, version: manifest.version, peerDependencies: manifest.peerDependencies };
  for (const version of ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', getDshRuntimeVersion()]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined,
      `engines.dsh must accept verified DSH ${version} without an exemption`);
    assert.equal(evaluatePluginCompatibility(peersOnly, {}, version), undefined,
      `adapter peer must accept verified DSH ${version}`);
  }
  for (const version of ['0.2.1-rc.4', '0.2.1', '0.2.2', '0.3.0']) {
    for (const declaration of [manifest, peersOnly]) {
      const issue = evaluatePluginCompatibility(declaration, {}, version);
      assert.ok(issue, `unverified DSH ${version} must remain blocked`);
      assert.equal(issue.exempted, false);
    }
  }
});
