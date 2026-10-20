'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'worker', 'batchSignature.js'), 'utf8');
const moduleMock = { exports: {} };
const context = {
  require(name) {
    if (name === 'playwright') return { chromium: {} };
    if (name === './msptApi') return { login() {}, findPackage() {} };
    if (name === './istAutomation') return { drawIST() {} };
    throw new Error(name);
  },
  module: moduleMock,
  console,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(source + '\nmodule.exports._test = { waitForExactOption };', context);
const { waitForExactOption } = moduleMock.exports._test;

function fakePopup(rows) {
  const normalized = rows.map(row => Array.isArray(row) ? row : [row]);
  const elements = normalized.map(texts => ({
    querySelectorAll(selector) {
      assert.equal(selector, '.k-list-item-text');
      return texts.map(textContent => ({ textContent }));
    }
  }));
  return {
    locator(selector) {
      assert.equal(selector, '[role="option"]');
      return {
        async evaluateAll(callback, id) { return callback(elements, id); },
        nth(index) {
          return {
            async waitFor() {},
            locator(labelSelector) {
              assert.equal(labelSelector, '.k-list-item-text');
              return { async allTextContents() { return normalized[index]; } };
            },
            chosenRow: index
          };
        }
      };
    }
  };
}

(async () => {
  const selected = await waitForExactOption(fakePopup(['9999', '2075378', '20753780']), '2075378', 3000);
  assert.equal(selected.chosenRow, 1, 'Only exact Internal ID is selected');
  // Two text spans for the same logical option should NOT look like two IDs.
  const multiSpan = await waitForExactOption(fakePopup([['2075378', '2075378']]), '2075378', 3000);
  assert.equal(multiSpan.chosenRow, 0);
  await assert.rejects(
    waitForExactOption(fakePopup(['2075378', '2075378']), '2075378', 3000),
    /separate exact options in the active dropdown/
  );
  console.log('PASS: exact option, duplicate spans, truly ambiguous separate options');
})().catch(error => { console.error(error); process.exitCode = 1; });
