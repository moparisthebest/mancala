const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9876;
const BASE = path.resolve(__dirname);
const TEST_DEFAULT_SETTINGS = Object.freeze({
  displayMode: 'marbles',
  animSpeed: '0',
  boardRotation: 'auto',
  boardSizePercent: '100',
  showHud: 'false',
  showMenuButton: 'true',
});

// Simple static file server
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const requestPath = (req.url || '/').split('?')[0];
      const isPlainPath = requestPath.startsWith('/plain/');
      const relativePath = isPlainPath ? requestPath.slice('/plain'.length) : requestPath;
      if (isPlainPath && relativePath === '/webxdc.js') {
        res.writeHead(404);
        res.end();
        return;
      }
      let filePath = path.join(BASE, relativePath === '/' ? 'index.html' : relativePath);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const types = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.png': 'image/png',
        '.webmanifest': 'application/manifest+json',
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(PORT, () => resolve(server));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function configurePageSettings(page, overrides = {}, options = {}) {
  const settings = { ...TEST_DEFAULT_SETTINGS, ...overrides };
  const payload = {
    settings,
    preserveUpdatesKey: Boolean(options.preserveUpdatesKey),
    forcedRandom: options.forcedRandom,
  };
  const applySettings = (config) => {
    const storageKeys = {
      displayMode: 'mancala-displayMode',
      animSpeed: 'mancala-animSpeed',
      boardRotation: 'mancala-boardRotation',
      boardSizePercent: 'mancala-boardSizePercent',
      showHud: 'mancala-showHud',
      showMenuButton: 'mancala-showMenuButton',
    };
    const updatesKey = '__xdcUpdatesKey__';
    for (const [name, value] of Object.entries(config.settings)) {
      const key = storageKeys[name];
      if (!key) continue;
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    }
    if (!config.preserveUpdatesKey) {
      localStorage.removeItem(updatesKey);
    }
    if (typeof config.forcedRandom === 'number') {
      Math.random = () => config.forcedRandom;
    }
    if (typeof reloadLocalSettingsFromStorage === 'function') {
      reloadLocalSettingsFromStorage();
    }
  };
  if (options.beforeNavigation) {
    await page.evaluateOnNewDocument(applySettings, payload);
    return;
  }
  await page.evaluate(applySettings, payload);
}

async function runTests() {
  const server = await startServer();
  console.log(`Server running on port ${PORT}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else { failed++; console.log(`  FAIL: ${msg}`); }
  }

  try {
    // =========================================================
    // Player 1 (device0) opens the game
    // =========================================================
    console.log('\n=== Player 1 opens the game ===');
    const page1 = await browser.newPage();
    page1.on('console', m => console.log(`    [P1] ${m.text()}`));
    page1.on('pageerror', e => console.log(`    [P1 ERROR] ${e.message}`));

    await page1.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await configurePageSettings(page1);
    await page1.evaluate(() => render());

    // Check join screen is visible
    const joinScreenVisible = await page1.$eval('#join-screen', el => el.style.display !== 'none');
    assert(joinScreenVisible, 'Join screen is visible for P1');

    const gameScreenHidden = await page1.$eval('#game-screen', el => el.style.display === 'none' || el.style.display === '');
    assert(gameScreenHidden, 'Game screen is hidden initially');

    const landingIntro = await page1.evaluate(() => ({
      title: document.querySelector('#join-screen .join-title').textContent,
      howToText: document.getElementById('join-how-to-play-btn').textContent,
      titleIcons: Array.from(document.querySelectorAll('#join-screen .join-title-icon')).map(el => el.getAttribute('src')),
    }));
    assert(landingIntro.title === 'Mancala', `Landing page shows the game title: "${landingIntro.title}"`);
    assert(landingIntro.howToText === 'How to Play', `Landing page exposes a How to Play button: "${landingIntro.howToText}"`);
    assert(landingIntro.titleIcons.length === 2 && landingIntro.titleIcons.every(src => src === 'icon.png'),
      `Landing page title uses packaged icon assets: ${landingIntro.titleIcons.join(', ')}`);

    await page1.evaluate(() => document.getElementById('join-how-to-play-btn').click());
    await sleep(200);
    const landingHowToState = await page1.evaluate(() => ({
      menuOpen: document.getElementById('game-menu').classList.contains('open'),
      howToVisible: !document.getElementById('menu-howto-sheet').classList.contains('hidden'),
      title: document.querySelector('#menu-howto-sheet h2').textContent,
      closeLabel: document.getElementById('menu-open-btn').getAttribute('aria-label'),
    }));
    assert(landingHowToState.menuOpen, 'Landing page How to Play button opens the overlay');
    assert(landingHowToState.howToVisible, 'Landing page How to Play button opens the rules view directly');
    assert(landingHowToState.title === 'How to Play', `Landing page How to Play view title is correct: "${landingHowToState.title}"`);
    assert(landingHowToState.closeLabel === 'Close how to play',
      `Landing page How to Play uses a close-to-landing label: "${landingHowToState.closeLabel}"`);
    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(120);
    const landingHowToClosed = await page1.evaluate(() => ({
      menuOpen: document.getElementById('game-menu').classList.contains('open'),
      howToVisible: !document.getElementById('menu-howto-sheet').classList.contains('hidden'),
    }));
    assert(!landingHowToClosed.menuOpen && !landingHowToClosed.howToVisible,
      'Closing How to Play from the landing screen returns to the landing screen instead of the menu');

    const pregameMenuButton = await page1.evaluate(() => {
      const btn = document.getElementById('menu-open-btn');
      return {
        display: getComputedStyle(btn).display,
        text: btn.textContent,
        ariaLabel: btn.getAttribute('aria-label'),
      };
    });
    assert(pregameMenuButton.display !== 'none', `Menu button is visible on the join screen: ${pregameMenuButton.display}`);
    assert(pregameMenuButton.text === '⚙', `Join screen menu button uses the gear icon: "${pregameMenuButton.text}"`);
    assert(pregameMenuButton.ariaLabel === 'Open menu', `Join screen menu button has accessible label: "${pregameMenuButton.ariaLabel}"`);

    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    const pregameMenuState = await page1.evaluate(() => ({
      menuOpen: document.getElementById('game-menu').classList.contains('open'),
      quitDisplay: getComputedStyle(document.getElementById('menu-quit')).display,
      howToText: document.getElementById('menu-how-to-play').textContent,
      aboutText: document.getElementById('menu-about').textContent,
    }));
    assert(pregameMenuState.menuOpen, 'Menu button opens the menu before a game starts');
    assert(pregameMenuState.quitDisplay === 'none', `Quit button is hidden before a game starts: ${pregameMenuState.quitDisplay}`);
    assert(pregameMenuState.howToText === 'How to Play',
      `Pregame menu exposes the How to Play action: "${pregameMenuState.howToText}"`);
    assert(pregameMenuState.aboutText === 'About',
      `Pregame menu exposes the About action: "${pregameMenuState.aboutText}"`);
    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);

    // Check slots show "waiting"
    const slot1Text = await page1.$eval('#slot1', el => el.textContent);
    assert(slot1Text.includes('waiting'), `Slot 1 shows waiting: "${slot1Text}"`);

    // Join button visible
    const joinBtnVisible = await page1.$eval('#join-btn', el => el.style.display !== 'none');
    assert(joinBtnVisible, 'Join button is visible');

    const localModeButtons = await page1.evaluate(() => ({
      hotseat: document.getElementById('hotseat-btn').textContent,
      playerVsCpu: document.getElementById('player-vs-cpu-btn').textContent,
      cpuVsCpu: document.getElementById('cpu-vs-cpu-btn').textContent,
    }));
    assert(localModeButtons.hotseat === '2 Players 1 Screen', `Hotseat button text: "${localModeButtons.hotseat}"`);
    assert(localModeButtons.playerVsCpu === 'Player vs CPU', `Player vs CPU button text: "${localModeButtons.playerVsCpu}"`);
    assert(localModeButtons.cpuVsCpu === 'CPU vs CPU', `CPU vs CPU button text: "${localModeButtons.cpuVsCpu}"`);

    // =========================================================
    // Plain web fallback: no webxdc.js
    // =========================================================
    console.log('\n=== Plain web fallback: local modes without webxdc ===');
    const plainErrors = [];
    const pagePlain = await browser.newPage();
    pagePlain.on('console', m => console.log(`    [PLAIN] ${m.text()}`));
    pagePlain.on('pageerror', e => {
      plainErrors.push(e.message);
      console.log(`    [PLAIN ERROR] ${e.message}`);
    });
    await configurePageSettings(pagePlain, {}, { beforeNavigation: true });
    await pagePlain.goto(`http://localhost:${PORT}/plain/index.html`, { waitUntil: 'networkidle0' });
    await pagePlain.waitForFunction(() => Boolean(window.pwaServiceWorkerRegistration || window.pwaServiceWorkerRegistrationError), { timeout: 15000 });
    await sleep(200);
    const plainJoinScreen = await pagePlain.evaluate(async () => {
      const manifestLink = document.querySelector('link[rel="manifest"]');
      const iconLink = document.querySelector('link[rel="icon"]');
      const appleTouchIconLink = document.querySelector('link[rel="apple-touch-icon"]');
      const registrations = await navigator.serviceWorker.getRegistrations();
      return {
        webxdcAvailable: isWebxdcAvailable(),
        title: document.querySelector('#join-screen .join-title').textContent,
        howToText: document.getElementById('join-how-to-play-btn').textContent,
        intro: document.getElementById('join-intro').textContent,
        joinBtnDisplay: getComputedStyle(document.getElementById('join-btn')).display,
        slot1Display: getComputedStyle(document.getElementById('slot1')).display,
        slot2Display: getComputedStyle(document.getElementById('slot2')).display,
        hotseatDisplay: getComputedStyle(document.getElementById('hotseat-btn')).display,
        pvcpuDisplay: getComputedStyle(document.getElementById('player-vs-cpu-btn')).display,
        cvcpuDisplay: getComputedStyle(document.getElementById('cpu-vs-cpu-btn')).display,
        manifestHref: manifestLink && manifestLink.getAttribute('href'),
        iconHref: iconLink && iconLink.getAttribute('href'),
        appleTouchIconHref: appleTouchIconLink && appleTouchIconLink.getAttribute('href'),
        pwaRegistered: Boolean(window.pwaServiceWorkerRegistration),
        pwaError: window.pwaServiceWorkerRegistrationError,
        registrationCount: registrations.length,
      };
    });
    assert(!plainJoinScreen.webxdcAvailable, 'Plain web path detects that webxdc is unavailable');
    assert(plainJoinScreen.title === 'Mancala', `Plain web path still shows the game title: "${plainJoinScreen.title}"`);
    assert(plainJoinScreen.howToText === 'How to Play', `Plain web path still shows the How to Play button: "${plainJoinScreen.howToText}"`);
    assert(plainJoinScreen.intro === 'Local play only in this browser. Choose a mode to start.',
      `Plain web path shows local-only join copy: "${plainJoinScreen.intro}"`);
    assert(plainJoinScreen.joinBtnDisplay === 'none',
      `Plain web path hides Join Game: ${plainJoinScreen.joinBtnDisplay}`);
    assert(plainJoinScreen.slot1Display === 'none' && plainJoinScreen.slot2Display === 'none',
      `Plain web path hides the online seat slots: slot1=${plainJoinScreen.slot1Display}, slot2=${plainJoinScreen.slot2Display}`);
    assert(plainJoinScreen.hotseatDisplay !== 'none' && plainJoinScreen.pvcpuDisplay !== 'none' && plainJoinScreen.cvcpuDisplay !== 'none',
      `Plain web path keeps local mode buttons visible: hotseat=${plainJoinScreen.hotseatDisplay}, pvcpu=${plainJoinScreen.pvcpuDisplay}, cvcpu=${plainJoinScreen.cvcpuDisplay}`);
    assert(plainJoinScreen.manifestHref === 'manifest.webmanifest',
      `Plain web path includes the web app manifest link: "${plainJoinScreen.manifestHref}"`);
    assert(plainJoinScreen.iconHref === 'icon.png',
      `Plain web path includes the favicon link: "${plainJoinScreen.iconHref}"`);
    assert(plainJoinScreen.appleTouchIconHref === 'icon-192.png',
      `Plain web path includes the touch icon link: "${plainJoinScreen.appleTouchIconHref}"`);
    assert(plainJoinScreen.pwaRegistered && plainJoinScreen.registrationCount > 0,
      `Plain web path registers a service worker for PWA installability: registered=${plainJoinScreen.pwaRegistered}, count=${plainJoinScreen.registrationCount}, error="${plainJoinScreen.pwaError}"`);
    assert(plainErrors.length === 0, `Plain web path loads without runtime page errors: ${plainErrors.join(' | ')}`);

    await pagePlain.evaluate(() => {
      document.getElementById('menu-open-btn').click();
      document.getElementById('menu-about').click();
    });
    await sleep(120);
    const plainAboutView = await pagePlain.evaluate(() => ({
      title: document.querySelector('#menu-about-sheet h2').textContent,
      aboutVisible: !document.getElementById('menu-about-sheet').classList.contains('hidden'),
      xdcText: document.getElementById('about-xdc-link').textContent,
      xdcHref: document.getElementById('about-xdc-link').getAttribute('href'),
    }));
    assert(plainAboutView.title === 'About', `Plain web About view title is correct: "${plainAboutView.title}"`);
    assert(plainAboutView.aboutVisible, 'Plain web About view opens from the menu');
    assert(plainAboutView.xdcText === 'here',
      `Plain web About view hotlinks the word here: "${plainAboutView.xdcText}"`);
    assert(plainAboutView.xdcHref === './mancala.xdc',
      `Plain web About view uses the local mancala.xdc link: "${plainAboutView.xdcHref}"`);
    await pagePlain.evaluate(() => closeMenu());
    await sleep(80);

    await pagePlain.click('#hotseat-btn');
    await sleep(120);
    const plainHotseat = await pagePlain.evaluate(() => ({
      gameVisible: document.getElementById('game-screen').style.display === 'block',
      player1: state.player1 && state.player1.name,
      player2: state.player2 && state.player2.name,
      currentPlayer: state.currentPlayer,
    }));
    assert(plainHotseat.gameVisible, 'Plain web path can start a hotseat game');
    assert(plainHotseat.player1 === 'Red' && plainHotseat.player2 === 'Green',
      `Plain web hotseat uses the normal local player names: ${plainHotseat.player1} vs ${plainHotseat.player2}`);
    assert(plainHotseat.currentPlayer === 0, `Plain web hotseat starts with player 1's turn: ${plainHotseat.currentPlayer}`);
    await pagePlain.close();

    const pagePlainCpu = await browser.newPage();
    pagePlainCpu.on('console', m => console.log(`    [PLAIN CPU] ${m.text()}`));
    pagePlainCpu.on('pageerror', e => console.log(`    [PLAIN CPU ERROR] ${e.message}`));
    await configurePageSettings(pagePlainCpu, {}, { beforeNavigation: true });
    await pagePlainCpu.goto(`http://localhost:${PORT}/plain/index.html`, { waitUntil: 'networkidle0' });
    await pagePlainCpu.evaluate(() => {
      cpuTurnDelayMs = 0;
      document.getElementById('player-vs-cpu-btn').click();
    });
    await sleep(120);
    const plainCpuSetup = await pagePlainCpu.evaluate(() => ({
      open: document.getElementById('cpu-setup-overlay').classList.contains('open'),
      bobBtn: document.getElementById('cpu-select-bob').textContent,
    }));
    assert(plainCpuSetup.open, 'Plain web path can open the Player vs CPU chooser');
    assert(plainCpuSetup.bobBtn === 'Choose Bob', `Plain web Player vs CPU chooser still lists CPUs: "${plainCpuSetup.bobBtn}"`);
    await pagePlainCpu.evaluate(() => document.getElementById('cpu-select-bob').click());
    await sleep(120);
    await pagePlainCpu.evaluate(() => document.getElementById('cpu-setup-human-first-btn').click());
    await pagePlainCpu.waitForFunction(() => state.player1 && state.player2 && state.player2.name === 'You' && state.currentPlayer === 1, { timeout: 15000 });
    const plainCpuGame = await pagePlainCpu.evaluate(() => ({
      gameVisible: document.getElementById('game-screen').style.display === 'block',
      topName: state.player1 && state.player1.name,
      bottomName: state.player2 && state.player2.name,
      status: document.getElementById('status').textContent,
    }));
    assert(plainCpuGame.gameVisible, 'Plain web path can start Player vs CPU');
    assert(plainCpuGame.topName === 'Bob' && plainCpuGame.bottomName === 'You',
      `Plain web Player vs CPU uses Bob vs You: ${plainCpuGame.topName} vs ${plainCpuGame.bottomName}`);
    assert(plainCpuGame.status === 'Your turn!', `Plain web Player vs CPU still hands control to the human: "${plainCpuGame.status}"`);
    await pagePlainCpu.close();

    // =========================================================
    // Player 1 joins
    // =========================================================
    console.log('\n=== Player 1 clicks Join ===');
    await page1.click('#join-btn');
    await sleep(500);

    const slot1After = await page1.$eval('#slot1', el => el.textContent);
    assert(slot1After.includes('device0'), `Slot 1 shows device0: "${slot1After}"`);

    const joinStatus = await page1.$eval('#join-status', el => el.textContent);
    assert(joinStatus.includes('Player 1'), `Join status says Player 1: "${joinStatus}"`);

    // Game screen should still be hidden (waiting for P2)
    const gameStillHidden = await page1.$eval('#game-screen', el => el.style.display === 'none' || el.style.display === '');
    assert(gameStillHidden, 'Game screen still hidden (waiting for P2)');

    // =========================================================
    // Player 2 opens the game (simulated via URL hash)
    // =========================================================
    console.log('\n=== Player 2 opens the game ===');
    const page2 = await browser.newPage();
    page2.on('console', m => console.log(`    [P2] ${m.text()}`));
    page2.on('pageerror', e => console.log(`    [P2 ERROR] ${e.message}`));

    await page2.goto(`http://localhost:${PORT}/index.html#name=device1&addr=device1@local.host`, { waitUntil: 'networkidle0' });
    await configurePageSettings(page2, {}, { preserveUpdatesKey: true });
    await page2.evaluate(() => render());
    await sleep(500);

    // P2 should see P1 already joined (via localStorage replay)
    const p2slot1 = await page2.$eval('#slot1', el => el.textContent);
    assert(p2slot1.includes('device0'), `P2 sees P1 in slot 1: "${p2slot1}"`);

    // P2 joins
    console.log('\n=== Player 2 clicks Join ===');
    await page2.click('#join-btn');
    await sleep(500);

    // Both pages should now show the game screen
    const p1gameVisible = await page1.$eval('#game-screen', el => el.style.display === 'block');
    // P1 needs a storage event to update — let's wait a bit more
    await sleep(500);
    const p1gameVisible2 = await page1.$eval('#game-screen', el => el.style.display === 'block');
    assert(p1gameVisible2, 'P1 sees game screen after P2 joins');

    const p2gameVisible = await page2.$eval('#game-screen', el => el.style.display === 'block');
    assert(p2gameVisible, 'P2 sees game screen after joining');

    const initialHudHidden = await page1.evaluate(() => ({
      status: getComputedStyle(document.getElementById('status')).display,
      scoreboard: getComputedStyle(document.getElementById('scoreboard')).display,
    }));
    assert(initialHudHidden.status === 'none', `Turn indicator is hidden by default: ${initialHudHidden.status}`);
    assert(initialHudHidden.scoreboard === 'none', `Scores are hidden by default: ${initialHudHidden.scoreboard}`);

    // =========================================================
    // Verify initial board state (default: marble mode)
    // =========================================================
    console.log('\n=== Verify initial board (marble mode) ===');

    // In marble mode, pits show marble divs instead of text numbers.
    // Helper: count marbles in each pit to get seed count.
    const p1bottomMarbles = await page1.$$eval('#bottom-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    assert(p1bottomMarbles.length === 6, `P1 bottom row has 6 pits: ${p1bottomMarbles.length}`);
    assert(p1bottomMarbles.every(v => v === 4), `P1 bottom pits all have 4 marbles: [${p1bottomMarbles}]`);

    const p1topMarbles = await page1.$$eval('#top-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    assert(p1topMarbles.length === 6, `P1 top row has 6 pits: ${p1topMarbles.length}`);
    assert(p1topMarbles.every(v => v === 4), `P1 top pits all have 4 marbles: [${p1topMarbles}]`);

    // Stores should have 0 marbles
    const p1storeBottomMarbles = await page1.$eval('#store-bottom', el => el.querySelectorAll('.marble').length);
    const p1storeTopMarbles = await page1.$eval('#store-top', el => el.querySelectorAll('.marble').length);
    assert(p1storeBottomMarbles === 0, `P1 own store has 0 marbles: ${p1storeBottomMarbles}`);
    assert(p1storeTopMarbles === 0, `P1 opponent store has 0 marbles: ${p1storeTopMarbles}`);

    // Verify marble containers exist (confirms marble mode is default)
    const hasMarblesContainer = await page1.$eval('#bottom-row .pit', el => el.querySelector('.marbles') !== null);
    assert(hasMarblesContainer, 'Marble mode is default (marbles container exists)');

    // Verify marbles have color classes (mc-0 through mc-4)
    const marbleClasses = await page1.$$eval('#bottom-row .marble', marbles =>
      marbles.map(m => {
        for (let i = 0; i < 5; i++) {
          if (m.classList.contains('mc-' + i)) return 'mc-' + i;
        }
        return 'none';
      }));
    assert(marbleClasses.length === 24, `24 marbles on bottom row: ${marbleClasses.length}`);
    assert(marbleClasses.every(c => c.startsWith('mc-')), 'All marbles have a color class');

    // Verify multiple colors are used (not all the same)
    const uniqueColors = new Set(marbleClasses);
    assert(uniqueColors.size > 1, `Multiple marble colors used: ${uniqueColors.size} unique classes`);

    // Verify marble colors are synced across players (same seed)
    // P1's top row shows player 1's pits (reversed: pit 5,4,3,2,1,0)
    // P2's bottom row shows player 1's pits (normal: pit 0,1,2,3,4,5)
    // Compare per-pit with reversal to confirm same colors
    const p1topByPit = await page1.$$eval('#top-row .pit', pits =>
      pits.map(p => [...p.querySelectorAll('.marble')].map(m => {
        for (let i = 0; i < 5; i++) {
          if (m.classList.contains('mc-' + i)) return 'mc-' + i;
        }
        return 'none';
      })));
    const p2bottomByPit = await page2.$$eval('#bottom-row .pit', pits =>
      pits.map(p => [...p.querySelectorAll('.marble')].map(m => {
        for (let i = 0; i < 5; i++) {
          if (m.classList.contains('mc-' + i)) return 'mc-' + i;
        }
        return 'none';
      })));
    // P1 top row is reversed, so reverse it to align with P2 bottom
    const p1topReversed = [...p1topByPit].reverse();
    const colorsMatch = JSON.stringify(p1topReversed) === JSON.stringify(p2bottomByPit);
    assert(colorsMatch, 'Marble colors are identical across players (synced seed)');

    // Verify P2's board is literally P1's board rotated 180°.
    // Take P1's entire board (all marble bounding rects relative to the board),
    // rotate every point 180° around the board center, and it should exactly
    // match P2's board.
    function getBoardMarbles(page) {
      return page.evaluate(() => {
        const board = document.querySelector('.board');
        const br = board.getBoundingClientRect();
        const marbles = [...board.querySelectorAll('.marble')];
        return {
          boardW: br.width, boardH: br.height,
          marbles: marbles.map(m => {
            const mr = m.getBoundingClientRect();
            let colorClass = 'none';
            for (let i = 0; i < 5; i++) {
              if (m.classList.contains('mc-' + i)) { colorClass = 'mc-' + i; break; }
            }
            return {
              cx: ((mr.left + mr.right) / 2 - br.left) / br.width,
              cy: ((mr.top + mr.bottom) / 2 - br.top) / br.height,
              bg: colorClass,
            };
          }),
        };
      });
    }
    const p1board = await getBoardMarbles(page1);
    const p2board = await getBoardMarbles(page2);
    // Rotate P1's marbles 180°: (cx, cy) -> (1-cx, 1-cy)
    const p1rotated = p1board.marbles.map(m => ({
      cx: 1 - m.cx,
      cy: 1 - m.cy,
      bg: m.bg,
    }));
    const sortMarbles = marbles => marbles.slice().sort((a, b) =>
      a.bg.localeCompare(b.bg)
      || a.cx - b.cx
      || a.cy - b.cy);
    const p1sorted = sortMarbles(p1rotated);
    const p2sorted = sortMarbles(p2board.marbles);
    const mirrorOk = p1sorted.length === p2sorted.length
      && p1sorted.every((m, i) =>
        m.bg === p2sorted[i].bg
        && Math.abs(m.cx - p2sorted[i].cx) <= 0.02
        && Math.abs(m.cy - p2sorted[i].cy) <= 0.02);
    assert(mirrorOk, 'P2 board is P1 board rotated 180 degrees');

    // Status should say "Your turn" for P1
    const p1status = await page1.$eval('#status', el => el.textContent);
    assert(p1status.includes('Your turn'), `P1 status says Your turn: "${p1status}"`);

    // P2 should say "Waiting"
    const p2status = await page2.$eval('#status', el => el.textContent);
    assert(p2status.includes('Waiting'), `P2 status says Waiting: "${p2status}"`);

    // P1's bottom pits should be clickable
    const p1clickable = await page1.$$eval('#bottom-row .pit.clickable', pits => pits.length);
    assert(p1clickable === 6, `P1 has 6 clickable pits: ${p1clickable}`);

    // P2's bottom pits should be disabled (not their turn)
    const p2clickable = await page2.$$eval('#bottom-row .pit.clickable', pits => pits.length);
    assert(p2clickable === 0, `P2 has 0 clickable pits (not their turn): ${p2clickable}`);

    await page1.evaluate(() => {
      window.__sentUpdates = [];
      const origSend = window.webxdc.sendUpdate;
      window.webxdc.sendUpdate = function(update, desc) {
        window.__sentUpdates.push(update);
        return origSend.call(window.webxdc, update, desc);
      };
    });

    // =========================================================
    // Toggle to numbers mode by clicking a store
    // =========================================================
    console.log('\n=== Toggle display mode ===');

    // Click the bottom store to toggle to numbers
    await page1.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(300);

    // Now pits should show text numbers, not marbles
    const afterToggleMarblesHidden = await page1.$eval('#bottom-row .pit', el => {
      const marbles = el.querySelector('.marbles');
      return !!marbles && getComputedStyle(marbles).display === 'none';
    });
    assert(afterToggleMarblesHidden, 'After toggle: pits hide marble containers');

    const afterToggleText = await page1.$$eval('#bottom-row .pit', pits => pits.map(p => p.textContent));
    assert(afterToggleText.every(v => /^\d+$/.test(v)), `After toggle: pits show numeric text: [${afterToggleText}]`);

    // P2 should still be in marble mode (toggle is local-only)
    const p2stillMarbles = await page2.$eval('#bottom-row .pit', el => el.querySelector('.marbles') !== null);
    assert(p2stillMarbles, 'P2 still in marble mode (toggle is local-only)');

    // Toggle back by clicking the top store
    await page1.evaluate(() => document.getElementById('store-top').click());
    await sleep(300);

    const backToMarbles = await page1.$eval('#bottom-row .pit', el => el.querySelector('.marbles') !== null);
    assert(backToMarbles, 'After second toggle: back to marble mode');
    const noPitTextAfterToggleBack = await page1.$$eval('#top-row .pit, #bottom-row .pit', pits =>
      pits.every(pit => [...pit.childNodes].every(node =>
        node.nodeType !== Node.TEXT_NODE || node.textContent.trim() === '')));
    assert(noPitTextAfterToggleBack, 'After second toggle: pits have no leftover number text nodes');

    // =========================================================
    // Player 1 makes a move (click pit index 2 for extra turn)
    // =========================================================
    console.log('\n=== P1 makes move: pit 2 (extra turn) ===');

    // Use evaluate to click the 3rd pit in the bottom row (avoids stale handles)
    await page1.evaluate(() => {
      document.querySelectorAll('#bottom-row .pit')[2].click();
    });
    await sleep(500);

    // P1 should get extra turn (pit 2 has 4 seeds: pit3, pit4, pit5, store)
    const p1statusAfter = await page1.$eval('#status', el => el.textContent);
    assert(p1statusAfter.includes('Your turn'), `P1 gets extra turn: "${p1statusAfter}"`);

    const moveUpdate = await page1.evaluate(() => window.__sentUpdates[window.__sentUpdates.length - 1]);
    assert(moveUpdate.payload.type === 'move', `Online move still sends a move payload: "${moveUpdate.payload.type}"`);
    assert(!Object.prototype.hasOwnProperty.call(moveUpdate, 'info') || moveUpdate.info == null,
      `Normal online move no longer sends a chat info message: ${JSON.stringify(moveUpdate.info)}`);
    assert(moveUpdate.summary === 'device0 1 - 0 device1',
      `Normal online move still updates the score summary: "${moveUpdate.summary}"`);

    // Store should now have 1 marble
    const p1storeAfterMarbles = await page1.$eval('#store-bottom', el => el.querySelectorAll('.marble').length);
    assert(p1storeAfterMarbles === 1, `P1 store has 1 marble after extra turn move: ${p1storeAfterMarbles}`);

    // Pit 2 should have 0 marbles, pit 3 should have 5
    const p1bottomAfter = await page1.$$eval('#bottom-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    assert(p1bottomAfter[2] === 0, `P1 pit 2 has 0 marbles: ${p1bottomAfter[2]}`);
    assert(p1bottomAfter[3] === 5, `P1 pit 3 has 5 marbles: ${p1bottomAfter[3]}`);

    // P2 should also see the updated board (via localStorage event)
    await sleep(500);
    const p2storeOpponentMarbles = await page2.$eval('#store-top', el => el.querySelectorAll('.marble').length);
    assert(p2storeOpponentMarbles === 1, `P2 sees opponent store with 1 marble: ${p2storeOpponentMarbles}`);

    // =========================================================
    // P1 makes another move (pit 0, should pass turn to P2)
    // =========================================================
    console.log('\n=== P1 makes move: pit 0 (pass turn) ===');
    await page1.evaluate(() => {
      document.querySelectorAll('#bottom-row .pit')[0].click();
    });
    await sleep(500);

    // Pit 0 has 4 seeds: lands on pit1,2,3,4 -> no extra turn
    const p1statusAfter2 = await page1.$eval('#status', el => el.textContent);
    assert(p1statusAfter2.includes('Waiting'), `P1 is now waiting: "${p1statusAfter2}"`);

    await sleep(500);
    const p2statusAfter = await page2.$eval('#status', el => el.textContent);
    assert(p2statusAfter.includes('Your turn'), `P2 now has turn: "${p2statusAfter}"`);

    // P2 should now have clickable pits
    const p2clickableAfter = await page2.$$eval('#bottom-row .pit.clickable', pits => pits.length);
    assert(p2clickableAfter > 0, `P2 has clickable pits: ${p2clickableAfter}`);

    // =========================================================
    // P2 makes a move
    // =========================================================
    console.log('\n=== P2 makes a move: pit 0 ===');
    await page2.evaluate(() => {
      document.querySelectorAll('#bottom-row .pit')[0].click();
    });
    await sleep(500);

    const p2statusAfter2 = await page2.$eval('#status', el => el.textContent);
    // Should pass turn to P1 (pit 0 has 4 seeds -> pit1,2,3,4, no store)
    assert(p2statusAfter2.includes('Waiting'), `P2 is now waiting: "${p2statusAfter2}"`);

    await sleep(500);
    const p1statusAfter3 = await page1.$eval('#status', el => el.textContent);
    assert(p1statusAfter3.includes('Your turn'), `P1 has turn back: "${p1statusAfter3}"`);

    // =========================================================
    // Verify seed conservation
    // =========================================================
    console.log('\n=== Verify seed conservation ===');
    const allP1bottom = await page1.$$eval('#bottom-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    const allP1top = await page1.$$eval('#top-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    const s1 = await page1.$eval('#store-bottom', el => el.querySelectorAll('.marble').length);
    const s2 = await page1.$eval('#store-top', el => el.querySelectorAll('.marble').length);
    const total = allP1bottom.reduce((a, b) => a + b, 0) + allP1top.reduce((a, b) => a + b, 0) + s1 + s2;
    assert(total === 48, `Total seeds conserved: ${total} (expected 48)`);

    // =========================================================
    // Verify board orientation (P2 sees own pits at bottom)
    // =========================================================
    console.log('\n=== Verify board orientation ===');
    // P1 bottom row should be P1's pits (mine class), top row should be opponent (theirs class)
    const p1bottomMine = await page1.$$eval('#bottom-row .pit.mine', pits => pits.length);
    assert(p1bottomMine === 6, `P1 bottom row pits have 'mine' class: ${p1bottomMine}`);

    const p1topTheirs = await page1.$$eval('#top-row .pit.theirs', pits => pits.length);
    assert(p1topTheirs === 6, `P1 top row pits have 'theirs' class: ${p1topTheirs}`);

    // P2 bottom row should also be 'mine' (their own pits)
    const p2bottomMine = await page2.$$eval('#bottom-row .pit.mine', pits => pits.length);
    assert(p2bottomMine === 6, `P2 bottom row pits have 'mine' class: ${p2bottomMine}`);

    // =========================================================
    // Verify numbers mode shows correct values
    // =========================================================
    console.log('\n=== Verify numbers mode values ===');

    // Switch P1 to numbers mode
    await page1.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(300);

    // Read numeric values and verify seed conservation in numbers mode
    const numBottom = await page1.$$eval('#bottom-row .pit', pits => pits.map(p => parseInt(p.textContent)));
    const numTop = await page1.$$eval('#top-row .pit', pits => pits.map(p => parseInt(p.textContent)));
    const numS1 = parseInt(await page1.$eval('#store-bottom-val', el => el.textContent));
    const numS2 = parseInt(await page1.$eval('#store-top-val', el => el.textContent));
    const numTotal = numBottom.reduce((a, b) => a + b, 0) + numTop.reduce((a, b) => a + b, 0) + numS1 + numS2;
    assert(numTotal === 48, `Seed conservation in numbers mode: ${numTotal} (expected 48)`);

    // Verify no marble elements exist in numbers mode
    const noMarbles = await page1.$eval('#bottom-row .pit', el => el.querySelector('.marble') === null);
    assert(noMarbles, 'Numbers mode has no marble elements');

    // Switch back to marbles for remaining tests
    await page1.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(300);

    // =========================================================
    // Marble overflow: pits with > 8 marbles spill outside
    // =========================================================
    console.log('\n=== Marble overflow behavior ===');

    // Inject a game state where one pit has many marbles
    await page1.evaluate(() => {
      let id = 0;
      const mk = (n) => Array.from({length: n}, () => id++);
      state.pits = [
        [mk(12), mk(3), mk(0), mk(0), mk(0), mk(0)],
        [mk(8), mk(7), mk(4), mk(2), mk(1), mk(0)],
      ];
      state.stores = [[0,1,2,3,4],[0,1,2,3,4,5]];
      render();
    });
    await sleep(300);

    // Pit with 12 marbles: should have 10 in .marbles and 2 in .marbles-overflow
    const overflowResult = await page1.evaluate(() => {
      // P1 is player 0, bottom row = player 0's pits
      const bottomPit0 = document.querySelectorAll('#bottom-row .pit')[0];
      const innerMarbles = bottomPit0.querySelector('.marbles');
      const overflowContainer = bottomPit0.querySelector('.marbles-overflow');
      return {
        innerCount: innerMarbles ? innerMarbles.querySelectorAll('.marble').length : 0,
        hasOverflow: overflowContainer !== null,
        overflowCount: overflowContainer ? overflowContainer.querySelectorAll('.marble').length : 0,
        overflowClass: overflowContainer ? overflowContainer.className : '',
        totalMarbles: bottomPit0.querySelectorAll('.marble').length,
      };
    });
    assert(overflowResult.innerCount === 10, `Pit with 12: inner has 10 marbles: ${overflowResult.innerCount}`);
    assert(overflowResult.hasOverflow, 'Pit with 12: overflow container exists');
    assert(overflowResult.overflowCount === 2, `Pit with 12: overflow has 2 marbles: ${overflowResult.overflowCount}`);
    assert(overflowResult.overflowClass.includes('overflow-bottom'), 'Bottom row pit overflows downward');
    assert(overflowResult.totalMarbles === 12, `Pit with 12: total marbles = 12: ${overflowResult.totalMarbles}`);

    // Pit with exactly 8: should have no overflow container
    const noOverflow8 = await page1.evaluate(() => {
      // Player 1's pits are the top row (opponent). pit index 0 has 8 marbles.
      // Top row is reversed, so pit[0] of player1 appears at position 5 (rightmost)
      const topPit5 = document.querySelectorAll('#top-row .pit')[5];
      return {
        innerCount: topPit5.querySelector('.marbles').querySelectorAll('.marble').length,
        hasOverflow: topPit5.querySelector('.marbles-overflow') !== null,
      };
    });
    assert(noOverflow8.innerCount === 8, `Pit with 8: all 8 marbles inside: ${noOverflow8.innerCount}`);
    assert(!noOverflow8.hasOverflow, 'Pit with 8: no overflow container');

    // Top row pit with > 10 should overflow upward
    // Player 1 pit 1 currently has 7 marbles. Set to 12 for overflow test.
    await page1.evaluate(() => {
      state.pits[1][1] = Array.from({length:12},(_,i)=>i);
      render();
    });
    await sleep(300);

    const topOverflow = await page1.evaluate(() => {
      // Top row is reversed: pit index 1 of player 1 appears at position 4
      const topPit4 = document.querySelectorAll('#top-row .pit')[4];
      const overflowContainer = topPit4.querySelector('.marbles-overflow');
      return {
        hasOverflow: overflowContainer !== null,
        overflowClass: overflowContainer ? overflowContainer.className : '',
        overflowCount: overflowContainer ? overflowContainer.querySelectorAll('.marble').length : 0,
      };
    });
    assert(topOverflow.hasOverflow, 'Top row pit with 12: overflow container exists');
    assert(topOverflow.overflowClass.includes('overflow-top'), 'Top row pit overflows upward');
    assert(topOverflow.overflowCount === 2, `Top row pit with 12: overflow has 2 marbles: ${topOverflow.overflowCount}`);

    // Restore game state for remaining tests
    await page1.evaluate(() => {
      state.pits = [
        [0,5,1,6,6,5],
        [0,5,5,5,5,4],
      ];
      state.stores = [[0],[]];
      render();
    });
    await sleep(300);

    // =========================================================
    // Store marbles displayed the same across players
    // =========================================================
    console.log('\n=== Store marble consistency across players ===');

    // Set stores to have several marbles so we can compare
    await page1.evaluate(() => {
      state.stores = [[0,1,2,3,4,5,6],[0,1,2,3,4]];
      render();
    });
    await sleep(300);
    // Wait for P2 to pick up the render (inject on P2 too since
    // state.stores is local — the test only syncs via webxdc updates)
    await page2.evaluate(() => {
      state.stores = [[0,1,2,3,4,5,6],[0,1,2,3,4]];
      render();
    });
    await sleep(300);

    // P1's bottom store = player 0's store (7 marbles)
    // P2's top store = player 0's store (7 marbles) — same data
    const getMarbleColors = (el) => [...el.querySelectorAll('.marble')].map(m => {
      for (let i = 0; i < 5; i++) {
        if (m.classList.contains('mc-' + i)) return 'mc-' + i;
      }
      return 'none';
    });
    const p1ownStoreColors = await page1.$eval('#store-bottom', getMarbleColors);
    const p2oppStoreColors = await page2.$eval('#store-top', getMarbleColors);
    assert(p1ownStoreColors.length === 7, `P1 own store has 7 marbles: ${p1ownStoreColors.length}`);
    assert(p2oppStoreColors.length === 7, `P2 opponent store has 7 marbles: ${p2oppStoreColors.length}`);
    assert(JSON.stringify(p1ownStoreColors) === JSON.stringify(p2oppStoreColors),
      'Store marbles are identical across players (P1 own = P2 opponent)');

    // Also check the other store: P1's top = player 1's store (5 marbles)
    // P2's bottom = player 1's store (5 marbles)
    const p1oppStoreColors = await page1.$eval('#store-top', getMarbleColors);
    const p2ownStoreColors = await page2.$eval('#store-bottom', getMarbleColors);
    assert(p1oppStoreColors.length === 5, `P1 opponent store has 5 marbles: ${p1oppStoreColors.length}`);
    assert(p2ownStoreColors.length === 5, `P2 own store has 5 marbles: ${p2ownStoreColors.length}`);
    assert(JSON.stringify(p1oppStoreColors) === JSON.stringify(p2ownStoreColors),
      'Store marbles are identical across players (P1 opponent = P2 own)');

    // Restore stores for remaining tests
    await page1.evaluate(() => {
      state.stores = [[0],[]];
      render();
    });
    await page2.evaluate(() => {
      state.stores = [[0],[]];
      render();
    });
    await sleep(300);

    // =========================================================
    // Check no JS errors occurred
    // =========================================================

    // =========================================================
    // Board scaling: no horizontal overflow at small viewports
    // =========================================================
    console.log('\n=== Board scaling: no horizontal overflow ===');

    const viewports = [
      { width: 320, height: 568, label: 'iPhone SE (320x568)' },
      { width: 375, height: 667, label: 'iPhone 6/7/8 (375x667)' },
      { width: 360, height: 640, label: 'Galaxy S5 (360x640)' },
      { width: 414, height: 896, label: 'iPhone XR (414x896)' },
      { width: 280, height: 653, label: 'Galaxy Fold (280x653)' },
    ];

    await page1.bringToFront();
    for (const vp of viewports) {
      await page1.setViewport({ width: vp.width, height: vp.height });
      await sleep(300);

      const overflow = await page1.evaluate(() => {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
        };
      });

      const noHScroll = overflow.scrollWidth <= overflow.clientWidth
        && overflow.bodyScrollWidth <= overflow.bodyClientWidth;
      assert(noHScroll,
        `${vp.label}: no horizontal scroll (scrollW=${overflow.scrollWidth}, clientW=${overflow.clientWidth})`);

      // Also verify the board element itself doesn't exceed the viewport
      const boardRect = await page1.$eval('.board', el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });
      const fitsInView = boardRect.right <= vp.width + 1 && boardRect.left >= -1;
      assert(fitsInView,
        `${vp.label}: board fits in viewport (left=${boardRect.left.toFixed(1)}, right=${boardRect.right.toFixed(1)}, vpWidth=${vp.width})`);
    }

    // Reset viewport to a normal size
    await page1.setViewport({ width: 1280, height: 800 });

    // =========================================================
    // Hotseat mode: 2 Players 1 Screen
    // =========================================================
    console.log('\n=== Hotseat mode: button and setup ===');

    // Open a fresh page for hotseat tests (clean state)
    const pageH = await browser.newPage();
    pageH.on('console', m => console.log(`    [HS] ${m.text()}`));
    pageH.on('pageerror', e => console.log(`    [HS ERROR] ${e.message}`));
    // Navigate and clear localStorage to avoid inheriting online game state, then reload
    await pageH.goto(`http://localhost:${PORT}/index.html#name=hotseat&addr=hotseat@local.host`, { waitUntil: 'networkidle0' });
    await pageH.evaluate(() => localStorage.clear());
    await pageH.goto(`http://localhost:${PORT}/index.html#name=hotseat&addr=hotseat@local.host`, { waitUntil: 'networkidle0' });
    await configurePageSettings(pageH);
    await pageH.evaluate(() => render());

    // Hotseat button should exist on join screen with correct text
    const hotseatBtnExists = await pageH.$('#hotseat-btn') !== null;
    assert(hotseatBtnExists, 'Hotseat button exists on join screen');

    const hotseatBtnText = await pageH.$eval('#hotseat-btn', el => el.textContent);
    assert(hotseatBtnText === '2 Players 1 Screen', `Hotseat button text: "${hotseatBtnText}"`);

    // Track webxdc messages to verify none are sent in hotseat mode
    await pageH.evaluate(() => {
      window.__hotseatMessages = [];
      const origSend = window.webxdc.sendUpdate;
      window.webxdc.sendUpdate = function(update, desc) {
        window.__hotseatMessages.push(update);
        return origSend.call(window.webxdc, update, desc);
      };
    });

    // Click the hotseat button
    await pageH.evaluate(() => document.getElementById('hotseat-btn').click());
    await sleep(300);

    // Game screen should be visible
    const hsGameVisible = await pageH.$eval('#game-screen', el => el.style.display === 'block');
    assert(hsGameVisible, 'Hotseat: game screen is visible after clicking button');

    // Join screen should be hidden
    const hsJoinHidden = await pageH.$eval('#join-screen', el => el.style.display === 'none');
    assert(hsJoinHidden, 'Hotseat: join screen is hidden');

    // =========================================================
    console.log('\n=== Hotseat mode: board layout ===');

    // Top row should be Red (player 0, theirs class) — board is fixed
    const hsTopTheirs = await pageH.$$eval('#top-row .pit.theirs', pits => pits.length);
    assert(hsTopTheirs === 6, `Hotseat: top row has 6 "theirs" (Red) pits: ${hsTopTheirs}`);

    // Bottom row should be Green (player 1, mine class) — board is fixed
    const hsBottomMine = await pageH.$$eval('#bottom-row .pit.mine', pits => pits.length);
    assert(hsBottomMine === 6, `Hotseat: bottom row has 6 "mine" (Green) pits: ${hsBottomMine}`);

    // Left store = Red (theirs), Right store = Green (mine)
    const hsStoreTopClass = await pageH.$eval('#store-top', el => el.className);
    const hsStoreBottomClass = await pageH.$eval('#store-bottom', el => el.className);
    assert(hsStoreTopClass.includes('theirs'), 'Hotseat: left store is Red (theirs)');
    assert(hsStoreBottomClass.includes('mine'), 'Hotseat: right store is Green (mine)');

    // All pits should have 4 marbles initially
    const hsAllMarbles = await pageH.evaluate(() => {
      const top = [...document.querySelectorAll('#top-row .pit')].map(p => p.querySelectorAll('.marble').length);
      const bot = [...document.querySelectorAll('#bottom-row .pit')].map(p => p.querySelectorAll('.marble').length);
      return { top, bot };
    });
    assert(hsAllMarbles.top.every(v => v === 4), `Hotseat: top row pits all have 4 marbles: [${hsAllMarbles.top}]`);
    assert(hsAllMarbles.bot.every(v => v === 4), `Hotseat: bottom row pits all have 4 marbles: [${hsAllMarbles.bot}]`);

    // =========================================================
    console.log('\n=== Hotseat mode: turn indicator ===');

    // Red (player 0) goes first — status should show colored "Red's turn"
    const hsStatus1 = await pageH.$eval('#status', el => ({
      text: el.textContent,
      html: el.innerHTML,
    }));
    const hsHudHidden = await pageH.evaluate(() => ({
      status: getComputedStyle(document.getElementById('status')).display,
      scoreboard: getComputedStyle(document.getElementById('scoreboard')).display,
    }));
    assert(hsHudHidden.status === 'none', `Hotseat: turn indicator hidden by default: ${hsHudHidden.status}`);
    assert(hsHudHidden.scoreboard === 'none', `Hotseat: scores hidden by default: ${hsHudHidden.scoreboard}`);
    assert(hsStatus1.text.includes("Red's turn"), `Hotseat: status shows Red's turn: "${hsStatus1.text}"`);
    assert(hsStatus1.html.includes('#ef5350'), 'Hotseat: Red turn indicator uses red color');

    // Red's pits (top row) should be clickable, Green's (bottom) should not
    const hsTopClickable = await pageH.$$eval('#top-row .pit.clickable', pits => pits.length);
    const hsBottomClickable = await pageH.$$eval('#bottom-row .pit.clickable', pits => pits.length);
    assert(hsTopClickable === 6, `Hotseat: Red's top row pits are clickable: ${hsTopClickable}`);
    assert(hsBottomClickable === 0, `Hotseat: Green's bottom row pits are not clickable: ${hsBottomClickable}`);

    // =========================================================
    console.log('\n=== Hotseat mode: turn enforcement ===');

    // On Red's turn, clicking Green's pit should have no effect
    const hsStateBefore1 = await pageH.evaluate(() => JSON.stringify(state.pits));
    await pageH.evaluate(() => {
      document.querySelectorAll('#bottom-row .pit')[0].click();
    });
    await sleep(200);
    const hsStateAfter1 = await pageH.evaluate(() => JSON.stringify(state.pits));
    assert(hsStateBefore1 === hsStateAfter1, 'Hotseat: clicking Green pit on Red turn has no effect');

    const hsStillRedTurn = await pageH.$eval('#status', el => el.textContent);
    assert(hsStillRedTurn.includes("Red's turn"), `Hotseat: still Red's turn after clicking wrong row: "${hsStillRedTurn}"`);

    // =========================================================
    console.log('\n=== Hotseat mode: clicking empty pit has no effect ===');

    // Set up a state where Red has an empty pit
    await pageH.evaluate(() => {
      state.pits[0][0] = [];
      state.currentPlayer = 0;
      render();
    });
    await sleep(200);

    const hsStateBefore2 = await pageH.evaluate(() => JSON.stringify(state.pits));
    // Pit index 0 is at DOM position 5 in the reversed top row
    await pageH.evaluate(() => {
      document.querySelectorAll('#top-row .pit')[5].click();
    });
    await sleep(200);
    const hsStateAfter2 = await pageH.evaluate(() => JSON.stringify(state.pits));
    assert(hsStateBefore2 === hsStateAfter2, 'Hotseat: clicking empty pit has no effect');

    // The empty pit should not have the clickable class
    const hsEmptyPitClickable = await pageH.evaluate(() => {
      return document.querySelectorAll('#top-row .pit')[5].classList.contains('clickable');
    });
    assert(!hsEmptyPitClickable, 'Hotseat: empty pit does not have clickable class');

    // Restore state
    await pageH.evaluate(() => {
      let id = 0;
      state.pits = [
        Array.from({length:6}, () => Array.from({length:4}, () => id++)),
        Array.from({length:6}, () => Array.from({length:4}, () => id++)),
      ];
      state.stores = [[],[]];
      state.currentPlayer = 0;
      state.gameOver = false;
      render();
    });
    await sleep(200);

    // Red clicks pit 3 (top row is reversed, so DOM index 2 = pit index 3)
    // Pit 3 has 4 seeds -> pit4, pit5, store, pit0(opponent) — lands in store = extra turn
    // Wait — sowing is from player 0 pit 3: seeds go to pit4(pos4), pit5(pos5), store(pos6) = 3 seeds, but pit has 4.
    // Pit 3 has 4 seeds: pos4(pit4), pos5(pit5), pos6(store), pos7(opp pit0) — no extra turn
    // Let's use pit 2 instead: 4 seeds from pit 2 -> pit3, pit4, pit5, store = extra turn
    // Top row reversed: pit index 2 is at DOM position 3 (5-2=3)
    await pageH.evaluate(() => {
      // Top row DOM order is reversed: pit[5],pit[4],pit[3],pit[2],pit[1],pit[0]
      // So pit index 2 is at DOM position 3
      document.querySelectorAll('#top-row .pit')[3].click();
    });
    await sleep(300);

    // Red should get extra turn
    const hsStatusExtra = await pageH.$eval('#status', el => el.textContent);
    assert(hsStatusExtra.includes("Red's turn"), `Hotseat: Red gets extra turn: "${hsStatusExtra}"`);

    // Red's store should have 1 marble
    const hsRedStore = await pageH.$eval('#store-top', el => el.querySelectorAll('.marble').length);
    assert(hsRedStore === 1, `Hotseat: Red store has 1 marble after extra turn: ${hsRedStore}`);

    // =========================================================
    console.log('\n=== Hotseat mode: Red passes turn to Green ===');

    // Red clicks pit 0 (DOM position 5 in reversed top row): 4 seeds
    // pit0 -> pit1, pit2, pit3, pit4 (no store) -> passes turn
    await pageH.evaluate(() => {
      document.querySelectorAll('#top-row .pit')[5].click();
    });
    await sleep(300);

    // Should now be Green's turn
    const hsStatusGreen = await pageH.$eval('#status', el => ({
      text: el.textContent,
      html: el.innerHTML,
    }));
    assert(hsStatusGreen.text.includes("Green's turn"), `Hotseat: Green's turn after Red moves: "${hsStatusGreen.text}"`);
    assert(hsStatusGreen.html.includes('#66bb6a'), 'Hotseat: Green turn indicator uses green color');

    // Now Green's pits (bottom) should be clickable, Red's (top) should not
    const hsTopClickable2 = await pageH.$$eval('#top-row .pit.clickable', pits => pits.length);
    const hsBottomClickable2 = await pageH.$$eval('#bottom-row .pit.clickable', pits => pits.length);
    assert(hsTopClickable2 === 0, `Hotseat: Red's top row not clickable on Green's turn: ${hsTopClickable2}`);
    assert(hsBottomClickable2 === 6, `Hotseat: Green's bottom row clickable on Green's turn: ${hsBottomClickable2}`);

    // On Green's turn, clicking Red's pit should have no effect
    const hsStateBefore3 = await pageH.evaluate(() => JSON.stringify(state.pits));
    await pageH.evaluate(() => {
      document.querySelectorAll('#top-row .pit')[0].click();
    });
    await sleep(200);
    const hsStateAfter3 = await pageH.evaluate(() => JSON.stringify(state.pits));
    assert(hsStateBefore3 === hsStateAfter3, 'Hotseat: clicking Red pit on Green turn has no effect');

    const hsStillGreenTurn = await pageH.$eval('#status', el => el.textContent);
    assert(hsStillGreenTurn.includes("Green's turn"), `Hotseat: still Green's turn after clicking wrong row: "${hsStillGreenTurn}"`);

    // =========================================================
    console.log('\n=== Hotseat mode: Green makes a move ===');

    // Green clicks pit 0 (bottom row, DOM position 0)
    await pageH.evaluate(() => {
      document.querySelectorAll('#bottom-row .pit')[0].click();
    });
    await sleep(300);

    // Should pass back to Red (pit 0 has 4 seeds -> pit1,2,3,4, no store)
    const hsStatusRed2 = await pageH.$eval('#status', el => el.textContent);
    assert(hsStatusRed2.includes("Red's turn"), `Hotseat: Red's turn after Green moves: "${hsStatusRed2}"`);

    // =========================================================
    console.log('\n=== Hotseat mode: seed conservation ===');

    const hsSeedTotal = await pageH.evaluate(() => {
      const top = [...document.querySelectorAll('#top-row .pit')].reduce((s, p) => s + p.querySelectorAll('.marble').length, 0);
      const bot = [...document.querySelectorAll('#bottom-row .pit')].reduce((s, p) => s + p.querySelectorAll('.marble').length, 0);
      const s1 = document.querySelector('#store-top').querySelectorAll('.marble').length;
      const s2 = document.querySelector('#store-bottom').querySelectorAll('.marble').length;
      return top + bot + s1 + s2;
    });
    assert(hsSeedTotal === 48, `Hotseat: seed conservation: ${hsSeedTotal} (expected 48)`);

    // =========================================================
    console.log('\n=== Hotseat mode: capture ===');

    // Set up a capture scenario: Red (player 0) pit 3 has 1 seed, pit 4 is empty.
    // Red moves pit 3 -> seed lands in pit 4 (empty own pit).
    // Opposite of pit 4 is Green pit (5-4=1) which has 6 seeds -> capture.
    // Red store: 10 + 1(landing) + 6(opposite) = 17.
    await pageH.evaluate(() => {
      let id = 0;
      const mk = (n) => Array.from({length: n}, () => id++);
      state.pits = [
        [mk(2), mk(1), mk(0), mk(1), mk(0), mk(5)],
        [mk(3), mk(6), mk(5), mk(4), mk(2), mk(3)],
      ];
      state.stores = [Array.from({length:10},(_,i)=>i), Array.from({length:6},(_,i)=>i+24)];
      state.currentPlayer = 0;
      state.gameOver = false;
      render();
    });
    await sleep(200);

    // Red clicks pit 3 (DOM position 2 in reversed top row: 5-3=2)
    // 1 seed from pit 3 -> lands in pit 4 (empty) -> captures 1 + 6 from Green pit 1
    await pageH.evaluate(() => {
      document.querySelectorAll('#top-row .pit')[2].click();
    });
    await sleep(300);

    const hsCaptureResult = await pageH.evaluate(() => ({
      redPit3: state.pits[0][3],
      redPit4: state.pits[0][4],
      greenPit1: state.pits[1][1],
      redStore: state.stores[0],
    }));
    assert(hsCaptureResult.redPit3 === 0, `Hotseat capture: Red pit 3 emptied (source): ${hsCaptureResult.redPit3}`);
    assert(hsCaptureResult.redPit4 === 0, `Hotseat capture: Red pit 4 emptied after capture: ${hsCaptureResult.redPit4}`);
    assert(hsCaptureResult.greenPit1 === 0, `Hotseat capture: Green opposite pit emptied: ${hsCaptureResult.greenPit1}`);
    assert(hsCaptureResult.redStore === 17, `Hotseat capture: Red store gained 7 (10+7=17): ${hsCaptureResult.redStore}`);

    // Verify total seeds still conserved after capture
    const hsSeedAfterCapture = await pageH.evaluate(() => {
      return state.pits[0].reduce((a, b) => a + b, 0) + state.pits[1].reduce((a, b) => a + b, 0) + state.stores[0] + state.stores[1];
    });
    assert(hsSeedAfterCapture === 48, `Hotseat capture: seeds conserved after capture: ${hsSeedAfterCapture} (expected 48)`);

    // =========================================================
    console.log('\n=== Hotseat mode: no webxdc messages sent ===');

    const hsMessages = await pageH.evaluate(() => window.__hotseatMessages.length);
    assert(hsMessages === 0, `Hotseat: no webxdc messages sent: ${hsMessages}`);

    // =========================================================
    console.log('\n=== Hotseat mode: scoreboard ===');

    const hsScoreLeft = await pageH.$eval('#score-left-name', el => el.textContent);
    const hsScoreRight = await pageH.$eval('#score-right-name', el => el.textContent);
    assert(hsScoreLeft === 'Red', `Hotseat: left score label is Red: "${hsScoreLeft}"`);
    assert(hsScoreRight === 'Green', `Hotseat: right score label is Green: "${hsScoreRight}"`);

    // =========================================================
    console.log('\n=== Hotseat mode: display toggle works ===');

    await pageH.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(200);
    const hsToggleNumbers = await pageH.$eval('#bottom-row .pit', el => {
      const marbles = el.querySelector('.marbles');
      return !!marbles && getComputedStyle(marbles).display === 'none';
    });
    assert(hsToggleNumbers, 'Hotseat: toggle to numbers mode works');

    await pageH.evaluate(() => document.getElementById('store-top').click());
    await sleep(200);
    const hsToggleBack = await pageH.$eval('#bottom-row .pit', el => el.querySelector('.marbles') !== null);
    assert(hsToggleBack, 'Hotseat: toggle back to marble mode works');
    const hsNoPitTextAfterToggleBack = await pageH.$$eval('#top-row .pit, #bottom-row .pit', pits =>
      pits.every(pit => [...pit.childNodes].every(node =>
        node.nodeType !== Node.TEXT_NODE || node.textContent.trim() === '')));
    assert(hsNoPitTextAfterToggleBack, 'Hotseat: toggle back leaves no leftover number text nodes');

    // =========================================================
    console.log('\n=== Hotseat mode: game over and New Game ===');

    // Inject a near-end state: Red (player 0) has all pits empty except one with 1 seed
    await pageH.evaluate(() => {
      let id = 0;
      const mk = (n) => Array.from({length: n}, () => id++);
      state.pits = [
        [mk(0), mk(0), mk(0), mk(0), mk(0), mk(1)],
        [mk(2), mk(0), mk(0), mk(0), mk(0), mk(0)],
      ];
      state.stores = [Array.from({length:22},(_,i)=>i),Array.from({length:23},(_,i)=>i+6)];
      state.currentPlayer = 0;
      state.gameOver = false;
      render();
    });
    await sleep(200);

    // Red clicks pit 5 (DOM position 0 in reversed top row) — 1 seed goes to store
    // This empties Red's side, triggers game end
    await pageH.evaluate(() => {
      document.querySelectorAll('#top-row .pit')[0].click();
    });
    await sleep(300);

    // Game should be over
    const hsGameOver = await pageH.$eval('#status', el => el.textContent);
    assert(hsGameOver.includes('Game Over'), `Hotseat: game over status: "${hsGameOver}"`);

    // No pits should be clickable after game over
    const hsClickableAfterGameOver = await pageH.evaluate(() => {
      const top = document.querySelectorAll('#top-row .pit.clickable').length;
      const bot = document.querySelectorAll('#bottom-row .pit.clickable').length;
      return top + bot;
    });
    assert(hsClickableAfterGameOver === 0, `Hotseat: no clickable pits after game over: ${hsClickableAfterGameOver}`);

    // Clicking a pit after game over should have no effect
    const hsStateBeforeGameOverClick = await pageH.evaluate(() => JSON.stringify(state.stores));
    await pageH.evaluate(() => {
      document.querySelectorAll('#top-row .pit')[0].click();
      document.querySelectorAll('#bottom-row .pit')[0].click();
    });
    await sleep(200);
    const hsStateAfterGameOverClick = await pageH.evaluate(() => JSON.stringify(state.stores));
    assert(hsStateBeforeGameOverClick === hsStateAfterGameOverClick, 'Hotseat: clicking pits after game over has no effect');
    // Winner banner should show a player name (not "You Win!")
    const hsWinner = await pageH.$eval('#winner-banner', el => el.textContent);
    assert(hsWinner.includes('Wins!') || hsWinner.includes('Tie'), `Hotseat: winner banner shows name: "${hsWinner}"`);
    assert(!hsWinner.includes('You'), 'Hotseat: winner banner does not say "You Win!"');
    assert(/\d+-\d+/.test(hsWinner), `Hotseat: winner banner includes final numeric score: "${hsWinner}"`);

    // New Game button should be visible
    const hsNewGameBtn = await pageH.$eval('#actions button', el => el.textContent);
    assert(hsNewGameBtn === 'New Game', `Hotseat: New Game button visible: "${hsNewGameBtn}"`);

    // Click New Game — should return to join screen
    await pageH.evaluate(() => document.querySelector('#actions button').click());
    await sleep(300);

    const hsBackToJoin = await pageH.$eval('#join-screen', el => el.style.display !== 'none');
    assert(hsBackToJoin, 'Hotseat: New Game returns to join screen');

    const hsGameHidden = await pageH.$eval('#game-screen', el => el.style.display === 'none' || el.style.display === '');
    assert(hsGameHidden, 'Hotseat: game screen hidden after New Game');

    // Hotseat button should still be there for another round
    const hsBtn2 = await pageH.$eval('#hotseat-btn', el => el.offsetParent !== null);
    assert(hsBtn2, 'Hotseat: hotseat button available after returning to join screen');

    await pageH.close();

    // =========================================================
    // Player vs CPU: setup flow + Bob strategy
    // =========================================================
    console.log('\n=== Player vs CPU: setup flow and Bob ===');

    const playerCpuContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pagePVC = await playerCpuContext.newPage();
    pagePVC.on('console', m => console.log(`    [PVC] ${m.text()}`));
    pagePVC.on('pageerror', e => console.log(`    [PVC ERROR] ${e.message}`));
    await configurePageSettings(pagePVC, {}, { beforeNavigation: true });
    await pagePVC.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pagePVC.evaluate(() => {
      cpuTurnDelayMs = 0;
      window.__localCpuMessages = [];
      const origSend = window.webxdc.sendUpdate;
      window.webxdc.sendUpdate = function(update, desc) {
        window.__localCpuMessages.push(update);
        return origSend.call(window.webxdc, update, desc);
      };
    });

    const strategyChoices = await pagePVC.evaluate(() => {
      const comboBoard = {
        pits: [[0, 0, 0, 0, 2, 1], [4, 4, 4, 4, 4, 4]],
        stores: [0, 0],
        currentPlayer: 0,
        gameOver: false,
      };
      const fallbackBoard = {
        pits: [[0, 2, 0, 0, 0, 3], [4, 4, 4, 4, 4, 4]],
        stores: [0, 0],
        currentPlayer: 0,
        gameOver: false,
      };
      const closestBoard = {
        pits: [[0, 2, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0]],
        stores: [0, 0],
        currentPlayer: 0,
        gameOver: false,
      };

      const originalRandom = Math.random;
      function withRandomSequence(values, fn) {
        const queuedRandoms = values.slice();
        Math.random = function() {
          return queuedRandoms.length > 0 ? queuedRandoms.shift() : 0;
        };
        return fn();
      }
      try {
        return {
          closestToStore: chooseClosestToStore(closestBoard, 0),
          furthestFromStore: chooseFurthestFromStore(closestBoard, 0),
          randomPitFirst: withRandomSequence([0], function() { return chooseRandomPit(fallbackBoard, 0); }),
          randomPitLast: withRandomSequence([0.999], function() { return chooseRandomPit(fallbackBoard, 0); }),
          nextTurnCombo: chooseNextTurn(comboBoard, 0),
          nextTurnMissing: chooseNextTurn(fallbackBoard, 0),
          simulateMove: simulateMove(comboBoard, 0, 5),
          janFallback: AVAILABLE_PLAYERS.find(p => p.id === 'jan').chooseMove(fallbackBoard, 0),
          jillFallback: AVAILABLE_PLAYERS.find(p => p.id === 'jill').chooseMove(fallbackBoard, 0),
          charlieChoice: withRandomSequence([0], function() {
            return AVAILABLE_PLAYERS.find(p => p.id === 'charlie').chooseMove(fallbackBoard, 0);
          }),
          thomasCombo: AVAILABLE_PLAYERS.find(p => p.id === 'thomas').chooseMove(comboBoard, 0),
          thomasFallback: withRandomSequence([0], function() {
            return AVAILABLE_PLAYERS.find(p => p.id === 'thomas').chooseMove(fallbackBoard, 0);
          }),
          composedChoice: combineChoosers(
            function() { return -1; },
            function(boardState, playerIdx) { return chooseFurthestFromStore(boardState, playerIdx); }
          )(fallbackBoard, 0),
          randomChooserRetry: withRandomSequence([0, 0], function() {
            return chooseRandomChooser(
              function() { return -1; },
              function(boardState, playerIdx) { return chooseFurthestFromStore(boardState, playerIdx); },
              function(boardState, playerIdx) { return chooseClosestToStore(boardState, playerIdx); }
            )(fallbackBoard, 0);
          }),
          randomChooserAllMissing: withRandomSequence([0, 0], function() {
            return chooseRandomChooser(
              function() { return -1; },
              function() { return -1; }
            )(fallbackBoard, 0);
          }),
        };
      } finally {
        Math.random = originalRandom;
      }
    });
    assert(strategyChoices.closestToStore === 5,
      `chooseClosestToStore picks the bowl nearest the store: ${strategyChoices.closestToStore}`);
    assert(strategyChoices.furthestFromStore === 1,
      `chooseFurthestFromStore picks the bowl farthest from the store: ${strategyChoices.furthestFromStore}`);
    assert(strategyChoices.randomPitFirst === 1 && strategyChoices.randomPitLast === 5,
      `chooseRandomPit picks among the legal pits using Math.random: first=${strategyChoices.randomPitFirst}, last=${strategyChoices.randomPitLast}`);
    assert(strategyChoices.nextTurnCombo === 5,
      `chooseNextTurn prefers the move that chains into more extra turns: ${strategyChoices.nextTurnCombo}`);
    assert(strategyChoices.nextTurnMissing === -1,
      `chooseNextTurn returns -1 when no move lands in the store: ${strategyChoices.nextTurnMissing}`);
    assert(strategyChoices.simulateMove.extraTurn && strategyChoices.simulateMove.currentPlayer === 0,
      `simulateMove reports extra turns without mutating the live game: extraTurn=${strategyChoices.simulateMove.extraTurn}, currentPlayer=${strategyChoices.simulateMove.currentPlayer}`);
    assert(strategyChoices.simulateMove.scoreDelta === 1,
      `simulateMove reports the score gained by a move: ${strategyChoices.simulateMove.scoreDelta}`);
    assert(strategyChoices.janFallback === 5,
      `Jan falls back to the closest-to-store chooser when no extra turn is available: ${strategyChoices.janFallback}`);
    assert(strategyChoices.jillFallback === 1,
      `Jill falls back to the furthest-from-store chooser when no extra turn is available: ${strategyChoices.jillFallback}`);
    assert(strategyChoices.charlieChoice === 1,
      `Charlie uses chooseRandomPit for random legal moves: ${strategyChoices.charlieChoice}`);
    assert(strategyChoices.thomasCombo === 5,
      `Thomas prefers chooseNextTurn before any random fallback chooser: ${strategyChoices.thomasCombo}`);
    assert(strategyChoices.thomasFallback === 5,
      `Thomas uses a random fallback chooser when no extra turn is available: ${strategyChoices.thomasFallback}`);
    assert(strategyChoices.composedChoice === 1,
      `combineChoosers returns the first chooser result above -1: ${strategyChoices.composedChoice}`);
    assert(strategyChoices.randomChooserRetry === 1,
      `chooseRandomChooser retries with another random chooser after a -1 result: ${strategyChoices.randomChooserRetry}`);
    assert(strategyChoices.randomChooserAllMissing === -1,
      `chooseRandomChooser returns -1 only when every chooser returns -1: ${strategyChoices.randomChooserAllMissing}`);

    await pagePVC.evaluate(() => document.getElementById('player-vs-cpu-btn').click());
    await sleep(120);
    const pvcpuSetupOpen = await pagePVC.evaluate(() => ({
      open: document.getElementById('cpu-setup-overlay').classList.contains('open'),
      title: document.getElementById('cpu-setup-title').textContent,
      subtitle: document.getElementById('cpu-setup-subtitle').textContent,
      overflowY: getComputedStyle(document.getElementById('cpu-setup-overlay')).overflowY,
      bobBtn: document.getElementById('cpu-select-bob').textContent,
      billBtn: document.getElementById('cpu-select-bill').textContent,
      charlieBtn: document.getElementById('cpu-select-charlie').textContent,
      janBtn: document.getElementById('cpu-select-jan').textContent,
      jillBtn: document.getElementById('cpu-select-jill').textContent,
      thomasBtn: document.getElementById('cpu-select-thomas').textContent,
    }));
    assert(pvcpuSetupOpen.open, 'Player vs CPU opens the chooser overlay');
    assert(pvcpuSetupOpen.title === 'Choose Opponent', `Player vs CPU chooser title: "${pvcpuSetupOpen.title}"`);
    assert(pvcpuSetupOpen.overflowY === 'auto', `Player vs CPU chooser is scrollable: ${pvcpuSetupOpen.overflowY}`);
    assert(pvcpuSetupOpen.bobBtn === 'Choose Bob', `Player vs CPU chooser lists Bob: "${pvcpuSetupOpen.bobBtn}"`);
    assert(pvcpuSetupOpen.billBtn === 'Choose Bill', `Player vs CPU chooser lists Bill: "${pvcpuSetupOpen.billBtn}"`);
    assert(pvcpuSetupOpen.charlieBtn === 'Choose Charlie', `Player vs CPU chooser lists Charlie: "${pvcpuSetupOpen.charlieBtn}"`);
    assert(pvcpuSetupOpen.janBtn === 'Choose Jan', `Player vs CPU chooser lists Jan: "${pvcpuSetupOpen.janBtn}"`);
    assert(pvcpuSetupOpen.jillBtn === 'Choose Jill', `Player vs CPU chooser lists Jill: "${pvcpuSetupOpen.jillBtn}"`);
    assert(pvcpuSetupOpen.thomasBtn === 'Choose Thomas', `Player vs CPU chooser lists Thomas: "${pvcpuSetupOpen.thomasBtn}"`);

    await pagePVC.evaluate(() => document.getElementById('cpu-help-bob').click());
    await sleep(80);
    const bobDescription = await pagePVC.$eval('#cpu-description-bob', el => ({
      text: el.textContent,
      hidden: el.classList.contains('hidden'),
    }));
    assert(!bobDescription.hidden, 'Bob help toggle reveals his explanation');
    assert(bobDescription.text === 'Always moves the bowl closest to his store.',
      `Bob description text is correct: "${bobDescription.text}"`);

    await pagePVC.evaluate(() => document.getElementById('cpu-select-bob').click());
    await sleep(120);
    const pvcpuStarterScreen = await pagePVC.evaluate(() => ({
      title: document.getElementById('cpu-setup-title').textContent,
      humanFirst: document.getElementById('cpu-setup-human-first-btn').textContent,
      cpuFirst: document.getElementById('cpu-setup-cpu-first-btn').textContent,
    }));
    assert(pvcpuStarterScreen.title === 'Who Goes First?', `Player vs CPU start-order title: "${pvcpuStarterScreen.title}"`);
    assert(pvcpuStarterScreen.humanFirst === 'You go first', `Player vs CPU offers human-first option: "${pvcpuStarterScreen.humanFirst}"`);
    assert(pvcpuStarterScreen.cpuFirst === 'Bob goes first', `Player vs CPU offers Bob-first option: "${pvcpuStarterScreen.cpuFirst}"`);

    await pagePVC.evaluate(() => document.getElementById('cpu-setup-cpu-first-btn').click());
    await pagePVC.waitForFunction(() => state.player1 && state.player1.name === 'Bob' && state.currentPlayer === 1 && state.stores[0] === 1, { timeout: 15000 });
    const pvcpuAfterBobMove = await pagePVC.evaluate(() => ({
      gameVisible: document.getElementById('game-screen').style.display === 'block',
      setupOpen: document.getElementById('cpu-setup-overlay').classList.contains('open'),
      topName: state.player1.name,
      bottomName: state.player2.name,
      currentPlayer: state.currentPlayer,
      stores: [...state.stores],
      topPitFive: state.pits[0][5],
      topClickable: document.querySelectorAll('#top-row .pit.clickable').length,
      bottomClickable: document.querySelectorAll('#bottom-row .pit.clickable').length,
      status: document.getElementById('status').textContent,
      messages: window.__localCpuMessages.length,
    }));
    assert(pvcpuAfterBobMove.gameVisible, 'Player vs CPU enters the game screen after setup');
    assert(!pvcpuAfterBobMove.setupOpen, 'Player vs CPU closes the chooser overlay after setup');
    assert(pvcpuAfterBobMove.topName === 'Bob', `Player vs CPU puts Bob on the top row: "${pvcpuAfterBobMove.topName}"`);
    assert(pvcpuAfterBobMove.currentPlayer === 1, `Bob going first hands the turn to the human after his move: ${pvcpuAfterBobMove.currentPlayer}`);
    assert(pvcpuAfterBobMove.stores[0] === 1 && pvcpuAfterBobMove.stores[1] === 0,
      `Bob's closest-to-store move updates the score correctly: [${pvcpuAfterBobMove.stores}]`);
    assert(pvcpuAfterBobMove.topPitFive === 0, `Bob emptied pit 5 by moving the bowl closest to his store: ${pvcpuAfterBobMove.topPitFive}`);
    assert(pvcpuAfterBobMove.topClickable === 0 && pvcpuAfterBobMove.bottomClickable > 0,
      `Only the human's bottom-row pits are clickable after Bob moves: top=${pvcpuAfterBobMove.topClickable}, bottom=${pvcpuAfterBobMove.bottomClickable}`);
    assert(pvcpuAfterBobMove.status === 'Your turn!', `Player vs CPU status hands control back to the human: "${pvcpuAfterBobMove.status}"`);
    assert(pvcpuAfterBobMove.messages === 0, `Player vs CPU stays local and sends no webxdc updates: ${pvcpuAfterBobMove.messages}`);
    await pagePVC.close();
    await playerCpuContext.close();

    // =========================================================
    // CPU vs CPU: setup flow + autoplay
    // =========================================================
    console.log('\n=== CPU vs CPU: setup flow and autoplay ===');

    const cpuCpuContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageCVC = await cpuCpuContext.newPage();
    pageCVC.on('console', m => console.log(`    [CVC] ${m.text()}`));
    pageCVC.on('pageerror', e => console.log(`    [CVC ERROR] ${e.message}`));
    await configurePageSettings(pageCVC, {}, { beforeNavigation: true });
    await pageCVC.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageCVC.evaluate(() => {
      cpuTurnDelayMs = 0;
      window.__cpuCpuMessages = [];
      const origSend = window.webxdc.sendUpdate;
      window.webxdc.sendUpdate = function(update, desc) {
        window.__cpuCpuMessages.push(update);
        return origSend.call(window.webxdc, update, desc);
      };
      document.getElementById('cpu-vs-cpu-btn').click();
    });
    await sleep(120);
    const cpuCpuFirstScreen = await pageCVC.evaluate(() => ({
      title: document.getElementById('cpu-setup-title').textContent,
      backVisibility: getComputedStyle(document.getElementById('cpu-setup-back-btn')).visibility,
    }));
    assert(cpuCpuFirstScreen.title === 'Choose Player 1', `CPU vs CPU first chooser title: "${cpuCpuFirstScreen.title}"`);
    assert(cpuCpuFirstScreen.backVisibility === 'hidden', `CPU vs CPU hides the back button on the first chooser: ${cpuCpuFirstScreen.backVisibility}`);

    await pageCVC.evaluate(() => document.getElementById('cpu-select-bob').click());
    await sleep(120);
    const cpuCpuSecondScreen = await pageCVC.evaluate(() => ({
      title: document.getElementById('cpu-setup-title').textContent,
      subtitle: document.getElementById('cpu-setup-subtitle').textContent,
      backVisibility: getComputedStyle(document.getElementById('cpu-setup-back-btn')).visibility,
    }));
    assert(cpuCpuSecondScreen.title === 'Choose Player 2', `CPU vs CPU reuses the chooser for player 2: "${cpuCpuSecondScreen.title}"`);
    assert(cpuCpuSecondScreen.subtitle.includes('Bob will be Player 1 and go first.'),
      `CPU vs CPU explains the player-2 choice context: "${cpuCpuSecondScreen.subtitle}"`);
    assert(cpuCpuSecondScreen.backVisibility === 'visible', `CPU vs CPU shows a back button on the second chooser: ${cpuCpuSecondScreen.backVisibility}`);

    await pageCVC.evaluate(() => document.getElementById('cpu-select-bill').click());
    await pageCVC.waitForFunction(() => state.gameOver === true, { timeout: 30000 });
    const cpuCpuFinalState = await pageCVC.evaluate(() => ({
      topName: state.player1.name,
      bottomName: state.player2.name,
      winner: document.getElementById('winner-banner').textContent,
      messages: window.__cpuCpuMessages.length,
    }));
    assert(cpuCpuFinalState.topName === 'Bob', `CPU vs CPU keeps Bob as player 1: "${cpuCpuFinalState.topName}"`);
    assert(cpuCpuFinalState.bottomName === 'Bill', `CPU vs CPU keeps Bill as player 2: "${cpuCpuFinalState.bottomName}"`);
    assert(cpuCpuFinalState.winner.includes('Wins!') || cpuCpuFinalState.winner.includes('Tie'),
      `CPU vs CPU reaches a visible winner state: "${cpuCpuFinalState.winner}"`);
    assert(/\d+-\d+/.test(cpuCpuFinalState.winner),
      `CPU vs CPU winner banner includes the final score: "${cpuCpuFinalState.winner}"`);
    assert(cpuCpuFinalState.messages === 0, `CPU vs CPU stays local and sends no webxdc updates: ${cpuCpuFinalState.messages}`);

    const duplicateCpuNames = await pageCVC.evaluate(() => {
      const bob = AVAILABLE_PLAYERS.find(player => player.id === 'bob');
      hotseatMode = true;
      localModeType = LOCAL_MODE_TYPES.cpuVsCpu;
      localAutomatedPlayers = [bob, bob];
      state = initState();
      state.player1 = { addr: '__cpu_top__', name: 'Bob' };
      state.player2 = { addr: '__cpu_bottom__', name: 'Bob' };
      state.stores = [25, 23];
      state.currentPlayer = 0;
      state.gameOver = true;
      render();
      return {
        leftScoreName: document.getElementById('score-left-name').textContent,
        rightScoreName: document.getElementById('score-right-name').textContent,
        winner: document.getElementById('winner-banner').textContent,
      };
    });
    assert(duplicateCpuNames.leftScoreName === 'Bob (P1)',
      `Duplicate CPU names disambiguate player 1 in the score labels: "${duplicateCpuNames.leftScoreName}"`);
    assert(duplicateCpuNames.rightScoreName === 'Bob (P2)',
      `Duplicate CPU names disambiguate player 2 in the score labels: "${duplicateCpuNames.rightScoreName}"`);
    assert(duplicateCpuNames.winner === 'Bob (P1) Wins! 25-23',
      `Duplicate CPU names disambiguate the winner banner: "${duplicateCpuNames.winner}"`);
    await pageCVC.close();
    await cpuCpuContext.close();

    // =========================================================
    // Game Menu Overlay (online mode, using page1)
    // =========================================================
    console.log('\n=== Game menu: right-click opens menu ===');

    // Restore page1 to a normal viewport and ensure game is visible
    await page1.setViewport({ width: 1280, height: 800 });
    await sleep(200);

    // Re-inject game state on page1 (hotseat tests may have disrupted via localStorage)
    await page1.evaluate(() => {
      state.player1 = { addr: 'device0@local.host', name: 'device0' };
      state.player2 = { addr: 'device1@local.host', name: 'device1' };
      state.pits = [[4,4,4,4,4,4],[4,4,4,4,4,4]];
      state.stores = [[],[]];
      state.currentPlayer = 0;
      state.gameOver = false;
      hotseatMode = false;
      localStorage.setItem('mancala-displayMode', 'marbles');
      localStorage.setItem('mancala-showHud', 'false');
      localStorage.setItem('mancala-boardRotation', 'auto');
      localStorage.setItem('mancala-boardSizePercent', '100');
      reloadLocalSettingsFromStorage();
      render();
    });
    await sleep(300);

    // Menu should initially be closed
    const menuInitHidden = await page1.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuInitHidden, 'Menu is initially hidden');

    const menuButtonDefault = await page1.evaluate(() => {
      const btn = document.getElementById('menu-open-btn');
      const style = getComputedStyle(btn);
      return {
        text: btn.textContent,
        ariaLabel: btn.getAttribute('aria-label'),
        display: style.display,
        disabled: btn.disabled,
        width: style.width,
        height: style.height,
      };
    });
    assert(menuButtonDefault.text === '⚙', `Visible menu button uses a gear icon: "${menuButtonDefault.text}"`);
    assert(menuButtonDefault.ariaLabel === 'Open menu', `Visible menu button has accessible label: "${menuButtonDefault.ariaLabel}"`);
    assert(menuButtonDefault.display !== 'none', `Visible menu button is shown by default: ${menuButtonDefault.display}`);
    assert(!menuButtonDefault.disabled, 'Visible menu button is enabled when board is idle');
    assert(menuButtonDefault.width === '34px' && menuButtonDefault.height === '34px',
      `Visible menu button stays compact: ${menuButtonDefault.width} x ${menuButtonDefault.height}`);

    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    const menuButtonOpenState = await page1.evaluate(() => ({
      menuOpen: document.getElementById('game-menu').classList.contains('open'),
      icon: document.getElementById('menu-open-btn').textContent,
      ariaLabel: document.getElementById('menu-open-btn').getAttribute('aria-label'),
    }));
    assert(menuButtonOpenState.menuOpen, 'Visible menu button opens the menu');
    assert(menuButtonOpenState.icon === '✕', `Visible menu button changes to an X while open: "${menuButtonOpenState.icon}"`);
    assert(menuButtonOpenState.ariaLabel === 'Close menu',
      `Visible menu button label changes to close menu: "${menuButtonOpenState.ariaLabel}"`);
    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    const menuClosedAfterSecondButtonClick = await page1.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuClosedAfterSecondButtonClick, 'Clicking the X closes the menu again');

    // Right-click on store-bottom should open the menu
    await page1.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(300);

    const menuOpenAfterRC = await page1.$eval('#game-menu', el => el.classList.contains('open'));
    assert(menuOpenAfterRC, 'Right-click on bottom store opens menu');

    // Verify menu content
    const menuTitle = await page1.$eval('#game-menu h2', el => el.textContent);
    assert(menuTitle === 'Menu', `Menu title is "Menu": "${menuTitle}"`);

    const howToPlayBtnText = await page1.$eval('#menu-how-to-play', el => el.textContent);
    assert(howToPlayBtnText === 'How to Play', `How to Play button is first-class menu action: "${howToPlayBtnText}"`);

    const aboutBtnText = await page1.$eval('#menu-about', el => el.textContent);
    assert(aboutBtnText === 'About', `About button is present at the bottom of the menu: "${aboutBtnText}"`);

    const menuDisplayTipText = await page1.$eval('#menu-display-tip', el => el.textContent);
    assert(menuDisplayTipText === 'Tip: click either score store to switch between marbles and numbers.',
      `Menu tip explains score-store display toggle: "${menuDisplayTipText}"`);

    const toggleBtnText = await page1.$eval('#menu-toggle-display', el => el.textContent);
    assert(toggleBtnText === 'Switch to Numbers', `Toggle button says "Switch to Numbers": "${toggleBtnText}"`);

    const toggleHudBtnText = await page1.$eval('#menu-toggle-hud', el => el.textContent);
    assert(toggleHudBtnText === 'Show Turn Info and Scores',
      `HUD toggle button says "Show Turn Info and Scores": "${toggleHudBtnText}"`);

    const menuButtonTipText = await page1.$eval('#menu-button-tip', el => el.textContent);
    assert(menuButtonTipText === 'Tip: press and hold either score store to open the menu.',
      `Menu tip explains what can be long-held: "${menuButtonTipText}"`);

    const toggleMenuButtonText = await page1.$eval('#menu-toggle-menu-button', el => el.textContent);
    assert(toggleMenuButtonText === 'Hide Gear Button',
      `Menu button toggle uses gear wording: "${toggleMenuButtonText}"`);

    const rotateBtnText = await page1.$eval('#menu-rotate', el => el.textContent);
    assert(rotateBtnText === 'Rotation: Auto', `Rotate button says "Rotation: Auto": "${rotateBtnText}"`);

    const boardSizeDefault = await page1.evaluate(() => ({
      value: document.getElementById('menu-board-size').value,
      status: document.getElementById('menu-board-size-status').textContent,
    }));
    assert(boardSizeDefault.value === '100', `Board size slider defaults to 100: ${boardSizeDefault.value}`);
    assert(boardSizeDefault.status === '100% of fit',
      `Board size status defaults to "100% of fit": "${boardSizeDefault.status}"`);

    const backBtnRemoved = await page1.evaluate(() => document.getElementById('menu-back') === null);
    assert(backBtnRemoved, 'Large Back to Game button is removed');

    const quitBtnText = await page1.$eval('#menu-quit', el => el.textContent);
    assert(quitBtnText === 'Quit Game', `Quit button says "Quit Game": "${quitBtnText}"`);

    await page1.evaluate(() => document.getElementById('menu-how-to-play').click());
    await sleep(200);
    const howToPlayView = await page1.evaluate(() => ({
      title: document.querySelector('#menu-howto-sheet h2').textContent,
      mainHidden: document.getElementById('menu-main-sheet').classList.contains('hidden'),
      howtoVisible: !document.getElementById('menu-howto-sheet').classList.contains('hidden'),
      ariaLabel: document.getElementById('menu-open-btn').getAttribute('aria-label'),
      text: document.getElementById('menu-howto-sheet').textContent.replace(/\s+/g, ' ').trim(),
      centeredOffset: (() => {
        const rect = document.getElementById('menu-howto-sheet').getBoundingClientRect();
        return Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2);
      })(),
    }));
    assert(howToPlayView.title === 'How to Play', `How to Play view title is correct: "${howToPlayView.title}"`);
    assert(howToPlayView.mainHidden && howToPlayView.howtoVisible,
      'How to Play switches the menu overlay to the instructional view');
    assert(howToPlayView.ariaLabel === 'Back to menu',
      `Top-right X becomes a back-to-menu control in How to Play view: "${howToPlayView.ariaLabel}"`);
    assert(howToPlayView.centeredOffset <= 2,
      `How to Play sheet stays centered on screen (offset ${howToPlayView.centeredOffset.toFixed(1)}px)`);
    assert(howToPlayView.text.includes('Collect more seeds in your store than the other player'),
      'How to Play explains the goal for a new player');
    assert(howToPlayView.text.includes('If your last seed lands in your store, you get another turn'),
      'How to Play explains the extra-turn rule');
    assert(howToPlayView.text.includes('If your last seed lands in an empty bowl on your side and there are seeds in the opposite bowl'),
      'How to Play explains the capture rule');
    assert(howToPlayView.text.includes('When one side has no seeds left in its small bowls'),
      'How to Play explains how the game ends');

    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    const backToMainMenu = await page1.evaluate(() => ({
      menuStillOpen: document.getElementById('game-menu').classList.contains('open'),
      mainVisible: !document.getElementById('menu-main-sheet').classList.contains('hidden'),
      howtoHidden: document.getElementById('menu-howto-sheet').classList.contains('hidden'),
      ariaLabel: document.getElementById('menu-open-btn').getAttribute('aria-label'),
    }));
    assert(backToMainMenu.menuStillOpen, 'Leaving How to Play returns to the menu without closing the overlay');
    assert(backToMainMenu.mainVisible && backToMainMenu.howtoHidden,
      'Top-right X takes How to Play back to the main menu');
    assert(backToMainMenu.ariaLabel === 'Close menu',
      `Top-right X returns to close-menu behavior on the main menu: "${backToMainMenu.ariaLabel}"`);

    await page1.evaluate(() => document.getElementById('menu-about').click());
    await sleep(200);
    const aboutView = await page1.evaluate(() => ({
      title: document.querySelector('#menu-about-sheet h2').textContent,
      mainHidden: document.getElementById('menu-main-sheet').classList.contains('hidden'),
      aboutVisible: !document.getElementById('menu-about-sheet').classList.contains('hidden'),
      ariaLabel: document.getElementById('menu-open-btn').getAttribute('aria-label'),
      text: document.getElementById('menu-about-sheet').textContent.replace(/\s+/g, ' ').trim(),
      authorHref: document.getElementById('about-author-link').href,
      licenseHref: document.getElementById('about-license-link').href,
      xdcHref: document.getElementById('about-xdc-link').href,
      pwaHref: document.getElementById('about-pwa-link').href,
      forgejoHref: document.getElementById('about-source-forgejo-link').href,
      githubHref: document.getElementById('about-source-github-link').href,
    }));
    assert(aboutView.title === 'About', `About view title is correct: "${aboutView.title}"`);
    assert(aboutView.mainHidden && aboutView.aboutVisible,
      'About switches the menu overlay to the about view');
    assert(aboutView.ariaLabel === 'Back to menu',
      `Top-right X becomes a back-to-menu control in About view: "${aboutView.ariaLabel}"`);
    assert(aboutView.text.includes('Created by moparisthebest yelling at an LLM. Licensed AGPLv3. Please share and enjoy!'),
      'About includes the author and license text');
    assert(aboutView.text.includes('Available as multiplayer webxdc game here.'),
      'About includes the multiplayer webxdc download text');
    assert(aboutView.text.includes('Play in Your Browser or Install You can play Mancala in your browser or install it as an app from https://mancala.moparisthe.best/.'),
      'About includes the approved browser/install section');
    assert(aboutView.text.includes('In most browsers, open that site and choose Install App or Add to Home Screen for an app-like experience with an icon on your device.'),
      'About explains how to install the browser version as a PWA');
    assert(aboutView.text.includes('Source code available here, here, or this file you are looking at.'),
      'About includes the source code text');
    assert(aboutView.authorHref === 'https://moparisthebest.com/',
      `About links the author name: "${aboutView.authorHref}"`);
    assert(aboutView.licenseHref === 'https://www.gnu.org/licenses/agpl-3.0.html',
      `About links the AGPL license: "${aboutView.licenseHref}"`);
    assert(aboutView.xdcHref === 'https://mancala.moparisthe.best/mancala.xdc',
      `About uses the hosted mancala.xdc link in webxdc mode: "${aboutView.xdcHref}"`);
    assert(aboutView.pwaHref === 'https://mancala.moparisthe.best/',
      `About links the hosted browser install page: "${aboutView.pwaHref}"`);
    assert(aboutView.forgejoHref === 'https://code.moparisthe.best/moparisthebest/mancala',
      `About links the primary source host: "${aboutView.forgejoHref}"`);
    assert(aboutView.githubHref === 'https://github.com/moparisthebest/mancala',
      `About links the GitHub mirror: "${aboutView.githubHref}"`);

    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    const backFromAbout = await page1.evaluate(() => ({
      menuStillOpen: document.getElementById('game-menu').classList.contains('open'),
      mainVisible: !document.getElementById('menu-main-sheet').classList.contains('hidden'),
      aboutHidden: document.getElementById('menu-about-sheet').classList.contains('hidden'),
      ariaLabel: document.getElementById('menu-open-btn').getAttribute('aria-label'),
    }));
    assert(backFromAbout.menuStillOpen, 'Leaving About returns to the menu without closing the overlay');
    assert(backFromAbout.mainVisible && backFromAbout.aboutHidden,
      'Top-right X takes About back to the main menu');
    assert(backFromAbout.ariaLabel === 'Close menu',
      `Top-right X returns to close-menu behavior after About: "${backFromAbout.ariaLabel}"`);

    const pageMD = await browser.newPage();
    await pageMD.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await configurePageSettings(pageMD, { animSpeed: null });
    await pageMD.evaluate(() => {
      render();
      document.getElementById('hotseat-btn').click();
      document.getElementById('store-bottom').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(300);
    const defaultAnimMenuState = await pageMD.evaluate(() => ({
      value: document.getElementById('menu-anim-speed').value,
      status: document.getElementById('menu-anim-status').textContent,
    }));
    assert(defaultAnimMenuState.value === '67',
      `Animation speed slider defaults to 67 (~700ms): ${defaultAnimMenuState.value}`);
    assert(defaultAnimMenuState.status === '700ms per seed',
      `Animation speed status defaults to 700ms per seed: "${defaultAnimMenuState.status}"`);
    await pageMD.close();

    const menuScrollContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageMScr = await menuScrollContext.newPage();
    await pageMScr.setViewport({ width: 320, height: 180 });
    await configurePageSettings(pageMScr, {}, { beforeNavigation: true });
    await pageMScr.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageMScr.evaluate(() => document.getElementById('hotseat-btn').click());
    await sleep(250);
    await pageMScr.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    const menuScrollBefore = await pageMScr.evaluate(() => {
      const menu = document.getElementById('game-menu');
      const quitRect = document.getElementById('menu-quit').getBoundingClientRect();
      return {
        overflowY: getComputedStyle(menu).overflowY,
        clientHeight: menu.clientHeight,
        scrollHeight: menu.scrollHeight,
        scrollTop: menu.scrollTop,
        quitBottom: quitRect.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    assert(menuScrollBefore.overflowY === 'auto',
      `Menu uses vertical scrolling when needed: ${menuScrollBefore.overflowY}`);
    assert(menuScrollBefore.scrollHeight > menuScrollBefore.clientHeight,
      `Small-screen menu becomes scrollable when content is taller (${menuScrollBefore.scrollHeight} > ${menuScrollBefore.clientHeight})`);
    assert(menuScrollBefore.quitBottom > menuScrollBefore.viewportHeight,
      `Quit button starts below the small viewport before scrolling: ${menuScrollBefore.quitBottom.toFixed(1)} > ${menuScrollBefore.viewportHeight}`);
    await pageMScr.evaluate(() => {
      const menu = document.getElementById('game-menu');
      menu.scrollTop = menu.scrollHeight;
    });
    await sleep(150);
    const menuScrollAfter = await pageMScr.evaluate(() => {
      const menu = document.getElementById('game-menu');
      const quitRect = document.getElementById('menu-quit').getBoundingClientRect();
      return {
        scrollTop: menu.scrollTop,
        quitBottom: quitRect.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    assert(menuScrollAfter.scrollTop > 0,
      `Menu overlay actually scrolls on small screens: ${menuScrollAfter.scrollTop}`);
    assert(menuScrollAfter.quitBottom <= menuScrollAfter.viewportHeight + 1,
      `Scrolling reveals the bottom of the menu within the viewport: ${menuScrollAfter.quitBottom.toFixed(1)} <= ${menuScrollAfter.viewportHeight + 1}`);

    await pageMScr.evaluate(() => document.getElementById('menu-how-to-play').click());
    await sleep(150);
    const howToPlayScrollBefore = await pageMScr.evaluate(() => {
      const menu = document.getElementById('game-menu');
      const howtoBottom = document.querySelector('#menu-howto-sheet .howto-card:last-child').getBoundingClientRect().bottom;
      return {
        scrollHeight: menu.scrollHeight,
        clientHeight: menu.clientHeight,
        scrollTop: menu.scrollTop,
        bottom: howtoBottom,
        viewportHeight: window.innerHeight,
      };
    });
    assert(howToPlayScrollBefore.scrollHeight > howToPlayScrollBefore.clientHeight,
      `How to Play view is also scrollable on a very small screen (${howToPlayScrollBefore.scrollHeight} > ${howToPlayScrollBefore.clientHeight})`);
    assert(howToPlayScrollBefore.bottom > howToPlayScrollBefore.viewportHeight,
      `How to Play content extends below the small viewport before scrolling: ${howToPlayScrollBefore.bottom.toFixed(1)} > ${howToPlayScrollBefore.viewportHeight}`);
    await pageMScr.evaluate(() => {
      const menu = document.getElementById('game-menu');
      menu.scrollTop = menu.scrollHeight;
    });
    await sleep(150);
    const howToPlayScrollAfter = await pageMScr.evaluate(() => {
      const menu = document.getElementById('game-menu');
      const howtoBottom = document.querySelector('#menu-howto-sheet .howto-card:last-child').getBoundingClientRect().bottom;
      return {
        scrollTop: menu.scrollTop,
        bottom: howtoBottom,
        viewportHeight: window.innerHeight,
      };
    });
    assert(howToPlayScrollAfter.scrollTop > 0,
      `How to Play view actually scrolls on a small screen: ${howToPlayScrollAfter.scrollTop}`);
    assert(howToPlayScrollAfter.bottom <= howToPlayScrollAfter.viewportHeight + 1,
      `Scrolling reveals the bottom of the How to Play view: ${howToPlayScrollAfter.bottom.toFixed(1)} <= ${howToPlayScrollAfter.viewportHeight + 1}`);
    await pageMScr.close();
    await menuScrollContext.close();

    const menuButtonContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageMB = await menuButtonContext.newPage();
    await configurePageSettings(pageMB, { showMenuButton: null }, { beforeNavigation: true });
    await pageMB.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageMB.evaluate(() => document.getElementById('hotseat-btn').click());
    await sleep(250);
    await pageMB.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    await pageMB.evaluate(() => document.getElementById('menu-toggle-menu-button').click());
    await sleep(120);
    const menuButtonHiddenState = await pageMB.evaluate(() => ({
      buttonDisplay: getComputedStyle(document.getElementById('menu-open-btn')).display,
      buttonText: document.getElementById('menu-open-btn').textContent,
      storedValue: localStorage.getItem('mancala-showMenuButton'),
      toggleLabel: document.getElementById('menu-toggle-menu-button').textContent,
    }));
    assert(menuButtonHiddenState.buttonDisplay !== 'none',
      `Close button stays visible while menu is open even after hiding closed-state gear: ${menuButtonHiddenState.buttonDisplay}`);
    assert(menuButtonHiddenState.buttonText === '✕',
      `Visible button stays as an X while the menu is open: "${menuButtonHiddenState.buttonText}"`);
    assert(menuButtonHiddenState.storedValue === 'false',
      `Hidden menu button preference persists as false: "${menuButtonHiddenState.storedValue}"`);
    assert(menuButtonHiddenState.toggleLabel === 'Show Gear Button',
      `Hidden-state toggle label flips to show the gear: "${menuButtonHiddenState.toggleLabel}"`);
    await pageMB.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);
    await pageMB.close();

    const pageMBReload = await menuButtonContext.newPage();
    await pageMBReload.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    const pregameButtonWithHiddenPref = await pageMBReload.evaluate(() => ({
      buttonDisplay: getComputedStyle(document.getElementById('menu-open-btn')).display,
      storedValue: localStorage.getItem('mancala-showMenuButton'),
    }));
    assert(pregameButtonWithHiddenPref.buttonDisplay !== 'none',
      `Join screen still shows the menu button even when the in-game gear is hidden: ${pregameButtonWithHiddenPref.buttonDisplay}`);
    assert(pregameButtonWithHiddenPref.storedValue === 'false',
      `Hidden menu button preference is still stored before starting a game: "${pregameButtonWithHiddenPref.storedValue}"`);
    await pageMBReload.evaluate(() => document.getElementById('hotseat-btn').click());
    await sleep(250);
    const hiddenAfterReload = await pageMBReload.evaluate(() => ({
      buttonDisplay: getComputedStyle(document.getElementById('menu-open-btn')).display,
      storedValue: localStorage.getItem('mancala-showMenuButton'),
    }));
    assert(hiddenAfterReload.buttonDisplay === 'none',
      `Hidden menu button stays hidden after reload: ${hiddenAfterReload.buttonDisplay}`);
    assert(hiddenAfterReload.storedValue === 'false',
      `Hidden menu button preference survives reload: "${hiddenAfterReload.storedValue}"`);
    await pageMBReload.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    });
    await sleep(600);
    const longHoldStillOpensMenu = await pageMBReload.evaluate(() => ({
      menuOpen: document.getElementById('game-menu').classList.contains('open'),
      toggleLabel: document.getElementById('menu-toggle-menu-button').textContent,
      tip: document.getElementById('menu-button-tip').textContent,
    }));
    assert(longHoldStillOpensMenu.menuOpen, 'Long-hold still opens the menu after hiding the visible button');
    assert(longHoldStillOpensMenu.toggleLabel === 'Show Gear Button',
      `Hidden button menu still offers restoring the gear: "${longHoldStillOpensMenu.toggleLabel}"`);
    assert(longHoldStillOpensMenu.tip === 'Tip: press and hold either score store to open the menu.',
      `Hidden button menu still explains the long-hold target: "${longHoldStillOpensMenu.tip}"`);
    await pageMBReload.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    });
    await pageMBReload.close();
    await menuButtonContext.close();

    // =========================================================
    console.log('\n=== Game menu: auto rotation and board size ===');

    await page1.bringToFront();
    await page1.evaluate(() => {
      state.player1 = { addr: 'device0@local.host', name: 'device0' };
      state.player2 = { addr: 'device1@local.host', name: 'device1' };
      state.pits = [[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]];
      state.stores = [[], []];
      state.currentPlayer = 0;
      state.gameOver = false;
      hotseatMode = false;
      localStorage.setItem('mancala-displayMode', 'marbles');
      localStorage.setItem('mancala-showHud', 'false');
      localStorage.setItem('mancala-boardRotation', 'auto');
      localStorage.setItem('mancala-boardSizePercent', '100');
      reloadLocalSettingsFromStorage();
      render();
    });
    await page1.setViewport({ width: 320, height: 568 });
    await sleep(300);

    const autoRotationState = await page1.evaluate(() => {
      const board = document.querySelector('.board');
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      const pitRect = document.querySelector('.pit').getBoundingClientRect();
      return {
        mode: board.dataset.rotationMode,
        angle: board.dataset.rotationAngle,
        orientation: board.dataset.layoutOrientation,
        frameWidth: frame.width,
        frameHeight: frame.height,
        pitWidth: pitRect.width,
        pitHeight: pitRect.height,
      };
    });
    assert(autoRotationState.mode === 'auto', `Auto rotation mode is active: ${autoRotationState.mode}`);
    assert(['0', '90'].includes(autoRotationState.angle),
      `Auto rotation chooses a supported best-fit angle: ${autoRotationState.angle}`);
    assert(autoRotationState.orientation === 'horizontal',
      `Auto rotation keeps the board in the base layout: ${autoRotationState.orientation}`);
    const portraitCentering = await page1.$eval('.board', el => {
      const r = el.getBoundingClientRect();
      return { topGap: r.top, bottomGap: window.innerHeight - r.bottom };
    });
    assert(Math.abs(portraitCentering.topGap - portraitCentering.bottomGap) <= 2,
      `Portrait board stays vertically centered (${portraitCentering.topGap.toFixed(1)} ~= ${portraitCentering.bottomGap.toFixed(1)})`);

    const boardFrameBeforeResize = await page1.$eval('#board-frame', el => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });

    await page1.evaluate(() => {
      const slider = document.getElementById('menu-board-size');
      slider.value = '80';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);

    const boardSizeAfterResize = await page1.evaluate(() => {
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        width: frame.width,
        height: frame.height,
        value: document.getElementById('menu-board-size').value,
        status: document.getElementById('menu-board-size-status').textContent,
        angle: document.querySelector('.board').dataset.rotationAngle,
      };
    });
    assert(boardSizeAfterResize.value === '80', `Board size slider updates to 80: ${boardSizeAfterResize.value}`);
    assert(boardSizeAfterResize.status === '80% of fit',
      `Board size status updates to "80% of fit": "${boardSizeAfterResize.status}"`);
    assert(boardSizeAfterResize.angle === autoRotationState.angle,
      `Board size change keeps the current auto-fit angle: ${boardSizeAfterResize.angle}`);
    assert(boardSizeAfterResize.width < boardFrameBeforeResize.width && boardSizeAfterResize.height < boardFrameBeforeResize.height,
      `Board size slider shrinks board frame (${boardSizeAfterResize.width.toFixed(1)}x${boardSizeAfterResize.height.toFixed(1)} < ${boardFrameBeforeResize.width.toFixed(1)}x${boardFrameBeforeResize.height.toFixed(1)})`);

    await page1.evaluate(() => {
      const slider = document.getElementById('menu-board-size');
      slider.value = '100';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);

    const rotationCycle = [
      { label: 'Rotation: 0°', angle: '0' },
      { label: 'Rotation: 90°', angle: '90' },
      { label: 'Rotation: 180°', angle: '180' },
      { label: 'Rotation: 270°', angle: '270' },
      { label: 'Rotation: Auto', angle: autoRotationState.angle },
    ];
    const rotationAreas = {};
    for (const expected of rotationCycle) {
      await page1.evaluate(() => document.getElementById('menu-rotate').click());
      await sleep(300);
      const rotationState = await page1.evaluate(() => ({
        label: document.getElementById('menu-rotate').textContent,
        angle: document.querySelector('.board').dataset.rotationAngle,
        orientation: document.querySelector('.board').dataset.layoutOrientation,
        frame: (() => {
          const r = document.getElementById('board-frame').getBoundingClientRect();
          return { width: r.width, height: r.height };
        })(),
      }));
      assert(rotationState.label === expected.label,
        `Rotate button cycles to "${expected.label}": "${rotationState.label}"`);
      assert(rotationState.angle === expected.angle,
        `Board applies rotation ${expected.angle}deg: ${rotationState.angle}`);
      rotationAreas[expected.label] = rotationState.frame.width * rotationState.frame.height;
      assert(rotationState.orientation === 'horizontal',
        `Rotation ${expected.angle} keeps the base board layout: ${rotationState.orientation}`);
    }
    assert(rotationAreas['Rotation: Auto'] >= rotationAreas['Rotation: 0°'] - 1,
      `Auto rotation is at least as large as 0° fit (${rotationAreas['Rotation: Auto'].toFixed(1)} >= ${rotationAreas['Rotation: 0°'].toFixed(1)})`);
    assert(rotationAreas['Rotation: Auto'] >= rotationAreas['Rotation: 90°'] - 1,
      `Auto rotation is at least as large as 90° fit (${rotationAreas['Rotation: Auto'].toFixed(1)} >= ${rotationAreas['Rotation: 90°'].toFixed(1)})`);

    const initialRotationContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageIR = await initialRotationContext.newPage();
    await pageIR.setViewport({ width: 390, height: 844 });
    await configurePageSettings(pageIR, {}, { beforeNavigation: true });
    await pageIR.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    const firstPortraitDraw = await pageIR.evaluate(() => {
      document.getElementById('hotseat-btn').click();
      const board = document.querySelector('.board');
      return {
        angle: board.dataset.rotationAngle,
        inlineTransition: board.style.transition,
      };
    });
    assert(firstPortraitDraw.angle === '90',
      `First portrait draw starts in the correct auto-rotation: ${firstPortraitDraw.angle}`);
    assert(firstPortraitDraw.inlineTransition === 'none',
      `First portrait draw suppresses rotation transition: "${firstPortraitDraw.inlineTransition}"`);
    await sleep(120);
    const transitionRestoredAfterFirstDraw = await pageIR.evaluate(() => document.querySelector('.board').style.transition);
    assert(transitionRestoredAfterFirstDraw === '',
      `Board rotation transition is restored after the first draw: "${transitionRestoredAfterFirstDraw}"`);
    const secondPortraitDraw = await pageIR.evaluate(() => {
      hotseatMode = false;
      state = initState();
      assignMarbleColors(state.colorSeed);
      render();
      document.getElementById('hotseat-btn').click();
      const board = document.querySelector('.board');
      return {
        angle: board.dataset.rotationAngle,
        inlineTransition: board.style.transition,
      };
    });
    assert(secondPortraitDraw.angle === '90',
      `Restarted portrait draw also starts in the correct auto-rotation: ${secondPortraitDraw.angle}`);
    assert(secondPortraitDraw.inlineTransition === 'none',
      `Restarted portrait draw also suppresses the initial rotation transition: "${secondPortraitDraw.inlineTransition}"`);
    await pageIR.close();
    await initialRotationContext.close();

    await page1.evaluate(() => {
      while (document.getElementById('menu-rotate').textContent !== 'Rotation: 90°') {
        document.getElementById('menu-rotate').click();
      }
    });
    await sleep(300);

    const portraitRotationContainsBoard = await page1.evaluate(() => {
      const boardRect = document.querySelector('.board').getBoundingClientRect();
      const elements = [
        ...document.querySelectorAll('.pit'),
        document.getElementById('store-top'),
        document.getElementById('store-bottom'),
      ];
      return elements.every(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= boardRect.left - 1
          && rect.right <= boardRect.right + 1
          && rect.top >= boardRect.top - 1
          && rect.bottom <= boardRect.bottom + 1;
      });
    });
    assert(portraitRotationContainsBoard,
      'Rotation 90° keeps all pits and stores inside the board bounds');

    await page1.evaluate(() => {
      while (document.getElementById('menu-rotate').textContent !== 'Rotation: Auto') {
        document.getElementById('menu-rotate').click();
      }
    });
    await sleep(300);

    await page1.bringToFront();
    await page1.setViewport({ width: 568, height: 320 });
    await sleep(300);

    const rotatedPhoneState = await page1.evaluate(() => {
      const board = document.querySelector('.board');
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      const pitRect = document.querySelector('.pit').getBoundingClientRect();
      return {
        mode: board.dataset.rotationMode,
        angle: board.dataset.rotationAngle,
        frameWidth: frame.width,
        frameHeight: frame.height,
        pitWidth: pitRect.width,
        pitHeight: pitRect.height,
      };
    });
    assert(rotatedPhoneState.mode === 'auto',
      `Phone rotation test keeps auto mode active: ${rotatedPhoneState.mode}`);
    assert(rotatedPhoneState.angle === '0',
      `Auto rotation switches to the best-fit landscape angle after phone rotation: ${rotatedPhoneState.angle}`);
    assert(rotatedPhoneState.frameWidth > rotatedPhoneState.frameHeight,
      `Landscape phone rotation produces a landscape board frame (${rotatedPhoneState.frameWidth.toFixed(1)} > ${rotatedPhoneState.frameHeight.toFixed(1)})`);
    assert(rotatedPhoneState.frameWidth * rotatedPhoneState.frameHeight
        >= autoRotationState.frameWidth * autoRotationState.frameHeight - 1,
      `Phone rotation picks an equal-or-larger auto-fit layout (${(rotatedPhoneState.frameWidth * rotatedPhoneState.frameHeight).toFixed(1)} >= ${(autoRotationState.frameWidth * autoRotationState.frameHeight).toFixed(1)})`);

    await page1.setViewport({ width: 1280, height: 800 });
    await sleep(300);

    // =========================================================
    console.log('\n=== Game menu: back button closes menu ===');

    await page1.evaluate(() => {
      state.player1 = { addr: 'device0@local.host', name: 'device0' };
      state.player2 = { addr: 'device1@local.host', name: 'device1' };
      state.pits = [[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]];
      state.stores = [[], []];
      state.currentPlayer = 0;
      state.gameOver = false;
      hotseatMode = false;
      localStorage.setItem('mancala-displayMode', 'marbles');
      localStorage.setItem('mancala-animSpeed', '0');
      localStorage.setItem('mancala-showHud', 'false');
      localStorage.setItem('mancala-boardRotation', 'auto');
      localStorage.setItem('mancala-boardSizePercent', '100');
      reloadLocalSettingsFromStorage();
      render();
      openMenu();
    });
    await sleep(200);

    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);

    const menuClosedAfterBack = await page1.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuClosedAfterBack, 'Back button closes the menu');

    // =========================================================
    console.log('\n=== Game menu: right-click on top store also works ===');

    await page1.evaluate(() => {
      const store = document.getElementById('store-top');
      store.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(300);

    const menuOpenTopStore = await page1.$eval('#game-menu', el => el.classList.contains('open'));
    assert(menuOpenTopStore, 'Right-click on top store opens menu');

    // Close it again
    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);

    // =========================================================
    console.log('\n=== Game menu: toggle display from menu ===');

    // Open menu
    await page1.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(200);

    // Click toggle display button
    await page1.evaluate(() => document.getElementById('menu-toggle-display').click());
    await sleep(300);

    // Should now be in numbers mode
    const afterMenuToggle = await page1.$eval('#bottom-row .pit', el => {
      const marbles = el.querySelector('.marbles');
      return !!marbles && getComputedStyle(marbles).display === 'none';
    });
    assert(afterMenuToggle, 'Menu toggle switches to numbers mode');

    // Button label should update
    const toggleBtnAfter = await page1.$eval('#menu-toggle-display', el => el.textContent);
    assert(toggleBtnAfter === 'Switch to Marbles', `Toggle button now says "Switch to Marbles": "${toggleBtnAfter}"`);

    const numbersAnimState = await page1.evaluate(() => ({
      animSpeed,
      sliderValue: document.getElementById('menu-anim-speed').value,
      sliderDisabled: document.getElementById('menu-anim-speed').disabled,
      status: document.getElementById('menu-anim-status').textContent,
    }));
    assert(numbersAnimState.animSpeed === 0, `Numbers mode forces animation off: ${numbersAnimState.animSpeed}`);
    assert(numbersAnimState.sliderValue === '0', `Numbers mode animation slider shows off: ${numbersAnimState.sliderValue}`);
    assert(numbersAnimState.sliderDisabled, 'Numbers mode disables animation slider');
    assert(numbersAnimState.status === 'Not available in Numbers mode',
      `Numbers mode animation status explains unavailable state: "${numbersAnimState.status}"`);

    // Toggle back
    await page1.evaluate(() => document.getElementById('menu-toggle-display').click());
    await sleep(300);

    const backToMarblesMenu = await page1.$eval('#bottom-row .pit', el => el.querySelector('.marbles') !== null);
    assert(backToMarblesMenu, 'Menu toggle switches back to marbles mode');

    const toggleBtnBack = await page1.$eval('#menu-toggle-display', el => el.textContent);
    assert(toggleBtnBack === 'Switch to Numbers', `Toggle button back to "Switch to Numbers": "${toggleBtnBack}"`);

    const pageNR = await browser.newPage();
    await configurePageSettings(pageNR, { animSpeed: '42' }, { beforeNavigation: true });
    await pageNR.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageNR.evaluate(() => {
      document.getElementById('hotseat-btn').click();
      document.getElementById('store-bottom').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(250);
    await pageNR.evaluate(() => document.getElementById('menu-toggle-display').click());
    await sleep(250);
    await pageNR.evaluate(() => document.getElementById('menu-toggle-display').click());
    await sleep(250);
    const restoredNonZeroAnim = await pageNR.evaluate(() => ({
      animSpeed,
      sliderValue: document.getElementById('menu-anim-speed').value,
      sliderDisabled: document.getElementById('menu-anim-speed').disabled,
      status: document.getElementById('menu-anim-status').textContent,
    }));
    assert(restoredNonZeroAnim.animSpeed === 42, `Returning to marbles restores saved non-zero speed: ${restoredNonZeroAnim.animSpeed}`);
    assert(restoredNonZeroAnim.sliderValue === '42', `Returning to marbles restores saved non-zero slider value: ${restoredNonZeroAnim.sliderValue}`);
    assert(!restoredNonZeroAnim.sliderDisabled, 'Returning to marbles with saved non-zero speed re-enables animation slider');
    assert(restoredNonZeroAnim.status === `${Math.round(2000 - (42 - 1) * (1950 / 99))}ms per seed`,
      `Returning to marbles restores non-zero animation status text: "${restoredNonZeroAnim.status}"`);
    await pageNR.close();

    // Toggle turn indicator + scores on, then back off
    await page1.evaluate(() => document.getElementById('menu-toggle-hud').click());
    await sleep(200);

    const hudVisibleFromMenu = await page1.evaluate(() => ({
      status: getComputedStyle(document.getElementById('status')).display,
      scoreboard: getComputedStyle(document.getElementById('scoreboard')).display,
      btn: document.getElementById('menu-toggle-hud').textContent,
    }));
    assert(hudVisibleFromMenu.status !== 'none', `Menu HUD toggle shows turn indicator: ${hudVisibleFromMenu.status}`);
    assert(hudVisibleFromMenu.scoreboard === 'flex', `Menu HUD toggle shows scores: ${hudVisibleFromMenu.scoreboard}`);
    assert(hudVisibleFromMenu.btn === 'Hide Turn Info and Scores',
      `HUD toggle button updates to hide label: "${hudVisibleFromMenu.btn}"`);

    await page1.evaluate(() => document.getElementById('menu-toggle-hud').click());
    await sleep(200);

    const hudHiddenAgainFromMenu = await page1.evaluate(() => ({
      status: getComputedStyle(document.getElementById('status')).display,
      scoreboard: getComputedStyle(document.getElementById('scoreboard')).display,
      btn: document.getElementById('menu-toggle-hud').textContent,
    }));
    assert(hudHiddenAgainFromMenu.status === 'none',
      `Menu HUD toggle hides turn indicator again: ${hudHiddenAgainFromMenu.status}`);
    assert(hudHiddenAgainFromMenu.scoreboard === 'none',
      `Menu HUD toggle hides scores again: ${hudHiddenAgainFromMenu.scoreboard}`);
    assert(hudHiddenAgainFromMenu.btn === 'Show Turn Info and Scores',
      `HUD toggle button updates back to show label: "${hudHiddenAgainFromMenu.btn}"`);

    // Close menu
    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);

    // =========================================================
    console.log('\n=== Game menu: single-click toggle still works ===');

    // Ensure single-click on store still toggles display mode
    await page1.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(300);
    const singleClickToggle = await page1.$eval('#bottom-row .pit', el => {
      const marbles = el.querySelector('.marbles');
      return !!marbles && getComputedStyle(marbles).display === 'none';
    });
    assert(singleClickToggle, 'Single-click on store still toggles to numbers');

    // Toggle back
    await page1.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(300);
    const singleClickBack = await page1.$eval('#bottom-row .pit', el => el.querySelector('.marbles') !== null);
    assert(singleClickBack, 'Single-click on store toggles back to marbles');

    // =========================================================
    console.log('\n=== Game menu: long-press opens menu (mouse) ===');

    await page1.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    });
    await sleep(600); // Wait longer than LONG_PRESS_MS (500ms)

    const menuOpenLongPress = await page1.$eval('#game-menu', el => el.classList.contains('open'));
    assert(menuOpenLongPress, 'Long-press (mouse) opens menu');

    // Release mouse
    await page1.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    });
    await sleep(200);

    // Close menu
    await page1.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(200);

    // =========================================================
    console.log('\n=== Game menu: blocked while animation is active ===');

    const pageMA = await browser.newPage();
    pageMA.on('console', m => console.log(`    [MA] ${m.text()}`));
    pageMA.on('pageerror', e => console.log(`    [MA ERROR] ${e.message}`));

    await configurePageSettings(pageMA, { animSpeed: '10' }, { beforeNavigation: true });

    await pageMA.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageMA.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageMA.waitForSelector('#top-row .pit');

    await pageMA.evaluate(() => {
      state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
      state.stores = [[], []];
      state.pits[1][0] = [24, 25, 26, 27];
      state.pits[1][5] = [28];
      state.pits[0][0] = [0];
      state.currentPlayer = 1;
      state.gameOver = false;
      render();
      window.__menuAnimDone = false;
      animating = true;
      updateMenuButton();
      executeMoveAnimated(1, 0, 350).then(() => {
        animating = false;
        window.__menuAnimDone = true;
      });
    });

    await pageMA.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
    await sleep(120);

    const gearBlockedDuringAnimation = await pageMA.evaluate(() => ({
      disabled: document.getElementById('menu-open-btn').disabled,
      text: document.getElementById('menu-open-btn').textContent,
    }));
    assert(gearBlockedDuringAnimation.disabled, 'Gear button is disabled during animation');
    assert(gearBlockedDuringAnimation.text === '⚙',
      `Gear button stays in closed-state icon during animation lock: "${gearBlockedDuringAnimation.text}"`);

    await pageMA.evaluate(() => document.getElementById('menu-open-btn').click());
    await sleep(120);
    const menuBlockedGearClick = await pageMA.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuBlockedGearClick, 'Gear button cannot open the menu during animation');

    await pageMA.evaluate(() => {
      document.getElementById('store-bottom').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(120);
    const menuBlockedRightClick = await pageMA.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuBlockedRightClick, 'Menu stays closed on right-click during animation');

    await pageMA.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    });
    await sleep(600);
    const menuBlockedLongPress = await pageMA.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuBlockedLongPress, 'Menu stays closed on long-press during animation');

    await pageMA.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    });

    await pageMA.waitForFunction(() => window.__menuAnimDone === true, { timeout: 15000 });
    await pageMA.evaluate(() => {
      document.getElementById('store-bottom').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(120);
    const menuOpensAfterAnimation = await pageMA.$eval('#game-menu', el => el.classList.contains('open'));
    assert(menuOpensAfterAnimation, 'Menu opens again after animation completes');
    await pageMA.close();

    // =========================================================
    console.log('\n=== Display toggle: blocked while animation is active ===');

    const pageDA = await browser.newPage();
    pageDA.on('console', m => console.log(`    [DA] ${m.text()}`));
    pageDA.on('pageerror', e => console.log(`    [DA ERROR] ${e.message}`));

    await configurePageSettings(pageDA, { animSpeed: '10' }, { beforeNavigation: true });

    await pageDA.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageDA.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageDA.waitForSelector('#top-row .pit');

    await pageDA.evaluate(() => {
      state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
      state.stores = [[], []];
      state.pits[1][0] = [24, 25, 26, 27];
      state.pits[1][5] = [28];
      state.pits[0][0] = [0];
      state.currentPlayer = 1;
      state.gameOver = false;
      render();
    });

    await pageDA.evaluate(() => document.querySelector('#bottom-row .pit:nth-child(1)').click());
    await pageDA.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
    await sleep(120);

    await pageDA.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(120);
    const displayBlockedDuringAnimation = await pageDA.evaluate(() => ({
      mode: displayMode,
      marblesHidden: getComputedStyle(document.querySelector('#bottom-row .pit .marbles')).display === 'none',
      animDone: animating === false,
    }));
    assert(displayBlockedDuringAnimation.mode === 'marbles',
      `Display mode stays on marbles during animation: ${displayBlockedDuringAnimation.mode}`);
    assert(!displayBlockedDuringAnimation.marblesHidden,
      'Store click does not switch pits into numbers mode during animation');
    assert(!displayBlockedDuringAnimation.animDone,
      'Display-toggle attempt does not interrupt the running animation');

    await pageDA.waitForFunction(() => animating === false, { timeout: 15000 });
    await pageDA.evaluate(() => document.getElementById('store-bottom').click());
    await sleep(180);
    const displayTogglesAfterAnimation = await pageDA.evaluate(() => ({
      mode: displayMode,
      marblesHidden: getComputedStyle(document.querySelector('#bottom-row .pit .marbles')).display === 'none',
    }));
    assert(displayTogglesAfterAnimation.mode === 'numbers',
      `Display mode can switch after animation completes: ${displayTogglesAfterAnimation.mode}`);
    assert(displayTogglesAfterAnimation.marblesHidden,
      'Store click switches pits to numbers mode after animation completes');
    await pageDA.close();

    // =========================================================
    console.log('\n=== Animation lock state is visible on the board ===');

    const pageLK = await browser.newPage();
    pageLK.on('console', m => console.log(`    [LK] ${m.text()}`));
    pageLK.on('pageerror', e => console.log(`    [LK ERROR] ${e.message}`));

    await configurePageSettings(pageLK, { animSpeed: '10' }, { beforeNavigation: true });

    await pageLK.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageLK.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageLK.waitForSelector('#top-row .pit');

    const initialLockState = await pageLK.evaluate(() => ({
      topClickable: document.querySelectorAll('#top-row .pit.clickable').length,
      bottomClickable: document.querySelectorAll('#bottom-row .pit.clickable').length,
      boardLocked: document.querySelector('.board').classList.contains('input-locked'),
      lockedPits: document.querySelectorAll('.pit.locked').length,
      lockedStores: document.querySelectorAll('.store.locked').length,
    }));
    assert(initialLockState.topClickable === 6, `Before animation, Red has 6 clickable pits: ${initialLockState.topClickable}`);
    assert(initialLockState.bottomClickable === 0, `Before animation, Green has 0 clickable pits: ${initialLockState.bottomClickable}`);
    assert(!initialLockState.boardLocked, 'Before animation, board is not marked as locked');
    assert(initialLockState.lockedPits === 0, `Before animation, no pits are marked locked: ${initialLockState.lockedPits}`);
    assert(initialLockState.lockedStores === 0, `Before animation, no stores are marked locked: ${initialLockState.lockedStores}`);

    await pageLK.evaluate(() => document.querySelector('#top-row .pit:nth-child(1)').click());
    await pageLK.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
    await sleep(120);

    const duringLockState = await pageLK.evaluate(() => ({
      topClickable: document.querySelectorAll('#top-row .pit.clickable').length,
      bottomClickable: document.querySelectorAll('#bottom-row .pit.clickable').length,
      boardLocked: document.querySelector('.board').classList.contains('input-locked'),
      lockedPits: document.querySelectorAll('.pit.locked').length,
      disabledPits: document.querySelectorAll('.pit.disabled').length,
      lockedStores: document.querySelectorAll('.store.locked').length,
      animating,
    }));
    assert(duringLockState.animating, 'Animation lock test is sampling while animation is active');
    assert(duringLockState.topClickable === 0, `During animation, top row has 0 clickable pits: ${duringLockState.topClickable}`);
    assert(duringLockState.bottomClickable === 0, `During animation, bottom row has 0 clickable pits: ${duringLockState.bottomClickable}`);
    assert(duringLockState.boardLocked, 'During animation, board is marked as locked');
    assert(duringLockState.lockedPits === 12, `During animation, all 12 pits are marked locked: ${duringLockState.lockedPits}`);
    assert(duringLockState.disabledPits === 12, `During animation, all 12 pits are disabled: ${duringLockState.disabledPits}`);
    assert(duringLockState.lockedStores === 2, `During animation, both stores are marked locked: ${duringLockState.lockedStores}`);

    await pageLK.waitForFunction(() => animating === false, { timeout: 15000 });
    await sleep(120);

    const afterLockState = await pageLK.evaluate(() => ({
      clickablePits: document.querySelectorAll('.pit.clickable').length,
      boardLocked: document.querySelector('.board').classList.contains('input-locked'),
      lockedPits: document.querySelectorAll('.pit.locked').length,
      lockedStores: document.querySelectorAll('.store.locked').length,
    }));
    assert(afterLockState.clickablePits > 0, `After animation, clickable pits return: ${afterLockState.clickablePits}`);
    assert(!afterLockState.boardLocked, 'After animation, board lock marker is cleared');
    assert(afterLockState.lockedPits === 0, `After animation, no pits remain locked: ${afterLockState.lockedPits}`);
    assert(afterLockState.lockedStores === 0, `After animation, no stores remain locked: ${afterLockState.lockedStores}`);
    await pageLK.close();

    // =========================================================
    console.log('\n=== Incoming animation waits for menu close ===');

    const pageMS = await browser.newPage();
    const pageMR = await browser.newPage();
    pageMS.on('console', m => console.log(`    [MS] ${m.text()}`));
    pageMR.on('console', m => console.log(`    [MR] ${m.text()}`));
    pageMR.on('pageerror', e => console.log(`    [MR ERROR] ${e.message}`));

    await configurePageSettings(pageMS, {}, { beforeNavigation: true });
    await configurePageSettings(pageMR, { animSpeed: '10' }, { beforeNavigation: true });

    await pageMS.goto(`http://localhost:${PORT}/index.html#name=menusender&addr=menusender@local.host`, { waitUntil: 'networkidle0' });
    await pageMR.goto(`http://localhost:${PORT}/index.html#name=menureceiver&addr=menureceiver@local.host`, { waitUntil: 'networkidle0' });

    await configurePageSettings(pageMS);
    await configurePageSettings(pageMR, { animSpeed: '10' });
    await pageMS.evaluate(() => render());
    await pageMR.evaluate(() => render());

    await pageMS.evaluate(() => document.getElementById('join-btn').click());
    await sleep(500);
    await pageMR.evaluate(() => document.getElementById('join-btn').click());
    await sleep(700);

    await pageMR.evaluate(() => {
      document.getElementById('store-bottom').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(200);
    const menuWasOpenBeforeMove = await pageMR.$eval('#game-menu', el => el.classList.contains('open'));
    assert(menuWasOpenBeforeMove, 'Receiver menu is open before incoming move');

    await pageMS.evaluate(() => document.querySelector('#bottom-row .pit:nth-child(1)').click());
    await sleep(500);

    const queuedWhileMenuOpen = await pageMR.evaluate(() => {
      const boardFrame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        menuOpen: document.getElementById('game-menu').classList.contains('open'),
        queuedMoves: pendingMenuMoveQueue.length,
        animating,
        floaters: document.querySelectorAll('.marble-float').length,
        currentPlayer: state.currentPlayer,
        pits: state.pits.map(row => row.slice()),
        stores: state.stores.slice(),
        rotationMode: document.querySelector('.board').dataset.rotationMode,
        frameWidth: boardFrame.width,
        frameHeight: boardFrame.height,
      };
    });
    assert(queuedWhileMenuOpen.menuOpen, 'Menu stays open while the incoming move is queued');
    assert(queuedWhileMenuOpen.queuedMoves === 1, `Incoming move is queued while menu stays open: ${queuedWhileMenuOpen.queuedMoves}`);
    assert(!queuedWhileMenuOpen.animating, 'Receiver does not start animating while menu is open');
    assert(queuedWhileMenuOpen.floaters === 0, `No floating marbles appear before the menu closes: ${queuedWhileMenuOpen.floaters}`);
    assert(queuedWhileMenuOpen.currentPlayer === 0, `Board state does not advance while move is queued: ${queuedWhileMenuOpen.currentPlayer}`);
    assert(JSON.stringify(queuedWhileMenuOpen.pits) === JSON.stringify([[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]]),
      `Pit counts stay at the pre-move state while queued: ${JSON.stringify(queuedWhileMenuOpen.pits)}`);
    assert(JSON.stringify(queuedWhileMenuOpen.stores) === JSON.stringify([0, 0]),
      `Store counts stay at the pre-move state while queued: ${JSON.stringify(queuedWhileMenuOpen.stores)}`);

    await pageMR.evaluate(() => {
      document.getElementById('menu-rotate').click();
      document.getElementById('menu-board-size').value = '85';
      menuBoardSizeChanged('85');
    });
    await sleep(150);

    const allowedMenuControlsStillWork = await pageMR.evaluate((before) => {
      const boardFrame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        rotationMode: document.querySelector('.board').dataset.rotationMode,
        frameWidth: boardFrame.width,
        frameHeight: boardFrame.height,
        animating,
      };
    }, queuedWhileMenuOpen);
    assert(!allowedMenuControlsStillWork.animating, 'Queued incoming move still does not animate while the menu remains open');
    assert(allowedMenuControlsStillWork.rotationMode !== queuedWhileMenuOpen.rotationMode,
      `Rotate control still updates board rotation while move is queued: ${allowedMenuControlsStillWork.rotationMode}`);
    assert(allowedMenuControlsStillWork.frameWidth !== queuedWhileMenuOpen.frameWidth
        || allowedMenuControlsStillWork.frameHeight !== queuedWhileMenuOpen.frameHeight,
      `Board size control still updates board frame while move is queued: ${allowedMenuControlsStillWork.frameWidth}x${allowedMenuControlsStillWork.frameHeight}`);

    await pageMR.evaluate(() => document.getElementById('menu-open-btn').click());
    await pageMR.waitForFunction(() => animating === true && document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
    await sleep(120);
    const animationStartsAfterClose = await pageMR.evaluate(() => ({
      menuOpen: document.getElementById('game-menu').classList.contains('open'),
      queuedMoves: pendingMenuMoveQueue.length,
      animating,
      floaters: document.querySelectorAll('.marble-float').length,
    }));
    assert(!animationStartsAfterClose.menuOpen, 'Menu closes before the deferred animation begins');
    assert(animationStartsAfterClose.queuedMoves === 0, `Deferred move queue drains when the menu closes: ${animationStartsAfterClose.queuedMoves}`);
    assert(animationStartsAfterClose.animating, 'Deferred remote move starts animating after menu close');
    assert(animationStartsAfterClose.floaters > 0, `Floating marbles appear after menu close: ${animationStartsAfterClose.floaters}`);

    await pageMR.waitForFunction(() => animating === false, { timeout: 15000 });
    await sleep(150);
    const senderState = await pageMS.evaluate(() => ({
      pits: state.pits.map(row => row.slice()),
      stores: state.stores.slice(),
      currentPlayer: state.currentPlayer,
      gameOver: state.gameOver,
    }));
    const receiverState = await pageMR.evaluate(() => ({
      pits: state.pits.map(row => row.slice()),
      stores: state.stores.slice(),
      currentPlayer: state.currentPlayer,
      gameOver: state.gameOver,
    }));
    assert(JSON.stringify(receiverState) === JSON.stringify(senderState),
      'Receiver catches up to sender after closing menu and playing the deferred animation');
    await pageMS.close();
    await pageMR.close();

    // =========================================================
    console.log('\n=== Game menu: quit with confirm (online mode) ===');

    // Open menu
    await page1.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(200);

    // Override confirm to return false (cancel quit)
    await page1.evaluate(() => {
      window.__origConfirm = window.confirm;
      window.confirm = () => false;
    });

    await page1.evaluate(() => document.getElementById('menu-quit').click());
    await sleep(300);

    // Menu should still be open (quit was cancelled) — actually menuQuit doesn't close menu on cancel
    // and the game screen should still be visible
    const gameStillVisible = await page1.$eval('#game-screen', el => el.style.display === 'block');
    assert(gameStillVisible, 'Quit cancelled: game screen still visible');

    // Now confirm quit
    await page1.evaluate(() => {
      window.confirm = () => true;
    });

    await page1.evaluate(() => document.getElementById('menu-quit').click());
    await sleep(500);

    // Should return to join screen (newGame sends webxdc update which resets state)
    const afterQuitJoin = await page1.$eval('#join-screen', el => el.style.display !== 'none');
    assert(afterQuitJoin, 'Quit confirmed: returns to join screen');

    // Menu should be closed
    const menuClosedAfterQuit = await page1.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(menuClosedAfterQuit, 'Menu is closed after quit');

    // Restore confirm
    await page1.evaluate(() => {
      window.confirm = window.__origConfirm;
    });

    // =========================================================
    // Game Menu in Hotseat mode
    // =========================================================
    console.log('\n=== Game menu: hotseat mode ===');

    // Open a fresh isolated hotseat page for menu tests so shared online-game
    // localStorage traffic from earlier pages cannot interfere.
    const hotseatMenuContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageHM = await hotseatMenuContext.newPage();
    pageHM.on('console', m => console.log(`    [HM] ${m.text()}`));
    await pageHM.goto(`http://localhost:${PORT}/index.html#name=menutest&addr=menutest@local.host`, { waitUntil: 'networkidle0' });

    // Start hotseat
    await pageHM.evaluate(() => {
      localStorage.setItem('mancala-displayMode', 'marbles');
      localStorage.setItem('mancala-animSpeed', '0');
      reloadLocalSettingsFromStorage();
      document.getElementById('hotseat-btn').click();
    });
    await sleep(300);

    const hmMenuOpenState = await pageHM.evaluate(() => {
      document.getElementById('store-bottom').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return {
        menuOpen,
        openClass: document.getElementById('game-menu').classList.contains('open'),
      };
    });
    assert(hmMenuOpenState.menuOpen && hmMenuOpenState.openClass,
      'Hotseat: right-click opens menu');

    const hmHudToggleLabel = await pageHM.$eval('#menu-toggle-hud', el => el.textContent);
    assert(hmHudToggleLabel === 'Show Turn Info and Scores',
      `Hotseat: HUD toggle button says "Show Turn Info and Scores": "${hmHudToggleLabel}"`);

    await pageHM.evaluate(() => document.getElementById('menu-toggle-hud').click());
    await sleep(200);

    const hmHudVisible = await pageHM.evaluate(() => ({
      status: getComputedStyle(document.getElementById('status')).display,
      scoreboard: getComputedStyle(document.getElementById('scoreboard')).display,
      btn: document.getElementById('menu-toggle-hud').textContent,
    }));
    assert(hmHudVisible.status !== 'none', `Hotseat: HUD toggle shows turn indicator: ${hmHudVisible.status}`);
    assert(hmHudVisible.scoreboard === 'flex', `Hotseat: HUD toggle shows scores: ${hmHudVisible.scoreboard}`);
    assert(hmHudVisible.btn === 'Hide Turn Info and Scores',
      `Hotseat: HUD toggle button updates to hide label: "${hmHudVisible.btn}"`);

    // Quit with confirm
    await pageHM.evaluate(() => { window.confirm = () => true; });
    await pageHM.evaluate(() => document.getElementById('menu-quit').click());
    await sleep(300);

    const hmAfterQuit = await pageHM.$eval('#join-screen', el => el.style.display !== 'none');
    assert(hmAfterQuit, 'Hotseat: quit from menu returns to join screen');

    const hmMenuClosed = await pageHM.$eval('#game-menu', el => !el.classList.contains('open'));
    assert(hmMenuClosed, 'Hotseat: menu closed after quit');

    await pageHM.close();
    await hotseatMenuContext.close();

    // =========================================================
    // Opponent quit notification
    // =========================================================
    console.log('\n=== Opponent quit: P1 quits, P2 sees dialog ===');

    // Use an isolated context so earlier multiplayer pages cannot bleed
    // storage-backed updates into this quit-dialog regression.
    const quitTestContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageQ1 = await quitTestContext.newPage();
    const pageQ2 = await quitTestContext.newPage();
    pageQ1.on('console', m => console.log(`    [Q1] ${m.text()}`));
    pageQ2.on('console', m => console.log(`    [Q2] ${m.text()}`));

    await pageQ1.goto(`http://localhost:${PORT}/index.html#name=quit1&addr=quit1@local.host`, { waitUntil: 'networkidle0' });
    await pageQ2.goto(`http://localhost:${PORT}/index.html#name=quit2&addr=quit2@local.host`, { waitUntil: 'networkidle0' });

    // Both join
    await pageQ1.evaluate(() => document.getElementById('join-btn').click());
    await sleep(500);
    await pageQ2.evaluate(() => document.getElementById('join-btn').click());
    await sleep(500);

    // Verify both are in game
    const q1gameVisible = await pageQ1.$eval('#game-screen', el => el.style.display === 'block');
    const q2gameVisible = await pageQ2.$eval('#game-screen', el => el.style.display === 'block');
    assert(q1gameVisible, 'Quit test: P1 sees game screen');
    assert(q2gameVisible, 'Quit test: P2 sees game screen');

    // Verify quit dialog is initially hidden on both
    const q1dialogHidden = await pageQ1.$eval('#quit-dialog', el => !el.classList.contains('open'));
    const q2dialogHidden = await pageQ2.$eval('#quit-dialog', el => !el.classList.contains('open'));
    assert(q1dialogHidden, 'Quit test: P1 quit dialog initially hidden');
    assert(q2dialogHidden, 'Quit test: P2 quit dialog initially hidden');

    // P1 opens menu and quits
    await pageQ1.evaluate(() => { window.confirm = () => true; });
    await pageQ1.evaluate(() => {
      const store = document.getElementById('store-bottom');
      store.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await sleep(200);
    await pageQ1.evaluate(() => document.getElementById('menu-quit').click());
    await sleep(800);

    // P1 (the quitter) should be on join screen with NO quit dialog
    const q1onJoin = await pageQ1.$eval('#join-screen', el => el.style.display !== 'none');
    assert(q1onJoin, 'Quit test: quitter (P1) returns to join screen');

    const q1noDialog = await pageQ1.$eval('#quit-dialog', el => !el.classList.contains('open'));
    assert(q1noDialog, 'Quit test: quitter (P1) does NOT see quit dialog');

    // P2 (the opponent) should see the quit dialog
    const q2dialogOpen = await pageQ2.$eval('#quit-dialog', el => el.classList.contains('open'));
    assert(q2dialogOpen, 'Quit test: opponent (P2) sees quit dialog');

    // Verify dialog message text
    const q2dialogMsg = await pageQ2.$eval('#quit-message', el => el.textContent);
    assert(q2dialogMsg === 'Your opponent quit!', `Quit test: dialog says "Your opponent quit!": "${q2dialogMsg}"`);

    // Verify OK button exists
    const q2okBtn = await pageQ2.$eval('#quit-ok', el => el.textContent);
    assert(q2okBtn === 'OK', `Quit test: OK button text: "${q2okBtn}"`);

    // P2 should NOT be on join screen yet (dialog is blocking)
    // The game screen or join screen might be visible underneath, but the dialog overlay covers everything
    // After state reset, render() would show join screen — let's verify the dialog is on top
    const q2dialogZindex = await pageQ2.$eval('#quit-dialog', el => {
      const style = window.getComputedStyle(el);
      return parseInt(style.zIndex);
    });
    assert(q2dialogZindex >= 100, `Quit test: dialog has high z-index: ${q2dialogZindex}`);

    // P2 clicks OK to dismiss the dialog
    await pageQ2.evaluate(() => document.getElementById('quit-ok').click());
    await sleep(300);

    // Dialog should be closed
    const q2dialogClosed = await pageQ2.$eval('#quit-dialog', el => !el.classList.contains('open'));
    assert(q2dialogClosed, 'Quit test: dialog closed after clicking OK');

    // P2 should now be on the join screen
    const q2onJoin = await pageQ2.$eval('#join-screen', el => el.style.display !== 'none');
    assert(q2onJoin, 'Quit test: P2 on join screen after dismissing dialog');

    await pageQ1.close();
    await pageQ2.close();
    await quitTestContext.close();

    // =========================================================
    // Animation race condition: P1 anim ON, P2 anim OFF
    // P1 makes a move, P2 responds before P1 animation finishes
    // =========================================================
    console.log('\n=== Animation race: P1 anim ON, P2 anim OFF ===');

    const raceTestContext = browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const pageA1 = await raceTestContext.newPage();
    const pageA2 = await raceTestContext.newPage();
    pageA1.on('console', m => console.log(`    [A1] ${m.text()}`));
    pageA2.on('console', m => console.log(`    [A2] ${m.text()}`));
    pageA1.on('pageerror', e => console.log(`    [A1 ERROR] ${e.message}`));
    pageA2.on('pageerror', e => console.log(`    [A2 ERROR] ${e.message}`));

    await configurePageSettings(pageA1, { animSpeed: '10' }, { beforeNavigation: true });
    await configurePageSettings(pageA2, {}, { beforeNavigation: true });

    await pageA1.goto(`http://localhost:${PORT}/index.html#name=anim1&addr=anim1@local.host`, { waitUntil: 'networkidle0' });
    await pageA2.goto(`http://localhost:${PORT}/index.html#name=anim2&addr=anim2@local.host`, { waitUntil: 'networkidle0' });

    // Both join
    await pageA1.evaluate(() => document.getElementById('join-btn').click());
    await sleep(500);
    await pageA2.evaluate(() => document.getElementById('join-btn').click());
    await sleep(500);

    // P1 turns animation ON with slow speed (animSpeed=10 = ~550ms per seed)
    await configurePageSettings(pageA1, { animSpeed: '10' });

    // P2 keeps animation OFF (default 0)
    await configurePageSettings(pageA2);

    // Re-render both pages so the settings take effect
    await pageA1.evaluate(() => window.render());
    await pageA2.evaluate(() => window.render());

    // Verify both see the game screen
    const a1gameVisible = await pageA1.$eval('#game-screen', el => el.style.display === 'block');
    const a2gameVisible = await pageA2.$eval('#game-screen', el => el.style.display === 'block');
    assert(a1gameVisible, 'Race test: P1 sees game screen');
    assert(a2gameVisible, 'Race test: P2 sees game screen');

    // P1 (currentPlayer=0) makes a move from pit 0 (has 4 seeds)
    // With animSpeed=10, each seed takes ~550ms, so 4 seeds = ~2.2s animation
    await pageA1.evaluate(() => {
      const pits = document.querySelectorAll('#bottom-row .pit');
      pits[0].click();
    });

    // Wait 500ms - P1's animation is still running (first seed barely dropped)
    // P2 responds immediately (animation OFF = instant)
    await sleep(500);

    // P2 makes a move from their pit 0
    await pageA2.evaluate(() => {
      const pits = document.querySelectorAll('#bottom-row .pit');
      pits[0].click();
    });

    await sleep(250);
    const queuedRaceState = await pageA1.evaluate(() => ({
      animating,
      queuedMoves: pendingMoveQueue.length,
      floaters: document.querySelectorAll('.marble-float').length,
    }));
    assert(queuedRaceState.animating, 'Race test: animated client is still animating after opponent responds');
    assert(queuedRaceState.queuedMoves === 1, `Race test: opponent move queues while first animation is in flight: ${queuedRaceState.queuedMoves}`);
    assert(queuedRaceState.floaters > 0,
      `Race test: local animation still has floating marbles while opponent move is queued: ${queuedRaceState.floaters}`);

    let queuedAnimationInFlight = null;
    for (let i = 0; i < 30; i++) {
      queuedAnimationInFlight = await pageA1.evaluate(() => ({
        queuedMoves: pendingMoveQueue.length,
        animating,
        floaters: document.querySelectorAll('.marble-float').length,
        currentPlayer: state.currentPlayer,
        pits: state.pits.map(row => row.slice()),
      }));
      if (queuedAnimationInFlight.queuedMoves === 0
          && queuedAnimationInFlight.animating
          && queuedAnimationInFlight.floaters > 0) {
        break;
      }
      await sleep(1000);
    }
    assert(queuedAnimationInFlight.queuedMoves === 0,
      `Race test: queued move is removed from the queue once its animation starts: ${queuedAnimationInFlight.queuedMoves}`);
    assert(queuedAnimationInFlight.animating && queuedAnimationInFlight.floaters > 0,
      `Race test: queued opponent move animates with floating marbles: ${queuedAnimationInFlight.floaters}`);
    assert(queuedAnimationInFlight.currentPlayer === 1,
      `Race test: board is still in the post-first-move turn state while queued animation runs: ${queuedAnimationInFlight.currentPlayer}`);
    assert(JSON.stringify(queuedAnimationInFlight.pits[0]) === JSON.stringify([0, 5, 5, 5, 5, 4]),
      `Race test: first move has completed before queued animation finishes: ${JSON.stringify(queuedAnimationInFlight.pits[0])}`);

    // Let the animated page finish its move and drain any queued updates.
    await sleep(8000);

    // Verify both pages have consistent state
    const a1bottom = await pageA1.$$eval('#bottom-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    const a1top = await pageA1.$$eval('#top-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    const a1storeBottom = await pageA1.$eval('#store-bottom-val', el => el.textContent);
    const a1storeTop = await pageA1.$eval('#store-top-val', el => el.textContent);

    const a2bottom = await pageA2.$$eval('#bottom-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    const a2top = await pageA2.$$eval('#top-row .pit', pits =>
      pits.map(p => p.querySelectorAll('.marble').length));
    const a2storeBottom = await pageA2.$eval('#store-bottom-val', el => el.textContent);
    const a2storeTop = await pageA2.$eval('#store-top-val', el => el.textContent);

    // P1 bottom = P2 top (same player), P1 top = P2 bottom (same player)
    const a1bottomReversed = [...a1bottom].reverse();
    const a1topReversed = [...a1top].reverse();

    assert(JSON.stringify(a1bottomReversed) === JSON.stringify(a2top),
      `Race test: P1 bottom matches P2 top: [${a1bottomReversed}] vs [${a2top}]`);
    assert(JSON.stringify(a1topReversed) === JSON.stringify(a2bottom),
      `Race test: P1 top matches P2 bottom: [${a1topReversed}] vs [${a2bottom}]`);

    // CRITICAL: verify BOTH moves actually happened
    // P1 moved from pit 0 (should be 0), P2 moved from pit 0 (should be 0)
    // P1's pits are at bottom for P1 (left-to-right: 0,1,2,3,4,5)
    // P2's pits are at bottom for P2 (left-to-right: 0,1,2,3,4,5)
    const p1pit0after = a1bottom[0]; // P1's pit 0 (leftmost in bottom row)
    const p2pit0after = a2bottom[0]; // P2's pit 0 (leftmost in bottom row)
    assert(p1pit0after === 0, `Race test: P1 pit 0 emptied after move: ${p1pit0after}`);
    assert(p2pit0after === 0, `Race test: P2 pit 0 emptied after move: ${p2pit0after}`);

    // Verify total seeds are conserved (48 total)
    const totalA1 = a1bottom.reduce((a, b) => a + b, 0) + a1top.reduce((a, b) => a + b, 0)
      + parseInt(a1storeBottom) + parseInt(a1storeTop);
    assert(totalA1 === 48, `Race test: total seeds conserved on P1: ${totalA1}`);

    const totalA2 = a2bottom.reduce((a, b) => a + b, 0) + a2top.reduce((a, b) => a + b, 0)
      + parseInt(a2storeBottom) + parseInt(a2storeTop);
    assert(totalA2 === 48, `Race test: total seeds conserved on P2: ${totalA2}`);

    await pageA1.close();
    await pageA2.close();
    await raceTestContext.close();

    // =========================================================
    // Animation marble color stability: the floating marble's
    // color must match the color of the marble that appears in
    // the target pit after the floater is removed and render() runs.
    // =========================================================
    console.log('\n=== Animation marble color stability ===');

    // Fresh hotseat page with animation ON (slow)
    const pageC = await browser.newPage();
    pageC.on('console', m => console.log(`    [C] ${m.text()}`));
    pageC.on('pageerror', e => console.log(`    [C ERROR] ${e.message}`));

    await configurePageSettings(pageC, { animSpeed: '10' }, { beforeNavigation: true });

    await pageC.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageC.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageC.waitForSelector('#top-row .pit');

    // Record colors of all marbles in pit 1 BEFORE the move
    const pit1BeforeColors = await pageC.$$eval('#top-row .pit:nth-child(5) .marble', marbles =>
      marbles.map(m => m.style.background));

    // Click Red's pit 0 (top row, rightmost = DOM index 5)
    await pageC.evaluate(() => {
      const pits = document.querySelectorAll('#top-row .pit');
      pits[5].click();
    });

    // Wait for pit 1 (DOM index 4 = nth-child(5)) to gain its 5th marble
    await pageC.waitForFunction(() => {
      const pit1 = document.querySelectorAll('#top-row .pit')[4];
      return pit1.querySelectorAll('.marble').length === 5;
    }, { timeout: 15000 });

    // Capture the color of the NEW 5th marble mid-animation (before floater removed)
    const newMarbleMidColor = await pageC.evaluate(() => {
      const pit1 = document.querySelectorAll('#top-row .pit')[4];
      const marbles = pit1.querySelectorAll('.marble');
      return marbles[4].style.background;
    });

    // The 5th marble's color must be different from the first 4 (it's a new marble)
    // But the first 4 must match their pre-move colors exactly
    const pit1MidColors = await pageC.$$eval('#top-row .pit:nth-child(5) .marble', marbles =>
      marbles.map(m => m.style.background));

    const existingUnchanged = pit1MidColors.slice(0, 4).every((c, i) => c === pit1BeforeColors[i]);
    assert(existingUnchanged,
      `Anim color stable: existing pit 1 marbles unchanged mid-animation`);

    // Wait for animation to fully complete
    await pageC.waitForFunction(() => {
      const floaters = document.querySelectorAll('.marble-float');
      return floaters.length === 0;
    }, { timeout: 15000 });
    await sleep(500);

    // After animation, the 5th marble must have the SAME color as mid-animation
    const pit1AfterColors = await pageC.$$eval('#top-row .pit:nth-child(5) .marble', marbles =>
      marbles.map(m => m.style.background));

    assert(pit1AfterColors[4] === newMarbleMidColor,
      `Anim color stable: 5th marble color unchanged after render: "${newMarbleMidColor.substring(0,50)}" vs "${pit1AfterColors[4].substring(0,50)}"`);

    // And the first 4 must STILL match the original colors
    const existingStillUnchanged = pit1AfterColors.slice(0, 4).every((c, i) => c === pit1BeforeColors[i]);
    assert(existingStillUnchanged,
      `Anim color stable: existing pit 1 marbles still unchanged after render`);

    await pageC.close();

    // =========================================================
    // Animation marble sizing follows the rendered board size
    // =========================================================
    console.log('\n=== Animation marble sizing follows board scale ===');

    const pageAS = await browser.newPage();
    pageAS.on('console', m => console.log(`    [AS] ${m.text()}`));
    pageAS.on('pageerror', e => console.log(`    [AS ERROR] ${e.message}`));

    await configurePageSettings(pageAS, { animSpeed: '10', boardSizePercent: '70', boardRotation: '0' }, { beforeNavigation: true });

    await pageAS.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageAS.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageAS.waitForSelector('#top-row .pit');

    const sourceMarbleSize = await pageAS.$eval('#top-row .pit:nth-child(6) .marble', marble => {
      const rect = marble.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert(sourceMarbleSize.width > 0 && sourceMarbleSize.height > 0,
      `Anim size: source pit marble has a measurable size: ${sourceMarbleSize.width.toFixed(2)}x${sourceMarbleSize.height.toFixed(2)}`);

    await pageAS.evaluate(() => {
      const pits = document.querySelectorAll('#top-row .pit');
      pits[5].click();
    });

    await pageAS.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });

    const floatingMarbleSize = await pageAS.$eval('.marble-float', marble => ({
      className: marble.className,
      width: parseFloat(marble.style.width),
      height: parseFloat(marble.style.height),
    }));
    assert(floatingMarbleSize.className.includes('marble-float'),
      `Anim size: floating marble gets animation class: "${floatingMarbleSize.className}"`);
    assert(Math.abs(floatingMarbleSize.width - sourceMarbleSize.width) < 0.5,
      `Anim size: floating marble width matches rendered pit marble size: ${floatingMarbleSize.width.toFixed(2)} vs ${sourceMarbleSize.width.toFixed(2)}`);
    assert(Math.abs(floatingMarbleSize.height - sourceMarbleSize.height) < 0.5,
      `Anim size: floating marble height matches rendered pit marble size: ${floatingMarbleSize.height.toFixed(2)} vs ${sourceMarbleSize.height.toFixed(2)}`);

    await pageAS.waitForFunction(() => document.querySelectorAll('.marble-float').length === 0, { timeout: 15000 });
    await pageAS.close();

    // =========================================================
    // Pickup lift direction stays outside the board for both sides
    // =========================================================
    console.log('\n=== Pickup lift direction stays outside ===');

    const pagePL = await browser.newPage();
    pagePL.on('console', m => console.log(`    [PL] ${m.text()}`));
    pagePL.on('pageerror', e => console.log(`    [PL ERROR] ${e.message}`));

    await configurePageSettings(pagePL, { animSpeed: '10' }, { beforeNavigation: true });

    await pagePL.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pagePL.evaluate(() => document.getElementById('hotseat-btn').click());
    await pagePL.waitForSelector('#top-row .pit');

    async function assertPickupDirection(playerIdx, sourceSelector, label) {
      await pagePL.evaluate((idx) => {
        state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
        state.stores = [[], []];
        state.pits[idx][5] = [idx === 0 ? 0 : 24];
        state.pits[idx][0] = [idx === 0 ? 1 : 25];
        state.pits[1 - idx][0] = [idx === 0 ? 24 : 0];
        state.currentPlayer = idx;
        state.gameOver = false;
        render();
        window.__pickupDone = false;
        executeMoveAnimated(idx, 5, 500).then(() => { window.__pickupDone = true; });
      }, playerIdx);

      await pagePL.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
      await sleep(180);

      const duringPickup = await pagePL.$eval(sourceSelector, (sourceEl) => {
        const sourceRect = sourceEl.getBoundingClientRect();
        const floaterRect = document.querySelector('.marble-float').getBoundingClientRect();
        return {
          sourceY: sourceRect.top + sourceRect.height / 2,
          floaterY: floaterRect.top + floaterRect.height / 2,
        };
      });

      if (playerIdx === 0) {
        assert(duringPickup.floaterY < duringPickup.sourceY - 1,
          `${label}: top-row pickup lifts outward/up (${duringPickup.floaterY.toFixed(1)} < ${duringPickup.sourceY.toFixed(1)})`);
      } else {
        assert(duringPickup.floaterY > duringPickup.sourceY + 1,
          `${label}: bottom-row pickup lifts outward/down (${duringPickup.floaterY.toFixed(1)} > ${duringPickup.sourceY.toFixed(1)})`);
      }

      await pagePL.waitForFunction(() => window.__pickupDone === true, { timeout: 15000 });
    }

    await assertPickupDirection(0, '#top-row .pit:nth-child(1)', 'Pickup direction red');
    await assertPickupDirection(1, '#bottom-row .pit:nth-child(6)', 'Pickup direction green');
    await pagePL.close();

    // =========================================================
    // Transform-only changes stay safe during animation
    // =========================================================
    console.log('\n=== Transform changes stay safe during animation ===');

    const transformErrors = [];
    const pageAT = await browser.newPage();
    pageAT.on('console', m => console.log(`    [AT] ${m.text()}`));
    pageAT.on('pageerror', e => {
      transformErrors.push(e.message);
      console.log(`    [AT ERROR] ${e.message}`);
    });
    await pageAT.setViewport({ width: 844, height: 390 });

    await configurePageSettings(pageAT, { animSpeed: '10', boardRotation: '0', boardSizePercent: '100' }, { beforeNavigation: true });

    await pageAT.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageAT.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageAT.waitForSelector('#top-row .pit');
    await pageAT.evaluate(() => {
      state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
      state.stores = [[], []];
      state.pits[1][0] = [24, 25, 26, 27];
      state.pits[1][5] = [28];
      state.pits[0][0] = [0];
      state.currentPlayer = 1;
      state.gameOver = false;
      boardRotationMode = '0';
      boardSizePercent = 100;
      render();
      openMenu();
      window.__animDone = false;
      executeMoveAnimated(1, 0, 350).then(() => { window.__animDone = true; });
    });

    await pageAT.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
    await sleep(120);

    const transformBefore = await pageAT.evaluate(() => {
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        angle: document.querySelector('.board').dataset.rotationAngle,
        area: frame.width * frame.height,
        animDone: window.__animDone === true,
        floaters: document.querySelectorAll('.marble-float').length,
      };
    });

    await pageAT.evaluate(() => document.getElementById('menu-rotate').click());
    await sleep(120);

    const transformAfterRotate = await pageAT.evaluate(() => {
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        angle: document.querySelector('.board').dataset.rotationAngle,
        area: frame.width * frame.height,
        animDone: window.__animDone === true,
        floaters: document.querySelectorAll('.marble-float').length,
      };
    });
    assert(transformAfterRotate.angle === '90',
      `Animation-time rotation applies immediately: ${transformAfterRotate.angle}`);
    assert(!transformAfterRotate.animDone && transformAfterRotate.floaters > 0,
      `Animation-time rotation keeps animation running with floaters present: ${transformAfterRotate.floaters}`);

    await pageAT.evaluate(() => {
      const slider = document.getElementById('menu-board-size');
      slider.value = '80';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(120);

    const transformAfterSize = await pageAT.evaluate(() => {
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        area: frame.width * frame.height,
        animDone: window.__animDone === true,
        floaters: document.querySelectorAll('.marble-float').length,
      };
    });
    assert(transformAfterSize.area < transformAfterRotate.area,
      `Animation-time board resize shrinks frame area (${transformAfterSize.area.toFixed(1)} < ${transformAfterRotate.area.toFixed(1)})`);
    assert(!transformAfterSize.animDone && transformAfterSize.floaters > 0,
      `Animation-time board resize keeps animation running with floaters present: ${transformAfterSize.floaters}`);

    await pageAT.setViewport({ width: 390, height: 844 });
    await sleep(180);

    const transformAfterViewport = await pageAT.evaluate(() => {
      const board = document.querySelector('.board').getBoundingClientRect();
      const floater = document.querySelector('.marble-float').getBoundingClientRect();
      const frame = document.getElementById('board-frame').getBoundingClientRect();
      return {
        area: frame.width * frame.height,
        animDone: window.__animDone === true,
        floaters: document.querySelectorAll('.marble-float').length,
        insideBoard: floater.left >= board.left - 1
          && floater.right <= board.right + 1
          && floater.top >= board.top - 1
          && floater.bottom <= board.bottom + 1,
      };
    });
    assert(transformAfterViewport.area !== transformAfterSize.area,
      `Viewport change updates board frame during animation (${transformAfterViewport.area.toFixed(1)} vs ${transformAfterSize.area.toFixed(1)})`);
    assert(transformAfterViewport.insideBoard,
      'Viewport change keeps animation floater inside the transformed board');
    assert(!transformAfterViewport.animDone && transformAfterViewport.floaters > 0,
      `Viewport change keeps animation running with floaters present: ${transformAfterViewport.floaters}`);

    await pageAT.waitForFunction(() => window.__animDone === true, { timeout: 15000 });
    const transformFinal = await pageAT.evaluate(() => ({
      pits: state.pits.map(row => [...row]),
      stores: [...state.stores],
      currentPlayer: state.currentPlayer,
      gameOver: state.gameOver,
      floaters: document.querySelectorAll('.marble-float').length,
    }));
    assert(JSON.stringify(transformFinal.pits) === JSON.stringify([[1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 1]]),
      `Transform-safe animation ends with correct pit counts: ${JSON.stringify(transformFinal.pits)}`);
    assert(JSON.stringify(transformFinal.stores) === JSON.stringify([0, 0]),
      `Transform-safe animation preserves stores: ${JSON.stringify(transformFinal.stores)}`);
    assert(transformFinal.currentPlayer === 0 && !transformFinal.gameOver,
      `Transform-safe animation preserves next turn/game state: currentPlayer=${transformFinal.currentPlayer}, gameOver=${transformFinal.gameOver}`);
    assert(transformFinal.floaters === 0, `Transform-safe animation cleans up floaters: ${transformFinal.floaters}`);
    assert(transformErrors.length === 0, `Transform-safe animation raises no page errors: ${transformErrors.length}`);
    await pageAT.close();

    // =========================================================
    // Rotated animations stay on the rotated board and finish in the store
    // =========================================================
    console.log('\n=== Rotated animations stay on rotated board ===');

    const pageAR = await browser.newPage();
    pageAR.on('console', m => console.log(`    [AR] ${m.text()}`));
    pageAR.on('pageerror', e => console.log(`    [AR ERROR] ${e.message}`));

    await configurePageSettings(pageAR, { animSpeed: '10', boardSizePercent: '100', boardRotation: '90' }, { beforeNavigation: true });

    await pageAR.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await pageAR.evaluate(() => document.getElementById('hotseat-btn').click());
    await pageAR.waitForSelector('#top-row .pit');

    async function rotatedStoreDropCheck(playerIdx, storeSelector, seedId, keepAliveSeedId) {
      await pageAR.evaluate((idx, movingSeedId, stayingSeedId) => {
        state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
        state.stores = [[], []];
        state.pits[idx][5] = [movingSeedId];
        state.pits[idx][0] = [stayingSeedId];
        state.pits[1 - idx][0] = [idx === 0 ? 24 : 0];
        state.currentPlayer = idx;
        state.gameOver = false;
        boardRotationMode = '90';
        render();
        const sourcePit = idx === 0
          ? document.querySelectorAll('#top-row .pit')[0]
          : document.querySelectorAll('#bottom-row .pit')[5];
        window.__expectedDropClass = sourcePit.querySelector('.marble').className;
        window.__animDone = false;
        executeMoveAnimated(idx, 5, 500).then(() => {
          window.__animDone = true;
        });
      }, playerIdx, seedId, keepAliveSeedId);

      await sleep(400);

      await pageAR.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
      await sleep(200);

      const duringAnimation = await pageAR.evaluate((selector) => {
        const floater = document.querySelector('.marble-float');
        const board = document.querySelector('.board').getBoundingClientRect();
        const floaterRect = floater.getBoundingClientRect();
        return {
          angle: document.querySelector('.board').dataset.rotationAngle,
          boardContains: floaterRect.left >= board.left - 1
            && floaterRect.right <= board.right + 1
            && floaterRect.top >= board.top - 1
            && floaterRect.bottom <= board.bottom + 1,
        };
      }, storeSelector);

      assert(duringAnimation.angle === '90',
        `Rotated animation keeps 90° board angle for ${storeSelector}: ${duringAnimation.angle}`);
      assert(duringAnimation.boardContains,
        `Rotated animation floater stays inside rotated board bounds for ${storeSelector}`);

      await pageAR.waitForFunction(() => window.__animDone === true, { timeout: 15000 });
      await pageAR.waitForFunction((selector) => document.querySelectorAll(selector + ' .marble').length === 1, { timeout: 15000 }, storeSelector);

      return pageAR.evaluate((selector) => {
        const marble = document.querySelector(selector + ' .marble');
        const marbleRect = marble.getBoundingClientRect();
        const storeRect = document.querySelector(selector).getBoundingClientRect();
        return {
          marbleClass: marble.className,
          expectedClass: window.__expectedDropClass,
          marbleX: marbleRect.left + marbleRect.width / 2,
          marbleY: marbleRect.top + marbleRect.height / 2,
          storeX: storeRect.left + storeRect.width / 2,
          storeY: storeRect.top + storeRect.height / 2,
          gameOver: state.gameOver,
        };
      }, storeSelector);
    }

    const bottomStoreLanding = await rotatedStoreDropCheck(1, '#store-bottom', 24, 25);
    assert(!bottomStoreLanding.gameOver, 'Rotated bottom-store regression avoids end-of-game relayout');
    assert(bottomStoreLanding.marbleClass === bottomStoreLanding.expectedClass,
      `Rotated bottom-store drop preserves marble color class: "${bottomStoreLanding.marbleClass}"`);
    assert(Math.abs(bottomStoreLanding.marbleX - bottomStoreLanding.storeX) < 2
        && Math.abs(bottomStoreLanding.marbleY - bottomStoreLanding.storeY) < 2,
      `Rotated bottom-store drop finishes centered (${bottomStoreLanding.marbleX.toFixed(1)}, ${bottomStoreLanding.marbleY.toFixed(1)}) ~= (${bottomStoreLanding.storeX.toFixed(1)}, ${bottomStoreLanding.storeY.toFixed(1)})`);

    const topStoreLanding = await rotatedStoreDropCheck(0, '#store-top', 0, 1);
    assert(!topStoreLanding.gameOver, 'Rotated top-store regression avoids end-of-game relayout');
    assert(topStoreLanding.marbleClass === topStoreLanding.expectedClass,
      `Rotated top-store drop preserves marble color class: "${topStoreLanding.marbleClass}"`);
    assert(Math.abs(topStoreLanding.marbleX - topStoreLanding.storeX) < 2
        && Math.abs(topStoreLanding.marbleY - topStoreLanding.storeY) < 2,
      `Rotated top-store drop finishes centered (${topStoreLanding.marbleX.toFixed(1)}, ${topStoreLanding.marbleY.toFixed(1)}) ~= (${topStoreLanding.storeX.toFixed(1)}, ${topStoreLanding.storeY.toFixed(1)})`);

    await pageAR.close();

    // =========================================================
    // Portrait rotation regressions across display/animation variants
    // =========================================================
    console.log('\n=== Portrait rotation variants ===');

    const pagePV = await browser.newPage();
    await pagePV.setViewport({ width: 390, height: 844 });
    await pagePV.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
    await configurePageSettings(pagePV);
    await pagePV.evaluate(() => render());
    await pagePV.evaluate(() => document.getElementById('hotseat-btn').click());

    const portraitVariantGeometry = async (mode) => pagePV.evaluate((displayModeValue) => {
      displayMode = displayModeValue;
      boardRotationMode = '90';
      boardSizePercent = 100;
      render();
      const board = document.querySelector('.board').getBoundingClientRect();
      const elements = [
        ...document.querySelectorAll('.pit'),
        document.getElementById('store-top'),
        document.getElementById('store-bottom'),
      ];
      return {
        topGap: board.top,
        bottomGap: window.innerHeight - board.bottom,
        containsAll: elements.every(el => {
          const rect = el.getBoundingClientRect();
          return rect.left >= board.left - 1
            && rect.right <= board.right + 1
            && rect.top >= board.top - 1
            && rect.bottom <= board.bottom + 1;
        }),
        marbleCount: document.querySelectorAll('.marble').length,
      };
    }, mode);

    const numbersPortrait = await portraitVariantGeometry('numbers');
    assert(Math.abs(numbersPortrait.topGap - numbersPortrait.bottomGap) <= 2,
      `Portrait numbers mode stays vertically centered (${numbersPortrait.topGap.toFixed(1)} ~= ${numbersPortrait.bottomGap.toFixed(1)})`);
    assert(numbersPortrait.containsAll, 'Portrait numbers mode keeps bowls inside the board');

    await pagePV.evaluate(() => {
      displayMode = 'marbles';
      state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
      state.stores = [[0, 1], [24, 25]];
      boardRotationMode = '90';
      boardSizePercent = 100;
      render();
    });
    await sleep(300);

    const marblesNoAnim = await pagePV.evaluate(() => {
      const marbles = [...document.querySelectorAll('#store-bottom .marble')].map(m => {
        const r = m.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      return {
        count: marbles.length,
        distance: Math.hypot(marbles[0].x - marbles[1].x, marbles[0].y - marbles[1].y),
      };
    });
    assert(marblesNoAnim.count === 2, `Portrait marbles/no-animation keeps two store marbles visible: ${marblesNoAnim.count}`);
    assert(marblesNoAnim.distance > 5,
      `Portrait marbles/no-animation store marbles are laid out separately: ${marblesNoAnim.distance.toFixed(2)}`);

    await pagePV.evaluate(() => {
      displayMode = 'marbles';
      state.pits = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => []));
      state.stores = [[], [26]];
      state.pits[1][5] = [24];
      state.pits[1][0] = [25];
      state.pits[0][0] = [0];
      state.currentPlayer = 1;
      state.gameOver = false;
      boardRotationMode = '90';
      render();
    });
    await sleep(400);
    await pagePV.evaluate(() => {
      window.__animDone = false;
      executeMoveAnimated(1, 5, 500).then(() => { window.__animDone = true; });
    });
    await pagePV.waitForFunction(() => document.querySelectorAll('.marble-float').length > 0, { timeout: 15000 });
    await sleep(200);

    const marblesAnimDuring = await pagePV.evaluate(() => {
      const floater = document.querySelector('.marble-float').getBoundingClientRect();
      const board = document.querySelector('.board').getBoundingClientRect();
      const store = document.getElementById('store-bottom').getBoundingClientRect();
      return {
        insideBoard: floater.left >= board.left - 1
          && floater.right <= board.right + 1
          && floater.top >= board.top - 1
          && floater.bottom <= board.bottom + 1,
        distanceToStoreCenter: Math.hypot(
          (floater.left + floater.width / 2) - (store.left + store.width / 2),
          (floater.top + floater.height / 2) - (store.top + store.height / 2)
        ),
      };
    });
    assert(marblesAnimDuring.insideBoard, 'Portrait marbles/animation keeps the floater on the rotated board');

    await pagePV.waitForFunction(() => window.__animDone === true, { timeout: 15000 });

    const marblesAnimAfter = await pagePV.evaluate(() => {
      const marbles = [...document.querySelectorAll('#store-bottom .marble')].map(m => {
        const r = m.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      return {
        count: marbles.length,
        distance: Math.hypot(marbles[0].x - marbles[1].x, marbles[0].y - marbles[1].y),
      };
    });
    assert(marblesAnimAfter.count === 2, `Portrait marbles/animation finishes with two store marbles visible: ${marblesAnimAfter.count}`);
    assert(marblesAnimAfter.distance > 5,
      `Portrait marbles/animation reflows store marbles after the drop: ${marblesAnimAfter.distance.toFixed(2)}`);

    await pagePV.close();

    // =========================================================
    // Full hotseat game, deterministic seed — validate every
    // move, turn, score, and marble color with animations OFF/ON
    // =========================================================
    const FULL_GAME_COLOR_SEED = 0x5eed1234;
    const maxMoves = 200;

    function mulberry32(seed) {
      return function() {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

    function shuffleArray(arr, rng) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function buildMarbleColorClasses(seed) {
      const colorIndexes = [];
      for (let i = 0; i < 48; i++) colorIndexes.push(i % 5);
      shuffleArray(colorIndexes, mulberry32(seed >>> 0));
      return colorIndexes.map(idx => `mc-${idx}`);
    }

    function createInitialHotseatModel() {
      let id = 0;
      const pits = [[], []];
      for (let playerIdx = 0; playerIdx < 2; playerIdx++) {
        for (let pitIdx = 0; pitIdx < 6; pitIdx++) {
          pits[playerIdx][pitIdx] = [];
          for (let seedIdx = 0; seedIdx < 4; seedIdx++) pits[playerIdx][pitIdx].push(id++);
        }
      }
      return {
        pits,
        stores: [[], []],
        currentPlayer: 0,
        gameOver: false,
      };
    }

    function simulateHotseatMove(model, playerIdx, pitIdx) {
      const pits = model.pits.map(row => row.map(ids => [...ids]));
      const stores = model.stores.map(ids => [...ids]);
      const opponentIdx = 1 - playerIdx;
      const seeds = [...pits[playerIdx][pitIdx]];
      pits[playerIdx][pitIdx] = [];

      let pos = pitIdx;
      let lastSide = -1;
      let lastPitIdx = -1;

      while (seeds.length > 0) {
        pos++;
        if (pos > 13) pos = 0;
        if (pos === 13) continue;

        const marbleId = seeds.shift();
        if (pos >= 0 && pos <= 5) {
          pits[playerIdx][pos].push(marbleId);
          lastSide = 0;
          lastPitIdx = pos;
        } else if (pos === 6) {
          stores[playerIdx].push(marbleId);
          lastSide = 1;
          lastPitIdx = -1;
        } else {
          const opponentPitIdx = pos - 7;
          pits[opponentIdx][opponentPitIdx].push(marbleId);
          lastSide = 2;
          lastPitIdx = opponentPitIdx;
        }
      }

      if (lastSide === 0 && pits[playerIdx][lastPitIdx].length === 1) {
        const oppositeIdx = 5 - lastPitIdx;
        if (pits[opponentIdx][oppositeIdx].length > 0) {
          stores[playerIdx].push(...pits[playerIdx][lastPitIdx]);
          stores[playerIdx].push(...pits[opponentIdx][oppositeIdx]);
          pits[playerIdx][lastPitIdx] = [];
          pits[opponentIdx][oppositeIdx] = [];
        }
      }

      const currentPlayer = lastSide === 1 ? playerIdx : opponentIdx;
      let gameOver = false;
      if (pits[0].every(ids => ids.length === 0) || pits[1].every(ids => ids.length === 0)) {
        for (let pit = 0; pit < 6; pit++) {
          stores[0].push(...pits[0][pit]);
          stores[1].push(...pits[1][pit]);
          pits[0][pit] = [];
          pits[1][pit] = [];
        }
        gameOver = true;
      }

      return { pits, stores, currentPlayer, gameOver };
    }

    function findFirstPlayablePit(model) {
      for (let pitIdx = 0; pitIdx < 6; pitIdx++) {
        if (model.pits[model.currentPlayer][pitIdx].length > 0) return pitIdx;
      }
      return -1;
    }

    function expectedWinnerText(model) {
      const finalScore = ` ${model.stores[0].length}-${model.stores[1].length}`;
      if (!model.gameOver) return '';
      if (model.stores[0].length > model.stores[1].length) return 'Red Wins!' + finalScore;
      if (model.stores[1].length > model.stores[0].length) return 'Green Wins!' + finalScore;
      return "It's a Tie!" + finalScore;
    }

    function expectedClickableDomIndices(model, row) {
      if (model.gameOver) return [];
      if (row === 'top') {
        if (model.currentPlayer !== 0) return [];
        const domIdxs = [];
        for (let domIdx = 0; domIdx < 6; domIdx++) {
          const pitIdx = 5 - domIdx;
          if (model.pits[0][pitIdx].length > 0) domIdxs.push(domIdx);
        }
        return domIdxs;
      }

      if (model.currentPlayer !== 1) return [];
      const domIdxs = [];
      for (let domIdx = 0; domIdx < 6; domIdx++) {
        if (model.pits[1][domIdx].length > 0) domIdxs.push(domIdx);
      }
      return domIdxs;
    }

    function modelToExpectedView(model, marbleColorClasses) {
      return {
        topPitColors: [...model.pits[0]].reverse().map(ids => ids.map(id => marbleColorClasses[id])),
        bottomPitColors: model.pits[1].map(ids => ids.map(id => marbleColorClasses[id])),
        storeTopColors: model.stores[0].map(id => marbleColorClasses[id]),
        storeBottomColors: model.stores[1].map(id => marbleColorClasses[id]),
        topClickable: expectedClickableDomIndices(model, 'top'),
        bottomClickable: expectedClickableDomIndices(model, 'bottom'),
        winnerText: expectedWinnerText(model),
      };
    }

    function normalizeColorBuckets(colorBuckets) {
      return colorBuckets.map(colors => [...colors].sort());
    }

    function normalizeColorList(colors) {
      return [...colors].sort();
    }

    async function waitForHotseatSettled(page, timeout = 30000) {
      await page.waitForFunction(() => {
        if (typeof state === 'undefined' || typeof animating === 'undefined') return false;
        const totalSeeds = state.pits[0].reduce((sum, pit) => sum + pit, 0)
          + state.pits[1].reduce((sum, pit) => sum + pit, 0)
          + state.stores[0] + state.stores[1];
        return !animating && totalSeeds === 48;
      }, { timeout });
      await sleep(50);
    }

    async function getHotseatSnapshot(page) {
      return page.evaluate(() => {
        function marbleColorsFor(el) {
          return [...el.querySelectorAll('.marble')].map(marble => {
            for (let i = 0; i < 5; i++) {
              if (marble.classList.contains('mc-' + i)) return 'mc-' + i;
            }
            return 'none';
          });
        }

        return {
          pits: state.pits.map(row => [...row]),
          stores: [...state.stores],
          currentPlayer: state.currentPlayer,
          gameOver: state.gameOver,
          colorSeed: state.colorSeed,
          totalSeeds: state.pits[0].reduce((sum, pit) => sum + pit, 0)
            + state.pits[1].reduce((sum, pit) => sum + pit, 0)
            + state.stores[0] + state.stores[1],
          statusText: document.getElementById('status').textContent,
          statusHtml: document.getElementById('status').innerHTML,
          winnerText: document.getElementById('winner-banner').textContent,
          scores: {
            leftName: document.getElementById('score-left-name').textContent,
            leftVal: document.getElementById('score-left-val').textContent,
            rightName: document.getElementById('score-right-name').textContent,
            rightVal: document.getElementById('score-right-val').textContent,
            leftActive: document.getElementById('score-left').classList.contains('active'),
            rightActive: document.getElementById('score-right').classList.contains('active'),
          },
          topClickable: [...document.querySelectorAll('#top-row .pit')]
            .map((pit, idx) => pit.classList.contains('clickable') ? idx : null)
            .filter(idx => idx !== null),
          bottomClickable: [...document.querySelectorAll('#bottom-row .pit')]
            .map((pit, idx) => pit.classList.contains('clickable') ? idx : null)
            .filter(idx => idx !== null),
          topPitColors: [...document.querySelectorAll('#top-row .pit')].map(marbleColorsFor),
          bottomPitColors: [...document.querySelectorAll('#bottom-row .pit')].map(marbleColorsFor),
          storeTopColors: marbleColorsFor(document.getElementById('store-top')),
          storeBottomColors: marbleColorsFor(document.getElementById('store-bottom')),
        };
      });
    }

    function assertHotseatSnapshot(snapshot, model, marbleColorClasses, label) {
      const expectedView = modelToExpectedView(model, marbleColorClasses);
      const expectedPitCounts = model.pits.map(row => row.map(ids => ids.length));
      const expectedStoreCounts = model.stores.map(ids => ids.length);
      const currentName = model.currentPlayer === 0 ? 'Red' : 'Green';
      const currentColor = model.currentPlayer === 0 ? '#ef5350' : '#66bb6a';

      assert(JSON.stringify(snapshot.pits) === JSON.stringify(expectedPitCounts), `${label}: pits match expected counts`);
      assert(JSON.stringify(snapshot.stores) === JSON.stringify(expectedStoreCounts), `${label}: stores match expected counts`);
      assert(snapshot.currentPlayer === model.currentPlayer, `${label}: current player is ${currentName}`);
      assert(snapshot.gameOver === model.gameOver, `${label}: gameOver=${model.gameOver}`);
      assert(snapshot.colorSeed === FULL_GAME_COLOR_SEED, `${label}: manual color seed is fixed`);
      assert(snapshot.totalSeeds === 48, `${label}: total seeds conserved at 48`);

      assert(snapshot.scores.leftName === 'Red', `${label}: left score label is Red`);
      assert(snapshot.scores.rightName === 'Green', `${label}: right score label is Green`);
      assert(parseInt(snapshot.scores.leftVal, 10) === expectedStoreCounts[0],
        `${label}: Red score is ${expectedStoreCounts[0]}`);
      assert(parseInt(snapshot.scores.rightVal, 10) === expectedStoreCounts[1],
        `${label}: Green score is ${expectedStoreCounts[1]}`);

      assert(JSON.stringify(normalizeColorBuckets(snapshot.topPitColors)) === JSON.stringify(normalizeColorBuckets(expectedView.topPitColors)),
        `${label}: top-row marble colors match expected ids`);
      assert(JSON.stringify(normalizeColorBuckets(snapshot.bottomPitColors)) === JSON.stringify(normalizeColorBuckets(expectedView.bottomPitColors)),
        `${label}: bottom-row marble colors match expected ids`);
      assert(JSON.stringify(normalizeColorList(snapshot.storeTopColors)) === JSON.stringify(normalizeColorList(expectedView.storeTopColors)),
        `${label}: Red store colors match expected ids`);
      assert(JSON.stringify(normalizeColorList(snapshot.storeBottomColors)) === JSON.stringify(normalizeColorList(expectedView.storeBottomColors)),
        `${label}: Green store colors match expected ids`);

      if (model.gameOver) {
        assert(snapshot.statusText.includes('Game Over'), `${label}: status shows game over`);
        assert(snapshot.winnerText === expectedView.winnerText, `${label}: winner banner is "${expectedView.winnerText}"`);
        assert(snapshot.topClickable.length === 0, `${label}: no top-row pits clickable after game over`);
        assert(snapshot.bottomClickable.length === 0, `${label}: no bottom-row pits clickable after game over`);
        assert(!snapshot.scores.leftActive && !snapshot.scores.rightActive, `${label}: no active score highlight after game over`);
      } else {
        assert(snapshot.statusText.includes(`${currentName}'s turn`), `${label}: status shows ${currentName}'s turn`);
        assert(snapshot.statusHtml.includes(currentColor), `${label}: status color matches ${currentName}`);
        assert(snapshot.winnerText === '', `${label}: winner banner hidden before game over`);
        assert(snapshot.scores.leftActive === (model.currentPlayer === 0),
          `${label}: Red active highlight matches current turn`);
        assert(snapshot.scores.rightActive === (model.currentPlayer === 1),
          `${label}: Green active highlight matches current turn`);
        assert(JSON.stringify(snapshot.topClickable) === JSON.stringify(expectedView.topClickable),
          `${label}: top-row clickable pits match current turn`);
        assert(JSON.stringify(snapshot.bottomClickable) === JSON.stringify(expectedView.bottomClickable),
          `${label}: bottom-row clickable pits match current turn`);
      }
    }

    async function clickHotseatPit(page, playerIdx, pitIdx) {
      const selector = playerIdx === 0
        ? `#top-row .pit:nth-child(${6 - pitIdx})`
        : `#bottom-row .pit:nth-child(${pitIdx + 1})`;
      return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el || !el.classList.contains('clickable')) return false;
        el.click();
        return true;
      }, selector);
    }

    async function runFullHotseatGameTest(label, animSpeed) {
      console.log(`\n=== ${label} ===`);

      const page = await browser.newPage();
      const pageTag = animSpeed === 0 ? 'FS' : 'FA';
      page.on('console', m => console.log(`    [${pageTag}] ${m.text()}`));
      page.on('pageerror', e => console.log(`    [${pageTag} ERROR] ${e.message}`));

      await configurePageSettings(page, {
        animSpeed: String(animSpeed),
        boardRotation: '0',
        boardSizePercent: '100',
      }, {
        beforeNavigation: true,
        forcedRandom: (FULL_GAME_COLOR_SEED + 0.5) / 0xFFFFFFFF,
      });

      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.getElementById('hotseat-btn').click());
      await page.waitForSelector('#top-row .pit');
      await waitForHotseatSettled(page);

      const marbleColorClasses = buildMarbleColorClasses(FULL_GAME_COLOR_SEED);
      let model = createInitialHotseatModel();
      let snapshot = await getHotseatSnapshot(page);
      assertHotseatSnapshot(snapshot, model, marbleColorClasses, `${label}: initial state`);

      const moveHistory = [];
      let moveCount = 0;
      while (!model.gameOver && moveCount < maxMoves) {
        const playerIdx = model.currentPlayer;
        const pitIdx = findFirstPlayablePit(model);
        assert(pitIdx !== -1, `${label}: found a playable pit for ${playerIdx === 0 ? 'Red' : 'Green'}`);

        const beforeState = JSON.stringify({ pits: model.pits, stores: model.stores, currentPlayer: model.currentPlayer, gameOver: model.gameOver });
        const expected = simulateHotseatMove(model, playerIdx, pitIdx);

        const clicked = await clickHotseatPit(page, playerIdx, pitIdx);
        assert(clicked, `${label}: move ${moveCount + 1} clicked ${playerIdx === 0 ? 'Red' : 'Green'} pit ${pitIdx}`);
        await waitForHotseatSettled(page, animSpeed > 0 ? 30000 : 15000);

        snapshot = await getHotseatSnapshot(page);
        assertHotseatSnapshot(snapshot, expected, marbleColorClasses,
          `${label}: move ${moveCount + 1} (${playerIdx === 0 ? 'Red' : 'Green'} pit ${pitIdx})`);

        const afterState = JSON.stringify({ pits: expected.pits, stores: expected.stores, currentPlayer: expected.currentPlayer, gameOver: expected.gameOver });
        assert(beforeState !== afterState, `${label}: move ${moveCount + 1} changed the board`);

        moveHistory.push({
          playerIdx,
          pitIdx,
          nextPlayer: expected.currentPlayer,
          redScore: expected.stores[0].length,
          greenScore: expected.stores[1].length,
          gameOver: expected.gameOver,
        });

        model = expected;
        moveCount++;
      }

      assert(model.gameOver, `${label}: game reached game over in ${moveCount} moves`);
      snapshot = await getHotseatSnapshot(page);
      assertHotseatSnapshot(snapshot, model, marbleColorClasses, `${label}: final state`);

      await page.close();
      return {
        moveHistory,
        finalModel: model,
        finalSnapshot: snapshot,
      };
    }

    const fullGameOff = await runFullHotseatGameTest('Full hotseat game, animation OFF', 0);
    const fullGameOn = await runFullHotseatGameTest('Full hotseat game, animation ON', 80);

    assert(JSON.stringify(fullGameOff.moveHistory) === JSON.stringify(fullGameOn.moveHistory),
      'Full hotseat games: OFF and ON follow the same deterministic move history');
    assert(JSON.stringify(fullGameOff.finalModel) === JSON.stringify(fullGameOn.finalModel),
      'Full hotseat games: OFF and ON finish with the same final state');
    assert(JSON.stringify(normalizeColorList(fullGameOff.finalSnapshot.storeTopColors)) === JSON.stringify(normalizeColorList(fullGameOn.finalSnapshot.storeTopColors)),
      'Full hotseat games: Red final store colors match with animations OFF and ON');
    assert(JSON.stringify(normalizeColorList(fullGameOff.finalSnapshot.storeBottomColors)) === JSON.stringify(normalizeColorList(fullGameOn.finalSnapshot.storeBottomColors)),
      'Full hotseat games: Green final store colors match with animations OFF and ON');

    console.log('\n=== Summary ===');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

  } catch (err) {
    console.error('Test error:', err);
    failed++;
  } finally {
    await browser.close();
    server.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
