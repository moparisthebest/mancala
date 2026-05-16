#!/usr/bin/env node
// screenshot.js — Take a screenshot of the Mancala board with custom pit/store values.
//
// Usage:
//   node screenshot.js <output.png> <bottom0..5> <top0..5> [<store0> <store1>]
//
// Examples:
//   node screenshot.js board-1-12.png 1 2 3 4 5 6 7 8 9 10 11 12
//   node screenshot.js stores-24.png 0 0 0 0 0 0 0 0 0 0 0 0 24 24
//   node screenshot.js store-48.png 0 0 0 0 0 0 0 0 0 0 0 0 48 0
//
// The first 6 numbers are the bottom row (left-to-right), the next 6 are
// the top row (left-to-right as stored, displayed right-to-left per Mancala
// convention). Optional last 2 numbers are store values (bottom, top).

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9877;
const BASE = path.resolve(__dirname, '..');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(BASE, req.url === '/' ? 'index.html' : req.url);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(PORT, () => resolve(server));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function takeScreenshot() {
  const args = process.argv.slice(2);
  if (args.length < 13) {
    console.error('Usage: node screenshot.js <output.png> <bottom0..5> <top0..5> [<store0> <store1>]');
    console.error('Examples:');
    console.error('  node screenshot.js board-1-12.png 1 2 3 4 5 6 7 8 9 10 11 12');
    console.error('  node screenshot.js stores-24.png 0 0 0 0 0 0 0 0 0 0 0 0 24 24');
    process.exit(1);
  }

  const outputFile = args[0];
  const bottom = args.slice(1, 7).map(Number);
  const top = args.slice(7, 13).map(Number);
  const store0 = args.length >= 14 ? Number(args[13]) : 0;
  const store1 = args.length >= 15 ? Number(args[14]) : 0;

  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 700 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(500);

  // Clear localStorage and reload to avoid stale state
  await page.evaluate(() => localStorage.clear());
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(500);

  // Start hotseat mode (bottomIdx=1, topIdx=0)
  await page.evaluate(() => document.querySelector('#hotseat-btn').click());
  await sleep(500);

  // Set pit and store values
  // In hotseat mode: bottomIdx=1 (Green), topIdx=0 (Red)
  // So state.pits[0] = top row, state.pits[1] = bottom row
  // stores[0] = Red (top/left store), stores[1] = Green (bottom/right store)
  await page.evaluate((b, t, s0, s1) => {
    state.pits = [t, b];
    state.stores = [s0, s1];
    render();
  }, bottom, top, store0, store1);
  await sleep(500);

  await page.screenshot({ path: outputFile, fullPage: false });
  console.log('Screenshot saved to ' + outputFile);

  await browser.close();
  server.close();
}

takeScreenshot().catch(e => { console.error(e); process.exit(1); });
