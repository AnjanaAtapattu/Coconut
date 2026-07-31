#!/usr/bin/env node
/**
 * Test suite for Pol Sathkara.
 *
 * Every check here exists because the thing it checks actually broke at some point:
 * a view that stopped re-rendering on a language switch, a chat panel stranded under
 * the dossier, a soil grid that never retried, an intent regex whose trailing word
 * boundary meant the stem never matched. The suite is the record of those.
 *
 *   node tests/run.js            # run everything
 *   node tests/run.js --filter soil
 *
 * Needs Playwright and a Chromium build. Serves the repo on a free port itself, so
 * there is nothing to start beforehand.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const filter = (() => {
  const i = process.argv.indexOf('--filter');
  return i > -1 ? process.argv[i + 1] : null;
})();

let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return; }
  failed++;
  failures.push(detail ? `${name}\n      ${detail}` : name);
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.bin': 'application/octet-stream' };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    // Refuse to serve outside the repo even in a test harness.
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, () => r({ server, port: server.address().port })));
}

function requirePlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(p); } catch (e) { /* try next */ }
  }
  console.error('Playwright not found. Install it: npm ci && npx playwright install chromium');
    process.exit(2);
}

// ---------------------------------------------------------------- static checks

function staticChecks() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Inline scripts must parse. A syntax error here takes the entire app down, and
  // nothing else in the suite would run to tell you why.
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  check('index.html has inline script blocks', blocks.length > 0);
  blocks.forEach((src, i) => {
    const tmp = path.join(require('os').tmpdir(), `pol-block-${i}.js`);
    fs.writeFileSync(tmp, src);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      passed++;
    } catch (e) {
      failed++;
      failures.push(`inline script block ${i} is not valid JS\n      ${String(e.stderr).slice(0, 300)}`);
    }
    fs.unlinkSync(tmp);
  });

  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'sw.js')], { stdio: 'pipe' });
    passed++;
  } catch (e) { failed++; failures.push('sw.js is not valid JS'); }

  // Markup integrity. Duplicate ids and dangling getElementById targets have both
  // shipped before; the second silently disabled a feature.
  const staticHtml = html.slice(html.indexOf('<body')).split('<script')[0];
  const ids = [...staticHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  eq('no duplicate element ids', dupes, []);

  const referenced = new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
  const declared = new Set([
    ...[...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
    // Some elements are built at runtime (the typing indicator, map popups), so their
    // id is assigned in JS rather than written in the markup.
    ...[...html.matchAll(/\.id\s*=\s*'([^']+)'/g)].map(m => m[1]),
    ...[...html.matchAll(/id="([A-Za-z][\w-]*)'\s*\+/g)].map(m => m[1])]);
  eq('every getElementById target exists',
     [...referenced].filter(r => !declared.has(r)), []);

  // Inline on* handlers must resolve to something global, or they throw on click.
  const handlers = new Set();
  for (const attr of ['onclick', 'onchange', 'oninput']) {
    for (const m of html.matchAll(new RegExp(attr + '=(?:"|\\\\?\')(.*?)(?:"|\\\\?\')', 'g'))) {
      for (const f of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(f[1]);
    }
  }
  const builtin = new Set(['getElementById', 'querySelector', 'classList', 'add', 'remove',
                           'click', 'toggle', 'parseInt', 'String']);
  const globals = new Set([
    ...[...html.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
    ...[...html.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1])]);
  eq('inline handlers resolve to globals',
     [...handlers].filter(f => !builtin.has(f) && !globals.has(f)), []);

  // Translation table: all three languages must carry the same keys, and every key
  // used by the code must exist. Both have regressed before.
  const T = (() => {
    const start = html.indexOf('{', html.search(/\bvar T\s*=\s*\{/));
    let depth = 0;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
  })();
  const langKeys = {};
  for (const lang of ['en', 'si', 'ta']) {
    const s = T.indexOf('{', T.search(new RegExp('\\b' + lang + '\\s*:\\s*\\{')));
    let depth = 0;
    for (let i = s; i < T.length; i++) {
      if (T[i] === '{') depth++;
      else if (T[i] === '}' && --depth === 0) {
        // Blank out string contents before looking for keys, or prose inside a value
        // ("Ask about:", "likely in:") is mistaken for a key of its own.
        const body = T.slice(s, i + 1).replace(/"(?:[^"\\]|\\.)*"/g, '""');
        langKeys[lang] = new Set([...body
          .matchAll(/(?:^|[{,\s])([A-Za-z_]\w*)\s*:/g)].map(m => m[1]));
        break;
      }
    }
  }
  check('three language tables found', ['en', 'si', 'ta'].every(l => langKeys[l] && langKeys[l].size > 100));
  for (const lang of ['si', 'ta']) {
    eq(`${lang} has every key en has`,
       [...langKeys.en].filter(k => !langKeys[lang].has(k)), []);
  }
  const used = new Set([...html.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)].map(m => m[1]));
  for (const m of html.matchAll(/data-t="([^"]+)"/g)) used.add(m[1]);
  eq('every t() key is defined', [...used].filter(k => !langKeys.en.has(k)), []);

  // Generated data must match its source, or someone hand-edited it.
  for (const [label, script] of [['offices', 'build_offices.py'], ['soil grid', 'build_soilgrid.py']]) {
    try {
      execFileSync('python3', [path.join(ROOT, 'tools', script), '--check'], { stdio: 'pipe', cwd: ROOT });
      passed++;
    } catch (e) {
      failed++;
      failures.push(`${label} data is out of step with its source\n      ${String(e.stdout || e.stderr).slice(0, 200)}`);
    }
  }

  // Files the service worker precaches must actually exist, or install silently
  // drops them and the app is not usable offline.
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).filter(u => u && !u.endsWith('/'));
  eq('every precached shell file exists',
     shell.filter(u => !fs.existsSync(path.join(ROOT, u))), []);
}

// ---------------------------------------------------------------- browser checks

async function browserChecks(page, base) {
  const errors = [];
  const cspViolations = [];
  page.on('pageerror', e => errors.push(e.message));
  // A policy that blocks something the app needs shows up here, not as a page error,
  // so it would otherwise pass every other check and fail only in production.
  page.on('console', m => {
    if (/Content Security Policy|Refused to (load|connect|execute)/i.test(m.text()))
      cspViolations.push(m.text());
  });
  // Map tiles are remote; the app must not depend on them.
  await page.route('**arcgisonline**', r => r.abort());
  await page.route('**cartocdn**', r => r.abort());
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  check('app boots without page errors', errors.length === 0, errors.join('; '));
  check('Leaflet is vendored, not fetched from a CDN',
        await page.evaluate(() => typeof L !== 'undefined'));

  // --- data loaded
  const counts = await page.evaluate(() => ({
    offices: typeof OFFICES !== 'undefined' ? OFFICES.length : 0,
    zones: typeof AGRO !== 'undefined' ? AGRO.features.length : 0,
    pests: typeof PESTS !== 'undefined' ? PESTS.length : 0,
    guides: typeof INTERCROP_PDFS !== 'undefined' ? INTERCROP_PDFS.length : 0,
    mite: typeof MITE_PACKETS !== 'undefined' ? Object.keys(MITE_PACKETS).length : 0 }));
  check('offices loaded', counts.offices >= 80, `got ${counts.offices}`);
  check('zones loaded', counts.zones === 48, `got ${counts.zones}`);
  check('pests loaded', counts.pests === 8, `got ${counts.pests}`);
  check('crop guides listed', counts.guides === 23, `got ${counts.guides}`);
  check('mite districts loaded', counts.mite >= 20, `got ${counts.mite}`);

  // --- every crop guide actually resolves
  const missing = await page.evaluate(async () => {
    const bad = [];
    for (const c of INTERCROP_PDFS) {
      const r = await fetch('intercrop-pdfs/' + encodeURIComponent(c) + '.pdf', { method: 'HEAD' });
      if (!r.ok) bad.push(c);
    }
    return bad;
  });
  eq('every crop guide PDF resolves', missing, []);

  // --- soil grid
  const grid = await page.evaluate(async () => {
    const g = await soilGridLoad();
    return { bytes: g ? g.length : 0,
             expected: SOIL_GRID_META.w * SOIL_GRID_META.h * (SOIL_GRID_META.stride || 7) };
  });
  eq('soil grid loads at declared size', grid.bytes, grid.expected);

  const soil = await page.evaluate(() => ({
    // Jaffna sits on limestone and reads alkaline; the coconut triangle reads acidic.
    jaffna: soilAt(9.6615, 80.0255),
    triangle: soilAt(7.4696, 80.0413),
    offshore: soilAt(7.0, 79.0),
    north: soilAt(10.5, 80.0) }));
  check('soil lookup returns data on land', soil.jaffna && soil.triangle);
  check('soil lookup is bounded', soil.offshore === null && soil.north === null,
        'points outside the grid must return null, not wrap around');
  check('Jaffna reads alkaline (limestone)', soil.jaffna.ph > 6.8, `pH ${soil.jaffna && soil.jaffna.ph}`);
  check('coconut triangle reads acidic', soil.triangle.ph < 6.5, `pH ${soil.triangle && soil.triangle.ph}`);
  check('clay derived from sand and silt',
        Math.abs(soil.triangle.clay - (100 - soil.triangle.sand - soil.triangle.silt)) < 1);

  // --- irrigation model
  const irrig = await page.evaluate(() => {
    const wet = [180,140,180,290,260,180,150,150,200,380,340,220];
    const dry = [60,40,50,90,50,15,20,25,50,200,260,130];
    return {
      wet: irrigationPlan({ awc: 50 }, { monthlyRain: wet }),
      drySand: irrigationPlan({ awc: 40 }, { monthlyRain: dry }),
      dryLoam: irrigationPlan({ awc: 70 }, { monthlyRain: dry }),
      noSoil: irrigationPlan(null, { monthlyRain: dry }),
      noRain: irrigationPlan({ awc: 50 }, null) };
  });
  eq('wet zone needs no routine irrigation', irrig.wet.needMonths.length, 0);
  check('dry zone needs irrigation', irrig.drySand.needMonths.length > 5);
  check('soil water buffers the dry season',
        irrig.dryLoam.totalMm < irrig.drySand.totalMm,
        'a loam must need less irrigation than a sand on the same rainfall — ' +
        `got loam ${irrig.dryLoam.totalMm} vs sand ${irrig.drySand.totalMm}`);
  check('irrigation rate is plausible for the dry zone',
        irrig.drySand.litresPerPalmPerWeek > 100 && irrig.drySand.litresPerPalmPerWeek < 400,
        `got ${irrig.drySand.litresPerPalmPerWeek} L/palm/week`);
  check('irrigation needs both inputs', irrig.noSoil === null && irrig.noRain === null);

  // --- language: every JS-rendered view must rebuild on a switch
  for (const view of ['weather', 'pests', 'offices']) {
    await page.click(`nav.tabs button[data-tab="${view}"]`);
    await page.waitForTimeout(500);
    await page.evaluate(() => switchLang('si'));
    await page.waitForTimeout(600);
    const sinhala = await page.evaluate(v =>
      /[඀-෿]/.test(document.getElementById('view-' + v).innerText), view);
    check(`${view} view re-renders in Sinhala`, sinhala);
    await page.evaluate(() => switchLang('en'));
    await page.waitForTimeout(300);
  }

  // --- zone classification is translated everywhere, across all 48 zones
  const untranslated = await page.evaluate(() => {
    switchLang('si');
    const bad = [];
    for (const k in ZONE_DATA) {
      const d = ZONE_DATA[k];
      if (!d.final_id) continue;
      openDossier(d.final_id);
      const txt = document.getElementById('sheet').innerText;
      if (/WET ZONE|DRY ZONE|INTERMEDIATE ZONE|LOW COUNTRY|MID COUNTRY|UP COUNTRY/.test(txt))
        bad.push(d.final_id);
    }
    document.getElementById('dClose').click();
    switchLang('en');
    return bad;
  });
  eq('no untranslated zone classification in any zone', untranslated, []);

  // --- dossier
  const dossier = await page.evaluate(() => {
    openDossier(12);
    return { open: document.getElementById('sheet').classList.contains('open'),
             yields: document.getElementById('dCon').innerText.includes('nuts/ha/yr'),
             guides: document.querySelectorAll('#dCon .cropdoc a').length,
             landSlot: !!document.getElementById('dLand') };
  });
  check('dossier opens with yields and crop guides',
        dossier.open && dossier.yields && dossier.guides > 0 && dossier.landSlot);

  // The dossier covers the header, so it carries its own language switcher.
  await page.click('#langswSheet button[data-lang="si"]');
  await page.waitForTimeout(700);
  const inSheet = await page.evaluate(() => ({
    stillOpen: document.getElementById('sheet').classList.contains('open'),
    sinhala: /[඀-෿]/.test(document.getElementById('dCon').innerText),
    inSync: document.querySelector('#langswSheet button.active').dataset.lang ===
            document.querySelector('#langsw button.active').dataset.lang }));
  check('language can be changed from inside the dossier',
        inSheet.stillOpen && inSheet.sinhala && inSheet.inSync);
  await page.evaluate(() => { switchLang('en'); document.getElementById('dClose').click(); });
  await page.waitForTimeout(400);

  // --- print
  const print = await page.evaluate(() => {
    openDossier(12); printReport();
    return document.querySelectorAll('#printArea .psheet').length;
  });
  check('printable report builds', print >= 3, `got ${print} pages`);
  await page.evaluate(() => document.getElementById('dClose').click());
  await page.waitForTimeout(300);

  // --- assistant: live data answers beat the written articles, but only for
  // questions actually asking for a fact.
  const chat = await page.evaluate(() => ({
    price: !!chatLiveAnswer('coconut price today'),
    nursery: !!chatLiveAnswer('where is my nearest nursery'),
    guide: !!chatLiveAnswer('banana cultivation guide'),
    irrigateStem: (() => { climSetPoint(8.0362, 79.8283); return /irrigat/i.test(String(chatLiveAnswer('do I need to irrigate'))); })(),
    advice: !chatLiveAnswer('how to control red palm weevil') && !!chatSearch('how to control red palm weevil'),
    sinhalaNoun: !!chatSearch('තවාන'),
    tamilNoun: !!chatSearch('நாற்றங்கால்') }));
  check('assistant answers prices from live data', chat.price);
  check('assistant answers nearest office from live data', chat.nursery);
  check('assistant links the crop guide', chat.guide);
  check('assistant answers "do I need to irrigate"', chat.irrigateStem,
        'stem matching regressed — \\birrigat\\b never matches "irrigate"');
  check('advice questions still reach the written article', chat.advice);
  check('assistant understands a bare Sinhala noun', chat.sinhalaNoun);
  check('assistant understands a bare Tamil noun', chat.tamilNoun);

  // --- chat output must not become markup
  const injection = await page.evaluate(() => {
    chatAddMsg('[x](javascript:alert(1)) <img src=x onerror=alert(1)> [ok](tel:0112502502)', 'bot', false);
    const bubble = [...document.querySelectorAll('#chatMsgs .cbubble.bot')].pop();
    return { images: bubble.querySelectorAll('img').length,
             links: [...bubble.querySelectorAll('a')].map(a => a.getAttribute('href')) };
  });
  eq('chat rejects javascript: links and inline markup',
     { images: injection.images, links: injection.links },
     { images: 0, links: ['tel:0112502502'] });

  // --- search must survive hostile and malformed input
  const search = await page.evaluate(() => {
    const out = [];
    for (const q of ['<img src=x onerror=alert(1)>', '.*', '((((', "o'brien", '   ', 'a'.repeat(300)]) {
      try {
        document.getElementById('searchOverlay').classList.add('open');
        const input = document.getElementById('searchInput');
        input.value = q;
        input.dispatchEvent(new Event('input'));
        out.push(document.querySelectorAll('#searchResults img, #searchResults script').length);
      } catch (e) { out.push('threw: ' + e.message); }
    }
    document.getElementById('searchOverlay').classList.remove('open');
    return out;
  });
  eq('search survives hostile input without injecting nodes', search, [0, 0, 0, 0, 0, 0]);

  // --- ranking: a town should find the office named after it, not one whose
  // street address merely mentions it.
  const ranked = await page.evaluate(() => {
    document.getElementById('searchOverlay').classList.add('open');
    const input = document.getElementById('searchInput');
    input.value = 'kurunegala';
    input.dispatchEvent(new Event('input'));
    const first = document.querySelector('.sr-item b');
    document.getElementById('searchOverlay').classList.remove('open');
    return first ? first.textContent : '';
  });
  check('office search ranks name matches first', /CCB Kurunegala/.test(ranked), `got "${ranked}"`);

  // --- corrupt stored state must not take a view down
  const resilience = await page.evaluate(() => {
    localStorage.setItem('polClimPoint', '{"lat":"abc","lng":null}');
    localStorage.setItem('polDoa:districts', '[]');
    return { power: powerCached(7.47, 80.04), doa: doaCacheGet('districts') };
  });
  eq('corrupt cache entries are rejected', resilience, { power: null, doa: null });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await page.click('nav.tabs button[data-tab="weather"]');
  await page.waitForTimeout(800);
  check('weather view survives a corrupt saved location',
        await page.evaluate(() => !!document.querySelector('.clim-mine')));

  eq('content security policy blocks nothing the app needs', cspViolations, []);
  check('no page errors across the whole run', errors.length === 0, errors.slice(0, 5).join('; '));
}

async function mobileChecks(page, base) {
  await page.route('**arcgisonline**', r => r.abort());
  await page.route('**cartocdn**', r => r.abort());
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await page.evaluate(() => soilGridLoad());
  for (const view of ['weather', 'pests', 'offices']) {
    await page.click(`nav.tabs button[data-tab="${view}"]`);
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(v => {
      const el = document.getElementById('view-' + v);
      return { body: document.body.scrollWidth > window.innerWidth + 1,
               view: el.scrollWidth > el.clientWidth + 1 };
    }, view);
    check(`${view} does not scroll sideways at 360px`,
          !overflow.body && !overflow.view, JSON.stringify(overflow));
  }
  // The floating controls used to sit permanently on top of the last card.
  await page.click('nav.tabs button[data-tab="pests"]');
  await page.waitForTimeout(600);
  const clear = await page.evaluate(() => {
    const v = document.getElementById('view-pests');
    v.scrollTop = v.scrollHeight;
    return new Promise(r => setTimeout(() => {
      const cards = [...document.querySelectorAll('#view-pests .pest-card-new')];
      const last = cards[cards.length - 1].getBoundingClientRect();
      const fab = document.getElementById('chatFab').getBoundingClientRect();
      r(!(last.bottom > fab.top && last.top < fab.bottom &&
          last.right > fab.left && last.left < fab.right));
    }, 600));
  });
  check('last card can scroll clear of the chat button', clear);
}

(async () => {
  const t0 = Date.now();
  console.log('Pol Sathkara — test suite\n');

  if (!filter || 'static'.includes(filter)) staticChecks();

  if (!filter || 'browser mobile'.includes(filter)) {
    const { chromium } = requirePlaywright();
    const { server, port } = await serve();
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ||
        (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
    try {
      if (!filter || 'browser'.includes(filter)) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await browserChecks(await ctx.newPage(), base);
        await ctx.close();
      }
      if (!filter || 'mobile'.includes(filter)) {
        const ctx = await browser.newContext({ viewport: { width: 360, height: 740 },
                                               isMobile: true, hasTouch: true });
        await mobileChecks(await ctx.newPage(), base);
        await ctx.close();
      }
    } finally {
      await browser.close();
      server.close();
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${passed} passed, ${failed} failed  (${secs}s)`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  ✗ ' + f));
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('suite crashed:', e); process.exit(2); });
