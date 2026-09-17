'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
async function main() {
  const dirtyField = { dataset: { dirty: '1' } };
  const document = { getElementById: () => ({ querySelectorAll: () => [dirtyField] }) };
  const context = { document, window: {}, fetch: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/utils.js'), 'utf8'), context);
  const admin = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  vm.runInContext(admin.split('\n').find(l => l.startsWith('function _clearSettingsDirty()')), context);
  context.window._clearSettingsDirty = context._clearSettingsDirty;
  await context.api('/api/admin/reset_modem', { method: 'POST', json: { nick: 'demo' } });
  assert.equal(dirtyField.dataset.dirty, '');

  const clientSource = fs.readFileSync(path.join(ROOT, 'public/js/client.js'), 'utf8');
  const start = clientSource.indexOf('async function loadData(){');
  const end = clientSource.indexOf('\nfunction ', start);
  const pending = [];
  const element = { innerHTML: '', disabled: false, textContent: '' };
  const client = { fetchJSON: () => new Promise(resolve => pending.push(resolve)),
    document: { getElementById: () => element, querySelector: () => null },
    window: { scrollY: 0, scrollTo: noop }, localStorage: { getItem: () => null },
    setStatus: noop, renderDebtBanner: noop, renderRetailBanner: noop,
    renderTable: noop, renderProxyTable: noop, updateSummary: noop, initOnboarding: noop,
    requestAnimationFrame: noop, showToast: noop, escapeHtml: String, console: { error: noop },
  };
  vm.createContext(client);
  vm.runInContext(clientSource.slice(start, end), client);
  const older = client.loadData(), newer = client.loadData();
  const payload = version => ({ version, status: [], ports: {}, bandwidth: {}, billing: { balance: version } });
  pending[1](payload(2)); await newer;
  assert.equal(client.rawData.version, 2);
  pending[0](payload(1)); await older;
  assert.equal(client.rawData.version, 1);
  console.log(JSON.stringify({ isolation: 'browser functions in VM with simulated DOM/fetch', results: [
    { finding: 'DEEP-58', unrelatedMutationClearedUnsavedSettings: true },
    { finding: 'DEEP-59', receivedVersions: [2, 1], finalDisplayedStateVersion: client.rawData.version },
  ] }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
