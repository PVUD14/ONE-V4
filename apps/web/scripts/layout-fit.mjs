#!/usr/bin/env node
/**
 * Layout fit check: every signed-in page must fit common laptop and phone screens.
 *
 * It exists because the dashboards squeezed their cards into 80-130px columns on
 * 1280-1536px laptops (and 1920px screens at 125-150% scaling) while every check we had
 * looked only at 1440px and 390px. At each size below it fails on a card or stat tile
 * narrower than MIN_CARD px, text running past its own box, or a page that scrolls sideways.
 *
 * Two steps, so the check can run against unreleased CSS with real-shaped data:
 *
 *   record  Sign in to the sandbox (demo.oneby8.com, sample data only) as each account and
 *           save every API response the role's pages make, one file per role:
 *             ONE_LAYOUT_GATE='user:pass' ONE_LAYOUT_ACCOUNTS='[{"role":"student","email":"…","password":"…"}]' \
 *             node scripts/layout-fit.mjs record
 *           Credentials come only from the environment and are never written anywhere.
 *
 *   check   Build and serve a production bundle whose API base is the replay address (the dev
 *           server runs every effect twice, which some pages read as a failed load):
 *             VITE_API_BASE_URL=https://api.layout-fit.test vite build --outDir ../../../layout-dist
 *             vite preview --outDir ../../../layout-dist --port 4173
 *             node scripts/layout-fit.mjs check --origin http://127.0.0.1:4173 [--role student]
 *           Each role's recorded responses are replayed under a stand-in session; every nav
 *           page is opened at every size. Exits non-zero, listing each failure, if any page fails.
 *
 * Never point either step at production: record refuses any origin but the sandbox.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'layout-fit-fixtures');
const SANDBOX = 'https://demo.oneby8.com';
const MOCK_API = 'https://api.layout-fit.test';
const MIN_CARD = 150;
const SIZES = [[1280, 720], [1366, 768], [1440, 900], [1536, 864], [390, 844]];
const NAV = '.side-nav-item, .role-nav-item';

const args = process.argv.slice(2);
const mode = args[0];
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };

/** Every card-like box narrower than MIN_CARD, every leaf whose text overflows, and sideways scroll. */
function measure(minCard) {
  const failures = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) failures.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide)`);
  const describe = (element) => `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join('.')} "${(element.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 32)}"`;
  for (const element of document.querySelectorAll('main *')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || element.closest('[aria-hidden="true"]')) continue;
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const classes = String(element.className);
    if (/(^|\s)(pilot-card|pilot-kpi|v2-card|v2-stat|role-card|role-kpi|pilot-score-card|pilot-course-card)(\s|$)/.test(classes)
      && box.width < minCard && innerWidth > 600) failures.push(`narrow card ${Math.round(box.width)}px: ${describe(element)}`);
    if (element.children.length === 0 && (element.innerText || '').trim() && style.overflowX === 'visible' && element.scrollWidth > element.clientWidth + 2
      && style.textOverflow !== 'ellipsis') failures.push(`text overflows ${element.clientWidth}<${element.scrollWidth}: ${describe(element)}`);
  }
  // Space wasted the other way: a wide card whose content covers under 30% of its width, or a
  // single row of cards that leaves grid columns standing empty beside them.
  const cardClass = /(^|\s)(pilot-card|v2-card|role-card)(\s|$)/;
  for (const card of document.querySelectorAll('main .pilot-card, main .v2-card, main .role-card')) {
    const box = card.getBoundingClientRect();
    if (box.width < 560 || box.height < 2 || innerWidth <= 600) continue;
    let left = Infinity; let right = -Infinity;
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) { if (rect.width) { left = Math.min(left, rect.left); right = Math.max(right, rect.right); } }
    }
    for (const graphic of card.querySelectorAll('svg, img, canvas, input, select, textarea, button, table')) {
      const rect = graphic.getBoundingClientRect(); if (rect.width) { left = Math.min(left, rect.left); right = Math.max(right, rect.right); }
    }
    // Only a card left alone on its row while its siblings sit side by side is wasted room;
    // an empty state alone in a stacked page is the honest layout.
    const siblings = [...(card.parentElement?.children ?? [])].filter((item) => item !== card && item.getBoundingClientRect().width > 0);
    const aloneOnRow = !siblings.some((item) => Math.abs(item.getBoundingClientRect().top - box.top) < 4);
    const siblingsShareRows = siblings.some((item, index) => siblings.some((other, otherIndex) => otherIndex !== index && Math.abs(other.getBoundingClientRect().top - item.getBoundingClientRect().top) < 4));
    if (right > left && (right - left) < box.width * 0.3 && aloneOnRow && siblingsShareRows) failures.push(`mostly empty card: content ${Math.round(right - left)}px of ${Math.round(box.width)}px: ${describe(card)}`);
  }
  for (const row of document.querySelectorAll('main *')) {
    const style = getComputedStyle(row);
    if (style.display !== 'grid' || row.getBoundingClientRect().width < 500 || innerWidth <= 600) continue;
    const tracks = style.gridTemplateColumns.split(' ').filter((track) => parseFloat(track) > 0).length;
    const items = [...row.children].filter((child) => getComputedStyle(child).display !== 'none' && getComputedStyle(child).position !== 'absolute');
    if (tracks >= 3 && items.length >= 2 && items.length < tracks && items.every((item) => cardClass.test(String(item.className))))
      failures.push(`row leaves ${tracks - items.length} empty column(s): ${describe(row)}`);
  }
  // A stat tile is a small figure: stretched across a page it reads as a broken layout.
  for (const tile of document.querySelectorAll('main .pilot-kpi, main .role-kpi, main .v2-stat')) {
    const width = tile.getBoundingClientRect().width;
    if (width > 480 && innerWidth > 600) failures.push(`stat tile stretched to ${Math.round(width)}px: ${describe(tile)}`);
  }
  return [...new Set(failures)];
}

async function record() {
  const gate = process.env.ONE_LAYOUT_GATE;
  const accounts = JSON.parse(process.env.ONE_LAYOUT_ACCOUNTS ?? '[]');
  const origin = option('origin', SANDBOX);
  if (origin !== SANDBOX) throw new Error(`record only runs against the sandbox (${SANDBOX})`);
  if (!gate || !accounts.length) throw new Error('ONE_LAYOUT_GATE and ONE_LAYOUT_ACCOUNTS are required');
  const [username, password] = [gate.slice(0, gate.indexOf(':')), gate.slice(gate.indexOf(':') + 1)];
  mkdirSync(fixturesDir, { recursive: true });
  const browser = await chromium.launch();
  for (const account of accounts) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, httpCredentials: { username, password } });
    const page = await context.newPage();
    const responses = {};
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.origin !== origin || !url.pathname.startsWith('/api/') && url.pathname !== '/health') return;
      if (!(response.headers()['content-type'] ?? '').includes('json')) return;
      try { responses[`${response.request().method()} ${url.pathname}${url.search}`] = { status: response.status(), body: await response.json() }; } catch { /* body unavailable */ }
    });
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.fill('input[type=email]', account.email);
    await page.fill('input[type=password]', account.password);
    await page.click('button[type=submit]');
    await page.waitForURL((url) => !url.pathname.startsWith('/login') && url.pathname !== '/', { timeout: 30000 });
    await page.waitForSelector(NAV, { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const landing = new URL(page.url()).pathname;
    const labels = await page.$$eval(NAV, (items) => items.map((item) => item.getAttribute('aria-label') || item.textContent.trim()));
    for (const label of labels) {
      await page.locator(NAV).filter({ hasText: label }).first().click().catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(800);
    }
    writeFileSync(join(fixturesDir, `${account.role}.json`), `${JSON.stringify({ email: account.email, landing, labels, responses }, null, 1)}\n`);
    console.log(`recorded ${account.role}: ${labels.length} pages, ${Object.keys(responses).length} responses`);
    await context.close();
  }
  await browser.close();
}

async function check() {
  const origin = option('origin', 'http://127.0.0.1:4173');
  const only = option('role');
  const files = readdirSync(fixturesDir).filter((name) => name.endsWith('.json') && (!only || name === `${only}.json`));
  const browser = await chromium.launch();
  let failed = 0;
  for (const file of files) {
    const role = file.replace(/\.json$/, '');
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
    for (const [width, height] of SIZES) {
      const context = await browser.newContext({ viewport: { width, height } });
      const payload = Buffer.from(JSON.stringify({ exp: 4102444800, email: fixture.email })).toString('base64url');
      const token = `e30.${payload}.sig`;
      await context.addInitScript(([value, email]) => {
        sessionStorage.setItem('planthepath.authSession.v1', JSON.stringify({ accessToken: value, idToken: value, refreshToken: null, email, username: email, accessTokenExpiresAt: 4102444800000 }));
      }, [token, fixture.email]);
      await context.route(`${MOCK_API}/**`, async (route) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const url = new URL(route.request().url());
        const key = `${route.request().method()} ${url.pathname}${url.search}`;
        const hit = fixture.responses[key] ?? Object.entries(fixture.responses).find(([recorded]) => recorded.split('?')[0] === key.split('?')[0])?.[1];
        return route.fulfill({ headers: cors, status: hit?.status ?? 404, contentType: 'application/json', body: JSON.stringify(hit?.body ?? {}) });
      });
      const page = await context.newPage();
      await page.goto(`${origin}${fixture.landing}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      const labels = width > 760 ? fixture.labels : [fixture.labels[0]];
      for (const label of labels) {
        if (width > 760) {
          await page.locator(NAV).filter({ hasText: label }).first().click().catch(() => {});
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.waitForTimeout(500);
        }
        const failures = await page.evaluate(measure, MIN_CARD);
        if (failures.length) {
          failed += failures.length;
          console.log(`FAIL ${role} ${width}x${height} ${label}`);
          for (const failure of failures.slice(0, 8)) console.log(`  - ${failure}`);
        }
      }
      await context.close();
    }
  }
  await browser.close();
  console.log(failed ? `\n${failed} layout problem(s)` : 'all pages fit');
  process.exit(failed ? 1 : 0);
}

if (mode === 'record') await record();
else if (mode === 'check') await check();
else { console.error('usage: layout-fit.mjs record | check [--origin URL] [--role name]'); process.exit(2); }
