// 브라우저(시스템 Chrome)로 대시보드를 실제 조작하며 확인하고 shots/ 에 스크린샷을 남긴다.
// 사용: node serve.mjs 를 띄운 상태에서 node ui.mjs
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://localhost:5179';
const OUT = process.argv[3] || 'shots';
import fs from 'fs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run'] });
const errors = [];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function idle(page) {
  // loadbar 가 사라질 때까지
  await page.waitForFunction(() => document.getElementById('loadbar')?.hidden !== false, { timeout: 20000 });
  await sleep(250);
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim());

const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.setViewport({ width: 1440, height: 900 });
await page.goto(BASE + '/dash/index.html', { waitUntil: 'networkidle0' });
await page.waitForSelector('.kpi');
await idle(page);
log('title:', await text(page, '#view-title'), '|', await text(page, '#data-meta'));
log('KPI:', (await page.$$eval('.kpi', (els) => els.map((e) => e.querySelector('.k-label').innerText + '=' + e.querySelector('.k-value').innerText))).join(' / '));
log('presets:', await text(page, '#period-presets'));
log('notice hidden:', await page.$eval('#notice', (e) => e.hidden), '| tbl-count:', await text(page, '#tbl-count'));
await page.screenshot({ path: `${OUT}/1-overview.png`, fullPage: true });

// 월 프리셋 (5월)
await page.evaluate(() => [...document.querySelectorAll('#period-presets button')].find((b) => b.innerText === '5월').click());
await idle(page);
log('5월:', await text(page, '#view-title'), '|', (await page.$$eval('.kpi', (els) => els.slice(0, 2).map((e) => e.innerText.replace(/\n/g, ' ')))).join(' / '));

// Consignee 검색 + 선택
await page.type('#ms-consignee-q', '다산');
await sleep(100);
await page.evaluate(() => document.querySelector('#ms-consignee .msel-row input').click());
await idle(page);
log('업체 선택:', await text(page, '#active-chips'), '|', await text(page, '#tbl-count'));
log('hash:', decodeURIComponent(await page.evaluate(() => location.hash)));

// 상세 탭 · 검색 · 정렬 · 페이지
await page.evaluate(() => document.querySelector('[data-clear="consignee"]').click());
await idle(page);
await page.evaluate(() => document.querySelector('#tabs [data-tab="detail"]').click());
await idle(page);
log('상세:', await text(page, '#tbl-count'), '| 첫 행:', await page.$eval('#tbl tbody tr', (e) => e.innerText.replace(/\t/g, ' | ').slice(0, 140)));
await page.evaluate(() => [...document.querySelectorAll('#tbl th')].find((t) => t.dataset.k === 'teu').click());
await idle(page);
log('TEU 정렬:', await page.$$eval('#tbl tbody tr', (rs) => rs.slice(0, 5).map((r) => r.children[10].innerText).join(',')));
await page.evaluate(() => document.querySelector('#pager [data-p="2"]')?.click());
await idle(page);
log('2페이지:', await text(page, '#pager'));
await page.type('#tbl-search', '1152');
await sleep(500); await idle(page);
log('검색 1152:', await text(page, '#tbl-count'));
await page.screenshot({ path: `${OUT}/2-detail.png`, fullPage: false });

// 점검 탭 → B/L 보기
await page.evaluate(() => document.querySelector('#tabs [data-tab="quality"]').click());
await idle(page);
log('점검:', (await text(page, '#tbl')).replace(/\n+/g, ' ').slice(0, 300));
await page.evaluate(() => document.querySelector('[data-qc="cntr"]').click());
await idle(page);
log('점검→상세:', await text(page, '#tbl-count'));

// 항차별 추이 · USD
await page.evaluate(() => { document.querySelector('#trend-mode [data-v="voyage"]').click(); });
await idle(page);
await page.evaluate(() => { document.querySelector('#charge-cur [data-v="usd"]').click(); });
await idle(page);
await page.evaluate(() => document.querySelector('#tabs [data-tab="voyage"]').click());
await idle(page);
log('항차 표:', await text(page, '#tbl-count'));
await page.screenshot({ path: `${OUT}/3-voyage-usd.png`, fullPage: true });

// 보고서: 월별
await page.click('#btn-report');
await sleep(500);
log('보고서 모달 hint:', await text(page, '#rm-detail-hint'));
await page.evaluate(() => { document.querySelector('#rm-detail').click(); });
await page.click('#rm-go');
await page.waitForFunction(() => !document.getElementById('report-root').hidden, { timeout: 20000 });
await sleep(800);
log('보고서:', await text(page, '#report-title'), '| 섹션:', (await page.$$eval('#report-doc h2', (hs) => hs.map((h) => h.innerText))).join(' / '));
await page.screenshot({ path: `${OUT}/4-report.png`, fullPage: false });
await page.pdf({ path: `${OUT}/4-report.pdf`, format: 'A4', printBackground: true });
await page.click('#report-close');

// 업체별 보고서
await page.click('#btn-report');
await page.evaluate(() => document.querySelector('#rm-type [data-v="company"]').click());
await sleep(300);
await page.evaluate(() => { document.querySelector('#rm-detail').checked = false; document.querySelector('#rm-detail').dispatchEvent(new Event('change')); });
await page.click('#rm-go');
await page.waitForFunction(() => !document.getElementById('report-root').hidden && document.querySelector('#report-doc h1'), { timeout: 20000 });
await sleep(600);
log('업체 보고서:', await text(page, '#report-title'), '|', (await page.$$eval('#report-doc h2', (hs) => hs.map((h) => h.innerText))).join(' / '));
await page.click('#report-close');

// 모바일
const m = await browser.newPage();
m.on('pageerror', (e) => errors.push('[mobile pageerror] ' + e.message));
await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await m.goto(BASE + '/dash/index.html', { waitUntil: 'networkidle0' });
await m.waitForSelector('.kpi'); await idle(m);
await m.screenshot({ path: `${OUT}/5-mobile.png`, fullPage: false });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
log('모바일 가로 넘침(px):', overflow);

// 화물 도구 탭 연결
const tool = await browser.newPage();
tool.on('pageerror', (e) => errors.push('[tool pageerror] ' + e.message));
await tool.setViewport({ width: 1440, height: 900 });
await tool.goto(BASE + '/tool', { waitUntil: 'domcontentloaded' });
await sleep(1500);
log('iframe src (탭 열기 전):', await tool.$eval('#dashboardFrame', (f) => f.getAttribute('src')));
await tool.hover('.dropdown-tab');
await sleep(300);
log('기타 메뉴:', (await text(tool, '#etcDropdown')).replace(/\n/g, ' · '));
await tool.evaluate(() => document.querySelector('.dropdown-item[data-tab="dashboard"]').click());
await sleep(500);
log('iframe src (탭 연 뒤):', await tool.$eval('#dashboardFrame', (f) => f.getAttribute('src')), '| 활성 탭:', await tool.$eval('.tab-content.active', (e) => e.id), '| 기타 활성:', await tool.$eval('.dropdown-tab', (e) => e.classList.contains('active')));
const frame = await (await tool.$('#dashboardFrame')).contentFrame();
await frame.waitForSelector('.kpi', { timeout: 20000 });
await sleep(1500);
await tool.mouse.move(700, 600);
await tool.screenshot({ path: `${OUT}/6-tool-tab.png`, fullPage: false });

log('\n콘솔 오류/경고:', errors.length ? '\n' + errors.join('\n') : '없음');
const rl = await (await fetch(BASE + '/__rpclog')).json();
log('RPC 호출:', rl.map((r) => `${r.fn} ${r.ms}ms ${(r.bytes / 1024).toFixed(1)}KB`).slice(0, 12).join(' · '));
await browser.close();
