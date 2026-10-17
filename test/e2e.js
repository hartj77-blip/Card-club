// Browser test: two separate browser sessions play together through the real
// Node server. Run with `npm run test:e2e` (needs Playwright + Chromium installed).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('Skipping browser test: install Playwright first (npm i -D playwright && npx playwright install chromium).');
  process.exit(0);
}

const PORT = 3000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not start');
}

async function openPlayer(browser, name, url, errors) {
  const ctx = await browser.newContext(); // separate storage = separate player
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(url);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('.room-code');
  return page;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardclub-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const errors = [];
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

    // Host creates a room; the friend joins from the invite link.
    const host = await openPlayer(browser, 'Alice', BASE, errors);
    const code = (await host.textContent('.room-code')).trim();
    assert.match(code, /^[A-Z]{4}$/);
    const friend = await openPlayer(browser, 'Bob', `${BASE}/?room=${code}`, errors);
    assert.strictEqual((await friend.textContent('.room-code')).trim(), code);
    await host.waitForSelector('text=Bob');
    console.log(`  ok  host created ${code}, friend joined from the invite link`);

    // The rules reference opens and closes.
    await friend.click('[data-a=rules]');
    await friend.waitForSelector('#rules-dialog[open] li');
    await friend.click('#rules-dialog [data-close]');
    console.log('  ok  rules reference opens for a guest');

    // Host picks War (2 players) and starts it.
    await host.click('[data-a=select-game][data-game=war]');
    await host.click('[data-a=start]');
    await friend.waitForSelector('text=War');
    console.log('  ok  both players see the game start');

    // Play the game out: both players flip until it's over.
    const deadline = Date.now() + 90000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('War did not finish in time');
      if (await host.$('[data-a=end-game].primary')) break; // "Back to lobby" appears when it's over
      for (const p of [host, friend]) {
        const btn = await p.$('[data-a=war-flip]:not([disabled])');
        if (btn) await btn.click({ timeout: 500 }).catch(() => {});
      }
    }
    await friend.waitForSelector('[data-a=end-game].primary');
    console.log('  ok  a full game finishes and both see the result');

    // A friend's refresh puts them back in the same seat.
    await friend.reload();
    await friend.fill('#name', 'Bob').catch(() => {});
    await friend.click('button[type=submit]').catch(() => {});
    await friend.waitForSelector('.room-code');
    assert.strictEqual((await friend.textContent('.room-code')).trim(), code);
    console.log('  ok  refreshing rejoins the same room');

    const serious = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket/i.test(e));
    assert.deepStrictEqual(serious, [], `browser console errors:\n${serious.join('\n')}`);
    console.log('  ok  no console errors');
  } catch (e) {
    console.error('  FAIL', e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
})();
