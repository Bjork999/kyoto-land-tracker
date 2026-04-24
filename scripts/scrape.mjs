#!/usr/bin/env node
// 京都市11区 + 八幡市 土地物件を SUUMO/athome/不動産ジャパン から Playwright で取得
import { load as cheerioLoad } from 'cheerio';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_HTML = path.join(ROOT, 'index.html');
const KNOWN_IDS_PATH = path.join(ROOT, 'known_ids.json');

const ORIGIN = { lat: 34.931217, lng: 135.740479, label: '伏見区下鳥羽南円面田町52' };
const MIN_PRICE_MAN = 100;
const MAX_PRICE_MAN = 2000;
const MIN_AREA_M2 = 109;
const NEW_DAYS = 3;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ Fetchers ============
// Plain Node fetch (fast, works for SUUMO/athome from residential IP)
async function nodeFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en-US;q=0.9' },
        signal: AbortSignal.timeout(20000)
      });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch {}
    await sleep(500 * (i + 1));
  }
  return null;
}

// Playwright fetcher (for 不動産ジャパン which requires full browser)
async function createPwFetcher() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1400, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo'
  });
  // Warm up: visit homepage once to establish session
  try {
    const warmup = await context.newPage();
    await warmup.goto('https://www.fudousan.or.jp/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);
    await warmup.close();
  } catch {}

  const fetchHtml = async (url, { scroll = true, timeout = 30000 } = {}) => {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
      if (scroll) {
        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let y = 0;
            const step = () => {
              window.scrollTo(0, y);
              y += 500;
              if (y > document.body.scrollHeight + 800) return resolve();
              setTimeout(step, 120);
            };
            step();
          });
        });
        await sleep(1500);
      }
      const html = await page.content();
      await page.close();
      return html;
    } catch (e) {
      console.error(`  fetch error ${url}:`, e.message);
      try { await page.close(); } catch {}
      return null;
    }
  };

  const close = async () => { await context.close(); await browser.close(); };
  return { fetchHtml, close };
}

// ============ SUUMO ============
const SUUMO_WARDS = [
  ['sc_kyotoshikita', '北区'], ['sc_kyotoshikamigyo', '上京区'], ['sc_kyotoshisakyo', '左京区'],
  ['sc_kyotoshinakagyo', '中京区'], ['sc_kyotoshihigashiyama', '東山区'], ['sc_kyotoshishimogyo', '下京区'],
  ['sc_kyotoshiminami', '南区'], ['sc_kyotoshiukyo', '右京区'], ['sc_kyotoshifushimi', '伏見区'],
  ['sc_kyotoshiyamashina', '山科区'], ['sc_kyotoshinishikyo', '西京区'], ['sc_yawata', '八幡市']
];

function parsePriceMan(text) {
  if (!text) return null;
  const oku = text.match(/(\d+(?:\.\d+)?)\s*億(?:([\d,]+)\s*万)?\s*円?/);
  if (oku) return parseFloat(oku[1]) * 10000 + (oku[2] ? parseFloat(oku[2].replace(/,/g, '')) : 0);
  const man = text.match(/([\d,]+(?:\.\d+)?)\s*万\s*円?/);
  if (man) return parseFloat(man[1].replace(/,/g, ''));
  return null;
}

async function scrapeSuumo() {
  const results = [];
  for (const [code, ward] of SUUMO_WARDS) {
    const base = `https://suumo.jp/tochi/kyoto/${code}/`;
    const firstHtml = await nodeFetch(base);
    if (!firstHtml) continue;
    const first$ = cheerioLoad(firstHtml);
    let maxPage = 1;
    first$('.pagination-parts a, .pagination-parts li').each((_, el) => {
      const n = parseInt(first$(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const extract = ($) => {
      $('.ui-media').each((_, el) => {
        const $el = $(el);
        if (!$el.find('.property_unit-object').length) return;
        const linkEl = $el.find('a[href*="nc_"]').first();
        if (!linkEl.length) return;
        const href = new URL(linkEl.attr('href'), 'https://suumo.jp').href;
        const text = $el.text().replace(/\s+/g, ' ').trim();
        const priceMatch = text.match(/販売価格\s+([\d,\.]+万円|[\d,\.]+億[\d,\.]*万?円?|未定)/);
        const areaMatch = text.match(/土地面積\s+([\d,\.]+)m2/);
        const locMatch = text.match(/所在地\s+([^沿]+?)\s+沿線/);
        const stnMatch = text.match(/沿線・駅\s+(.+?)\s+土地面積/);
        const tsuboMatch = text.match(/([\d,\.]+)万円／坪/);
        const priceMan = priceMatch ? parsePriceMan(priceMatch[1]) : null;
        const areaM2 = areaMatch ? parseFloat(areaMatch[1].replace(/,/g, '')) : null;
        const tsubo = areaM2 ? +(areaM2 / 3.305785).toFixed(2) : null;
        const img = $el.find('img').first();
        const imgUrl = img.attr('rel') || img.attr('data-original') || img.attr('src') || '';
        const nameRaw = img.attr('alt') || '';
        const name = nameRaw.replace(/\s*[\d,]+万円\s*画像\d*\s*$/, '').trim() || null;
        const idMatch = href.match(/nc_(\d+)/);
        const propId = idMatch ? `SUUMO-${idMatch[1]}` : `SUUMO-${href}`;
        results.push({
          propId, source: 'SUUMO', ward, name,
          priceMan, areaM2, tsubo,
          tsuboUnit: tsuboMatch ? tsuboMatch[1] : null,
          location: locMatch ? locMatch[1].trim() : null,
          station: stnMatch ? stnMatch[1].trim() : null,
          url: href,
          imgUrl: imgUrl.startsWith('http') && !imgUrl.includes('data:') ? imgUrl : ''
        });
      });
    };
    extract(first$);
    for (let p = 2; p <= Math.min(maxPage, 25); p++) {
      const h = await nodeFetch(`${base}?page=${p}`);
      if (h) extract(cheerioLoad(h));
    }
    console.log(`  SUUMO ${ward}: ${results.filter(r => r.ward === ward).length}件 (${maxPage}p)`);
  }
  return results;
}

// ============ athome ============
const ATHOME_WARDS = [
  ['kyoto_kita-city', '北区'], ['kyoto_kamigyo-city', '上京区'], ['kyoto_sakyo-city', '左京区'],
  ['kyoto_nakagyo-city', '中京区'], ['kyoto_higashiyama-city', '東山区'], ['kyoto_shimogyo-city', '下京区'],
  ['kyoto_minami-city', '南区'], ['kyoto_ukyo-city', '右京区'], ['kyoto_fushimi-city', '伏見区'],
  ['kyoto_yamashina-city', '山科区'], ['kyoto_nishikyo-city', '西京区'], ['yawata-city', '八幡市']
];

async function scrapeAthome() {
  const results = [];
  for (const [p, ward] of ATHOME_WARDS) {
    const base = `https://www.athome.co.jp/tochi/kyoto/${p}/list/`;
    const firstHtml = await nodeFetch(base);
    if (!firstHtml) continue;
    const first$ = cheerioLoad(firstHtml);
    let maxPage = 1;
    first$('a').each((_, el) => {
      const h = first$(el).attr('href') || '';
      const m = h.match(/\/page(\d+)\//);
      if (m) { const n = parseInt(m[1], 10); if (n > maxPage) maxPage = n; }
    });
    const extract = ($) => {
      $('.card-box').each((_, el) => {
        const $el = $(el);
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (!text.includes('住宅用地') && !text.includes('宅地')) return;
        const linkEl = $el.find('a[href*="/tochi/"]').first();
        if (!linkEl.length) return;
        const href = new URL(linkEl.attr('href'), 'https://www.athome.co.jp').href;
        const priceMan = parsePriceMan(text);
        const areaMatch = text.match(/土地面積\s*([\d,\.]+)\s*m²?/);
        const areaM2 = areaMatch ? parseFloat(areaMatch[1].replace(/,/g, '')) : null;
        const tsubo = areaM2 ? +(areaM2 / 3.305785).toFixed(2) : null;
        const locMatch = text.match(/所在地\s*(京都[市府]?[^\s]+|八幡市[^\s]+)/) || text.match(/(京都市[^（\s]+|八幡市[^（\s]+)/);
        const stnMatch = text.match(/交通\s*(.+?)\s*所在地/);
        const tsuboUnitMatch = text.match(/坪単価\s*([\d,\.]+)\s*万円/);
        let imgUrl = '';
        $el.find('img').each((_, i) => {
          const src = $(i).attr('src') || '';
          if (src.startsWith('http') && /image_files|\.jpg|\.png/.test(src) && !/icon|favorite|logo|svg|loading|static_app_contents/.test(src)) {
            imgUrl = src; return false;
          }
        });
        const title = $el.find('.title-wrap').first().text().replace(/\s+/g, ' ').trim().slice(0, 80) || null;
        const idMatch = href.match(/\/tochi\/(\d+)/);
        const propId = idMatch ? `athome-${idMatch[1]}` : `athome-${href}`;
        results.push({
          propId, source: 'athome', ward, name: title,
          priceMan, areaM2, tsubo,
          tsuboUnit: tsuboUnitMatch ? tsuboUnitMatch[1] : null,
          location: locMatch ? locMatch[1].trim() : null,
          station: stnMatch ? stnMatch[1].trim().slice(0, 80) : null,
          url: href,
          imgUrl
        });
      });
    };
    extract(first$);
    for (let p2 = 2; p2 <= Math.min(maxPage, 20); p2++) {
      const h = await nodeFetch(`${base}page${p2}/`);
      if (h) extract(cheerioLoad(h));
      await sleep(200);
    }
    console.log(`  athome ${ward}: ${results.filter(r => r.ward === ward).length}件 (${maxPage}p)`);
  }
  return results;
}

// ============ 不動産ジャパン ============
const FUDO_WARDS = [
  ['26101', '北区'], ['26102', '上京区'], ['26103', '左京区'], ['26104', '中京区'],
  ['26105', '東山区'], ['26106', '下京区'], ['26107', '南区'], ['26108', '右京区'],
  ['26109', '伏見区'], ['26110', '山科区'], ['26111', '西京区'], ['26210', '八幡市']
];

async function scrapeFudousan(fetcher) {
  const results = [];
  for (const [code, ward] of FUDO_WARDS) {
    const base = `https://www.fudousan.or.jp/property/buy/26/area/list?ptm%5B%5D=0101&m_adr%5B%5D=${code}`;
    const firstHtml = await fetcher.fetchHtml(base, { scroll: true, waitFor: '.list-group-item' });
    if (!firstHtml) continue;
    const first$ = cheerioLoad(firstHtml);
    let maxPage = 1;
    first$('a').each((_, el) => {
      const h = first$(el).attr('href') || '';
      const m = h.match(/page=(\d+)/);
      if (m) { const n = parseInt(m[1], 10); if (n > maxPage) maxPage = n; }
    });
    const extract = ($) => {
      $('.list-group-item').each((_, el) => {
        const $el = $(el);
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (!text.includes('売地') || !text.includes('万円') || !text.includes('土地面積')) return;
        const linkEl = $el.find('a[href*="/property/"]').first();
        if (!linkEl.length) return;
        const href = new URL(linkEl.attr('href'), 'https://www.fudousan.or.jp').href;
        const priceMan = parsePriceMan(text);
        const areaMatch = text.match(/土地面積[：:]?\s*([\d,\.]+)\s*㎡/);
        const areaM2 = areaMatch ? parseFloat(areaMatch[1].replace(/,/g, '')) : null;
        const tsubo = areaM2 ? +(areaM2 / 3.305785).toFixed(2) : null;
        const locMatch = text.match(/【売地】\s*(京都[市府][^\s周]+?|八幡市[^\s周]+?)(?=\s*周辺|\s*画像|$)/);
        const stnMatch = text.match(/(.+?(?:徒歩|バス)[\d]+分)(?=\s+\d|\s+[\d,]+万)/);
        const tsuboUnitMatch = text.match(/坪単価[^：:]*[：:]\s*([\d,]+)万/);
        const img = $el.find('img.prop-img, img').first();
        const imgUrl = img.attr('data-echo') || img.attr('data-src') || img.attr('src') || '';
        const idMatch = href.match(/\/show\/(\d+)|\/property\/(\d+)/);
        const propId = idMatch ? `fudo-${idMatch[1] || idMatch[2]}` : `fudo-${href}`;
        results.push({
          propId, source: '不動産ジャパン', ward,
          name: locMatch ? locMatch[1].trim() : null,
          priceMan, areaM2, tsubo,
          tsuboUnit: tsuboUnitMatch ? tsuboUnitMatch[1].replace(/,/g, '') : null,
          location: locMatch ? locMatch[1].trim() : null,
          station: stnMatch ? stnMatch[1].trim().slice(0, 100) : null,
          url: href,
          imgUrl: imgUrl.startsWith('http') && !imgUrl.includes('no_photo') && !imgUrl.includes('loading') ? imgUrl : ''
        });
      });
    };
    extract(first$);
    for (let p2 = 2; p2 <= Math.min(maxPage, 20); p2++) {
      const h = await fetcher.fetchHtml(`${base}&page=${p2}`, { scroll: true, waitFor: '.list-group-item' });
      if (h) extract(cheerioLoad(h));
    }
    console.log(`  不動産ジャパン ${ward}: ${results.filter(r => r.ward === ward).length}件 (${maxPage}p)`);
  }
  return results;
}

// ============ Geocode + OSRM ============
function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

async function geocode(addr) {
  try {
    const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(addr)}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!arr.length) return null;
    const [lng, lat] = arr[0].geometry.coordinates;
    return { lat, lng };
  } catch { return null; }
}

async function osrmDrive(origin, dest) {
  try {
    const url = `http://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes.length) return null;
    return { km: +(j.routes[0].distance / 1000).toFixed(2), min: +(j.routes[0].duration / 60).toFixed(1) };
  } catch { return null; }
}

// ============ Filter + Dedup ============
function normalizeLocation(s) {
  if (!s) return '';
  return s.replace(/^京都府/, '').replace(/^京都市/, '').replace(/\s+/g, '').replace(/[\d\-－ー,、]+(?:丁目|番地|番|号|[\-－].+)?$/, '');
}

function fingerprint(item) {
  const loc = normalizeLocation(item.location);
  const priceB = Math.round(item.priceMan / 50) * 50;
  const areaB = Math.round(item.areaM2 / 10) * 10;
  return `${item.ward}|${loc}|${priceB}|${areaB}`;
}

function filterAndDedup(suumo, athome, fudo) {
  const pass = (x) => x.priceMan != null && x.priceMan >= MIN_PRICE_MAN && x.priceMan <= MAX_PRICE_MAN && x.areaM2 != null && x.areaM2 >= MIN_AREA_M2;
  suumo = suumo.filter(pass);
  athome = athome.filter(pass);
  fudo = fudo.filter(pass);
  const suumoFPs = new Set(suumo.map(fingerprint));
  athome = athome.filter(x => !suumoFPs.has(fingerprint(x)));
  const athomeFPs = new Set(athome.map(fingerprint));
  fudo = fudo.filter(x => !suumoFPs.has(fingerprint(x)) && !athomeFPs.has(fingerprint(x)));
  return [...suumo, ...athome, ...fudo];
}

// ============ HTML Generation ============
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(items, newCount, timestamp) {
  const rows = items.map(x => {
    const dm = x.driveMin;
    let driveClass = 'dt-unknown', driveBucket = 'over', driveTxt = '?';
    if (dm != null) {
      driveTxt = `${dm} 分`;
      if (dm <= 15) { driveClass = 'dt-very-near'; driveBucket = '20'; }
      else if (dm <= 20) { driveClass = 'dt-near'; driveBucket = '20'; }
      else if (dm <= 25) { driveClass = 'dt-mid'; driveBucket = '25'; }
      else if (dm <= 30) { driveClass = 'dt-far'; driveBucket = '30'; }
      else { driveClass = 'dt-over'; driveBucket = 'over'; }
    }
    const srcClass = { 'SUUMO': 'src-suumo', 'athome': 'src-athome', '不動産ジャパン': 'src-fudo' }[x.source] || 'src-other';
    const name = escapeHtml(x.name || '(物件名なし)');
    const loc = escapeHtml(x.location || '-');
    const stn = escapeHtml(x.station || '-');
    const imgCell = x.imgUrl ? `<img src="${x.imgUrl}" loading="lazy" alt="${name}" />` : '<span class=no-img>—</span>';
    const mapLink = x.lat && x.lng ? `https://www.google.com/maps/dir/?api=1&origin=${ORIGIN.lat},${ORIGIN.lng}&destination=${x.lat},${x.lng}&travelmode=driving&avoid=tolls` : '#';
    const mapBtn = x.lat && x.lng ? `<a class="map" href="${mapLink}" target="_blank" rel="noopener">経路</a>` : '';
    const newBadge = x.isNew ? '<span class="new-badge">🆕 NEW</span>' : '';
    const tsuboUnitTxt = x.tsuboUnit ? `${x.tsuboUnit}万/坪` : '-';
    const distText = x.driveKm != null ? `${x.driveKm} <span class=u>km</span>` : '?';
    return `<tr data-bucket="${driveBucket}" data-pid="${x.propId}" data-src="${x.source}" data-new="${x.isNew ? 'true' : 'false'}">
  <td class="fav"><input type="checkbox" class="fav-cb" data-pid="${x.propId}" aria-label="お気に入り"></td>
  <td class="img">${imgCell}</td>
  <td class="src ${srcClass}">${x.source}</td>
  <td class="ward">${x.ward}${newBadge}</td>
  <td class="price">${x.priceMan}<span class=u>万</span></td>
  <td class="tsubo-col">${x.tsubo} <span class=u>坪</span></td>
  <td class="m2-col">${x.areaM2} <span class=u>m²</span></td>
  <td class="unit">${tsuboUnitTxt}</td>
  <td class="dt ${driveClass}">${driveTxt}</td>
  <td class="dk">${distText}</td>
  <td class="name">${name}</td>
  <td class="loc">${loc}</td>
  <td class="stn">${stn}</td>
  <td class="link"><a href="${x.url}" target="_blank" rel="noopener">詳細</a>${mapBtn}</td>
</tr>`;
  }).join('\n');

  const totalAll = items.length;
  const total20 = items.filter(x => x.driveMin != null && x.driveMin <= 20).length;
  const total25 = items.filter(x => x.driveMin != null && x.driveMin <= 25).length;
  const total30 = items.filter(x => x.driveMin != null && x.driveMin <= 30).length;
  const srcCounts = { SUUMO: 0, athome: 0, '不動産ジャパン': 0 };
  items.forEach(x => { srcCounts[x.source] = (srcCounts[x.source] || 0) + 1; });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>京都市・八幡市 土地一覧 (多サイト統合・自動更新)</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; margin: 16px; background: #fafafa; color: #222; }
  h1 { font-size: 1.3em; margin: 0 0 4px; }
  .meta { color: #666; font-size: 0.85em; margin-bottom: 10px; line-height: 1.5; }
  .meta a { color: #0a66c2; }
  .notice { background: #fff3cd; border-left: 3px solid #f0ad4e; padding: 6px 10px; margin: 6px 0; font-size: 0.82em; color: #6a4d00; }
  .new-highlight { background: #ffe4e1; border-left: 3px solid #d9534f; padding: 6px 10px; margin: 6px 0; font-size: 0.9em; color: #721c24; font-weight: 600; }
  .tabs { display: flex; gap: 4px; margin: 10px 0; flex-wrap: wrap; align-items: center; }
  .tab { padding: 8px 14px; background: #e9ecef; border: none; border-radius: 6px; cursor: pointer; font-size: 0.92em; font-weight: 600; color: #495057; }
  .tab.active { background: #0a66c2; color: #fff; }
  .tab.new-tab { background: #ffe4e1; color: #721c24; }
  .tab.new-tab.active { background: #d9534f; color: #fff; }
  .tab.fav-tab.active { background: #d9534f; }
  .tab .c { display: inline-block; background: rgba(255,255,255,.25); padding: 1px 8px; border-radius: 10px; margin-left: 6px; font-size: 0.85em; }
  .tab:not(.active) .c { background: rgba(0,0,0,.08); }
  .clear-btn { margin-left: auto; padding: 6px 10px; background: #fff; border: 1px solid #d9534f; color: #d9534f; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
  .filters { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; align-items: center; font-size: 0.88em; }
  .filters label { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: #fff; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); min-width: 1200px; }
  th, td { padding: 7px 9px; border-bottom: 1px solid #eee; text-align: left; vertical-align: middle; font-size: 0.9em; }
  th { background: #f2f5f8; position: sticky; top: 0; font-weight: 600; z-index: 1; white-space: nowrap; }
  td.fav { width: 36px; text-align: center; }
  td.fav input { width: 20px; height: 20px; cursor: pointer; accent-color: #d9534f; }
  tr.is-fav { background: #fff5f5; }
  tr.is-fav td.fav { background: #fff0f0; }
  tr[data-new="true"] { background: linear-gradient(90deg, #fff3f3 0%, #fff 40%); }
  tr[data-new="true"] td.ward { background: #d9534f; color: #fff; }
  .new-badge { display: inline-block; background: #d9534f; color: #fff; padding: 1px 6px; border-radius: 10px; font-size: 0.7em; margin-left: 4px; font-weight: 700; }
  td.img img { width: 110px; height: 82px; object-fit: cover; border-radius: 4px; display: block; }
  td.img { width: 120px; }
  td.src { font-weight: 700; font-size: 0.78em; white-space: nowrap; padding: 4px 6px; border-radius: 4px; text-align: center; }
  td.src.src-suumo { background: #fff4e6; color: #b85c00; }
  td.src.src-athome { background: #e6f4ff; color: #0b62ab; }
  td.src.src-fudo { background: #ebeffc; color: #3f51b5; }
  td.price { font-weight: bold; color: #c0392b; text-align: right; white-space: nowrap; font-size: 1.08em; }
  td.tsubo-col { font-weight: 700; color: #1e6091; text-align: right; white-space: nowrap; background: #eaf4fb; font-size: 1.03em; }
  td.m2-col { text-align: right; white-space: nowrap; color: #666; font-size: 0.88em; }
  td.dt { text-align: right; white-space: nowrap; font-weight: 700; font-size: 1.0em; }
  td.dt.dt-very-near { background: #c3e6cb; color: #0f5132; }
  td.dt.dt-near { background: #d4edda; color: #155724; }
  td.dt.dt-mid { background: #fff3cd; color: #856404; }
  td.dt.dt-far { background: #ffd5b4; color: #7a3e00; }
  td.dt.dt-over { background: #f8d7da; color: #721c24; }
  td.dt.dt-unknown { background: #e9ecef; color: #6c757d; }
  td.dk { text-align: right; white-space: nowrap; color: #666; font-size: 0.86em; }
  .u { font-size: 0.75em; color: #888; margin-left: 2px; font-weight: 400; }
  td.ward { background: #f7f9fb; font-weight: 600; color: #2c3e50; white-space: nowrap; }
  td.name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.loc, td.stn { max-width: 180px; font-size: 0.82em; color: #444; }
  td.unit { white-space: nowrap; color: #555; font-size: 0.82em; text-align: right; }
  td.link a { display: inline-block; background: #0a66c2; color: #fff; padding: 4px 7px; border-radius: 4px; text-decoration: none; white-space: nowrap; font-size: 0.8em; margin: 1px; }
  td.link a.map { background: #6c757d; }
  .no-img { color: #bbb; font-size: 1.4em; }
  tr:hover { background: #fffbe6; }
  body.view-20 tr:not([data-bucket="20"]) { display: none; }
  body.view-25 tr[data-bucket="30"], body.view-25 tr[data-bucket="over"] { display: none; }
  body.view-30 tr[data-bucket="over"] { display: none; }
  body.view-fav tr:not(.is-fav) { display: none; }
  body.view-new tr:not([data-new="true"]) { display: none; }
  body.hide-suumo tr[data-src="SUUMO"], body.hide-athome tr[data-src="athome"], body.hide-fudo tr[data-src="不動産ジャパン"] { display: none; }
  #empty-fav, #empty-new { display: none; padding: 40px; text-align: center; color: #888; background: #fff; border-radius: 8px; }
  body.view-fav #empty-fav, body.view-new #empty-new { display: block; }
  @media (max-width: 700px) {
    body { margin: 8px; }
    td.img img { width: 80px; height: 60px; }
    td.img { width: 90px; }
    th, td { padding: 5px; font-size: 0.82em; }
  }
</style>
</head>
<body>
<h1>🏡 京都市・八幡市 土地一覧 (自動更新)</h1>
<div class="meta">
  条件: 33坪(109m²)以上・2000万円以下・居住用 | 価格安い順 | 起点: <strong>${ORIGIN.label}</strong><br>
  ソース: <strong>SUUMO ${srcCounts.SUUMO} + athome ${srcCounts.athome} + 不動産ジャパン ${srcCounts['不動産ジャパン']} = 合計 ${totalAll}件</strong> | 更新: ${timestamp}
</div>
${newCount > 0 ? `<div class="new-highlight">🆕 本日の新着: ${newCount}件</div>` : ''}
<div class="tabs">
  <button class="tab" id="tab-all" onclick="setView('all')">全件 <span class="c">${totalAll}</span></button>
  <button class="tab active" id="tab-20" onclick="setView('20')">~20分 <span class="c">${total20}</span></button>
  <button class="tab" id="tab-25" onclick="setView('25')">~25分 <span class="c">${total25}</span></button>
  <button class="tab" id="tab-30" onclick="setView('30')">~30分 <span class="c">${total30}</span></button>
  <button class="tab new-tab" id="tab-new" onclick="setView('new')">🆕 新着 <span class="c">${newCount}</span></button>
  <button class="tab fav-tab" id="tab-fav" onclick="setView('fav')">❤ お気に入り <span class="c" id="fav-count">0</span></button>
  <button class="clear-btn" onclick="clearFavs()">お気に入り解除</button>
</div>
<div id="empty-fav">❤ まだお気に入りなし。</div>
<div id="empty-new">🆕 新着物件はありません。</div>
<div class="table-wrap"><table>
<thead><tr><th>❤</th><th>画像</th><th>元</th><th>区市</th><th>価格</th><th>坪数</th><th>m²</th><th>坪単価</th><th>運転</th><th>道のり</th><th>物件名</th><th>所在地</th><th>駅</th><th>リンク</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<script>
const KEY = 'kyotoLandFavs_v3';
function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } }
function saveFavs(s) { localStorage.setItem(KEY, JSON.stringify([...s])); }
function applyFavs() {
  const favs = loadFavs();
  document.querySelectorAll('tr[data-pid]').forEach(tr => {
    const is = favs.has(tr.dataset.pid);
    tr.classList.toggle('is-fav', is);
    const cb = tr.querySelector('.fav-cb'); if (cb) cb.checked = is;
  });
  document.getElementById('fav-count').textContent = favs.size;
}
function toggleFav(pid, on) { const f = loadFavs(); if (on) f.add(pid); else f.delete(pid); saveFavs(f); applyFavs(); }
function clearFavs() { if (!confirm('お気に入りを全て解除?')) return; localStorage.removeItem(KEY); applyFavs(); }
function setView(m) {
  document.body.classList.remove('view-20','view-25','view-30','view-fav','view-new');
  if (m !== 'all') document.body.classList.add('view-'+m);
  ['all','20','25','30','new','fav'].forEach(x => document.getElementById('tab-'+x).classList.toggle('active', m===x));
}
function applySrc() {
  document.body.classList.toggle('hide-suumo', !document.getElementById('flt-suumo').checked);
  document.body.classList.toggle('hide-athome', !document.getElementById('flt-athome').checked);
  document.body.classList.toggle('hide-fudo', !document.getElementById('flt-fudo').checked);
}
document.addEventListener('change', e => {
  if (e.target.matches('.fav-cb')) toggleFav(e.target.dataset.pid, e.target.checked);
  if (e.target.matches('#flt-suumo, #flt-athome, #flt-fudo')) applySrc();
});
applyFavs(); setView('20');
</script>
</body></html>`;
}

// ============ Main ============
async function main() {
  console.log(`[${new Date().toISOString()}] 開始 (Hybrid版: SUUMO/athome=Node, 不動産ジャパン=Playwright)`);

  let knownIds = {};
  try { knownIds = JSON.parse(await fs.readFile(KNOWN_IDS_PATH, 'utf-8')); } catch { knownIds = {}; }
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - NEW_DAYS * 86400000).toISOString().slice(0, 10);

  console.log('→ SUUMO scraping (Node fetch)...');
  const suumo = await scrapeSuumo().catch(e => { console.error('SUUMO error:', e.message); return []; });
  console.log(`  SUUMO total: ${suumo.length}`);

  console.log('→ athome scraping (Node fetch)...');
  const athome = await scrapeAthome().catch(e => { console.error('athome error:', e.message); return []; });
  console.log(`  athome total: ${athome.length}`);

  console.log('→ 不動産ジャパン scraping (Playwright)...');
  let fudo = [];
  let pwFetcher = null;
  try {
    pwFetcher = await createPwFetcher();
    fudo = await scrapeFudousan(pwFetcher).catch(e => { console.error('fudo error:', e.message); return []; });
  } catch (e) {
    console.error('  Playwright launch failed, skipping fudo:', e.message);
  } finally {
    if (pwFetcher) await pwFetcher.close();
  }
  console.log(`  不動産ジャパン total: ${fudo.length}`);

  if (suumo.length + athome.length + fudo.length === 0) {
    console.error('全サイト失敗。既存HTMLを維持して終了。');
    process.exit(1);
  }

  let items = filterAndDedup(suumo, athome, fudo);
  console.log(`→ フィルタ&重複排除後 (今回取得分): ${items.length}件`);

  // Merge with snapshot: if any source got significantly fewer items than last snapshot,
  // keep snapshot items (likely still valid listings, just blocked by rate limit)
  const SNAPSHOT_PATH = path.join(ROOT, 'snapshot.json');
  let snapshotItems = [];
  try { snapshotItems = JSON.parse(await fs.readFile(SNAPSHOT_PATH, 'utf-8')); } catch {}
  if (snapshotItems.length > 0) {
    const currentIds = new Set(items.map(x => x.propId));
    const srcCurrCount = (src) => items.filter(x => x.source === src).length;
    const srcSnapCount = (src) => snapshotItems.filter(x => x.source === src).length;
    for (const src of ['SUUMO', 'athome', '不動産ジャパン']) {
      const curr = srcCurrCount(src);
      const snap = srcSnapCount(src);
      // If current scrape lost >= 30% of items for this source, merge snapshot items back
      if (snap > 0 && curr < snap * 0.7) {
        const recovered = snapshotItems.filter(x => x.source === src && !currentIds.has(x.propId));
        items.push(...recovered);
        console.log(`  ${src}: 今回${curr}件 < 前回${snap}件 → snapshot から${recovered.length}件復元`);
      }
    }
  }
  console.log(`→ snapshot マージ後: ${items.length}件`);

  console.log('→ ジオコード + OSRM...');
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (!x.location) continue;
    const geo = await geocode(x.location);
    if (!geo) continue;
    x.lat = geo.lat; x.lng = geo.lng;
    x.distKm = +haversine(ORIGIN, geo).toFixed(2);
    const drive = await osrmDrive(ORIGIN, geo);
    if (drive) { x.driveKm = drive.km; x.driveMin = drive.min; }
    await sleep(200);
    if ((i+1) % 20 === 0) console.log(`  ${i+1}/${items.length}`);
  }

  const newKnownIds = { ...knownIds };
  let newCount = 0;
  for (const x of items) {
    const prev = knownIds[x.propId];
    if (!prev) {
      newKnownIds[x.propId] = { firstSeen: today };
      x.isNew = true;
      newCount++;
    } else {
      x.isNew = prev.firstSeen >= cutoff;
      newKnownIds[x.propId] = prev;
    }
  }

  items.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) || a.priceMan - b.priceMan);

  const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const html = buildHtml(items, newCount, timestamp);
  await fs.writeFile(OUT_HTML, html, 'utf-8');
  await fs.writeFile(KNOWN_IDS_PATH, JSON.stringify(newKnownIds, null, 2), 'utf-8');
  // Save snapshot for next run's merge logic
  const SNAPSHOT_OUT = path.join(ROOT, 'snapshot.json');
  await fs.writeFile(SNAPSHOT_OUT, JSON.stringify(items, null, 2), 'utf-8');

  console.log(`✓ 完了 | 合計${items.length}件 | 新着${newCount}件 | ${timestamp}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
