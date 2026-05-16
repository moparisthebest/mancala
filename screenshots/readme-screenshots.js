#!/usr/bin/env node

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9878;
const BASE = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = __dirname;
const APP_URL = `http://127.0.0.1:${PORT}/index.html#name=device1&addr=device1@local.host`;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const requestPath = (req.url || '/').split('?')[0];
      const filePath = path.join(BASE, requestPath === '/' ? 'index.html' : requestPath);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function preparePage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
  await page.goto(APP_URL, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    const candidates = Array.from(document.body.querySelectorAll('*'));
    for (const el of candidates) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const style = getComputedStyle(el);
      if (style.position === 'fixed' && (text.includes('webxdc dev tools') || (text.includes('Add Peer') && text.includes('Reset')))) {
        el.remove();
      }
    }
  });
  await sleep(100);
  return page;
}

async function capture(browser, fileName, setup, verify) {
  const page = await preparePage(browser);
  try {
    if (setup) await setup(page);
    await sleep(150);
    const verified = await verify(page);
    if (!verified.ok) {
      throw new Error(`${fileName}: ${verified.reason}`);
    }
    const output = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: output });
    console.log(`Saved ${fileName}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await capture(
      browser,
      'landing-screen.png',
      null,
      async (page) => page.evaluate(() => ({
        ok: document.getElementById('join-screen').style.display !== 'none'
          && document.getElementById('game-screen').style.display !== 'block'
          && !document.getElementById('game-menu').classList.contains('open')
          && document.querySelector('#join-screen .join-title').textContent === 'Mancala',
        reason: 'expected join screen with title visible and no overlays open',
      }))
    );

    await capture(
      browser,
      'board-in-play.png',
      async (page) => {
        await page.evaluate(() => document.getElementById('hotseat-btn').click());
        await sleep(120);
        await page.evaluate(() => {
          state.player1 = { addr: '__hotseat_red__', name: 'Red' };
          state.player2 = { addr: '__hotseat_green__', name: 'Green' };
          state.pits = [
            [0, 5, 1, 7, 2, 0],
            [3, 0, 6, 1, 4, 2],
          ];
          state.stores = [9, 8];
          state.currentPlayer = 1;
          state.gameOver = false;
          render();
        });
      },
      async (page) => page.evaluate(() => ({
        ok: document.getElementById('join-screen').style.display === 'none'
          && document.getElementById('game-screen').style.display === 'block'
          && !document.getElementById('game-menu').classList.contains('open')
          && document.getElementById('winner-banner').textContent === '',
        reason: 'expected in-game board state with no menu overlay or winner banner',
      }))
    );

    await capture(
      browser,
      'about-screen.png',
      async (page) => {
        await page.evaluate(() => {
          document.getElementById('menu-open-btn').click();
          document.getElementById('menu-about').click();
        });
      },
      async (page) => page.evaluate(() => ({
        ok: document.getElementById('game-menu').classList.contains('open')
          && !document.getElementById('menu-about-sheet').classList.contains('hidden')
          && document.querySelector('#menu-about-sheet h2').textContent === 'About',
        reason: 'expected About view to be open',
      }))
    );

    await capture(
      browser,
      'how-to-play-screen.png',
      async (page) => {
        await page.evaluate(() => document.getElementById('join-how-to-play-btn').click());
      },
      async (page) => page.evaluate(() => ({
        ok: document.getElementById('game-menu').classList.contains('open')
          && !document.getElementById('menu-howto-sheet').classList.contains('hidden')
          && document.querySelector('#menu-howto-sheet h2').textContent === 'How to Play',
        reason: 'expected How to Play view to be open',
      }))
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
