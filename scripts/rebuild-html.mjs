#!/usr/bin/env node
// Rebuild HTML from existing combined_final.json snapshot (used when scrape partial)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_HTML = path.join(ROOT, 'index.html');
const KNOWN_IDS_PATH = path.join(ROOT, 'known_ids.json');
const SNAPSHOT = process.argv[2] || 'C:/Users/himaw/combined_final.json';

const ORIGIN = { lat: 34.931217, lng: 135.740479, label: '伏見区下鳥羽南円面田町52' };
const NEW_DAYS = 3;

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(items, newCount, timestamp) {
  const rows = items.map(x => {
    const dm = x.driveMin != null && x.driveMin !== '' ? Number(x.driveMin) : null;
    let driveClass = 'dt-unknown', driveBucket = 'over', driveTxt = '?';
    if (dm != null && !Number.isNaN(dm)) {
      driveTxt = `${dm} 分`;
      if (dm <= 15) { driveClass = 'dt-very-near'; driveBucket = '20'; }
      else if (dm <= 20) { driveClass = 'dt-near'; driveBucket = '20'; }
      else if (dm <= 25) { driveClass = 'dt-mid'; driveBucket = '25'; }
      else if (dm <= 30) { driveClass = 'dt-far'; driveBucket = '30'; }
      else { driveClass = 'dt-over'; driveBucket = 'over'; }
    }
    const srcClass = { 'SUUMO': 'src-suumo', 'athome': 'src-athome', '不動産ジャパン': 'src-fudo' }[x.source] || 'src-other';
    let name = x.name || '';
    name = name.replace(/\s*[\d,]+万円\s*画像\d*\s*$/, '').trim() || '(物件名なし)';
    const loc = escapeHtml(x.location || '-');
    const stn = escapeHtml(x.station || '-');
    name = escapeHtml(name);
    const imgCell = x.imgUrl ? `<img src="${x.imgUrl}" loading="lazy" alt="${name}" />` : '<span class=no-img>—</span>';
    const mapLink = x.lat && x.lng ? `https://www.google.com/maps/dir/?api=1&origin=${ORIGIN.lat},${ORIGIN.lng}&destination=${x.lat},${x.lng}&travelmode=driving&avoid=tolls` : '#';
    const mapBtn = x.lat && x.lng ? `<a class="map" href="${mapLink}" target="_blank" rel="noopener">経路</a>` : '';
    const newBadge = x.isNew ? '<span class="new-badge">🆕 NEW</span>' : '';
    const tsuboUnitTxt = x.tsuboUnit ? `${x.tsuboUnit}万/坪` : '-';
    const distText = x.driveKm != null && x.driveKm !== '' ? `${x.driveKm} <span class=u>km</span>` : '?';
    // Normalize propId (older data had different format)
    let propId = x.propId;
    if (!propId) {
      const idMatch = x.url?.match(/nc_(\d+)|\/b-?(\d+)|\/tochi\/(\d+)|\/show\/(\d+)/);
      const id = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3] || idMatch[4]) : x.url;
      propId = `${x.source}-${id}`;
    }
    return `<tr data-bucket="${driveBucket}" data-pid="${propId}" data-src="${x.source}" data-new="${x.isNew ? 'true' : 'false'}">
  <td class="fav"><input type="checkbox" class="fav-cb" data-pid="${propId}" aria-label="お気に入り"></td>
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
  const total20 = items.filter(x => x.driveMin != null && x.driveMin !== '' && Number(x.driveMin) <= 20).length;
  const total25 = items.filter(x => x.driveMin != null && x.driveMin !== '' && Number(x.driveMin) <= 25).length;
  const total30 = items.filter(x => x.driveMin != null && x.driveMin !== '' && Number(x.driveMin) <= 30).length;
  const srcCounts = { SUUMO: 0, athome: 0, '不動産ジャパン': 0 };
  items.forEach(x => { srcCounts[x.source] = (srcCounts[x.source] || 0) + 1; });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>京都市・八幡市 土地一覧</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; margin: 16px; background: #fafafa; color: #222; }
  h1 { font-size: 1.3em; margin: 0 0 4px; }
  .meta { color: #666; font-size: 0.85em; margin-bottom: 10px; line-height: 1.5; }
  .meta a { color: #0a66c2; }
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
  .badge { background: #e8f0fe; color: #1a73e8; padding: 3px 10px; border-radius: 12px; font-size: 0.85em; }
  body.view-20 tr:not([data-bucket="20"]) { display: none; }
  body.view-25 tr[data-bucket="30"], body.view-25 tr[data-bucket="over"] { display: none; }
  body.view-30 tr[data-bucket="over"] { display: none; }
  body.view-fav tr:not(.is-fav) { display: none; }
  body.view-new tr:not([data-new="true"]) { display: none; }
  body.shared-view tr:not(.shared-item) { display: none; }
  #empty-fav, #empty-new { display: none; padding: 40px; text-align: center; color: #888; background: #fff; border-radius: 8px; }
  body.view-fav #empty-fav, body.view-new #empty-new { display: block; }
  .shared-banner { background: #e3f2fd; border-left: 4px solid #0a66c2; padding: 10px 14px; margin: 8px 0; border-radius: 4px; font-size: 0.9em; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .shared-banner .icon { font-size: 1.3em; }
  .shared-banner strong { color: #0a66c2; }
  .shared-banner button { padding: 6px 10px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; font-size: 0.9em; }
  .shared-banner .btn-import { background: #0a66c2; color: #fff; border-color: #0a66c2; }
  .shared-banner .btn-back { background: #fff; color: #555; border-color: #ccc; }
  .tab.share-btn { background: #17a2b8; color: #fff; }
  .tab.share-btn:hover { background: #138496; }
  @media (max-width: 700px) {
    body { margin: 8px; }
    td.img img { width: 80px; height: 60px; }
    td.img { width: 90px; }
    th, td { padding: 5px; font-size: 0.82em; }
  }
</style>
</head>
<body>
<h1>🏡 京都市・八幡市 土地一覧</h1>
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
  <button class="tab share-btn" onclick="shareFavs()">🔗 共有</button>
  <button class="clear-btn" onclick="clearFavs()">お気に入り解除</button>
</div>
<div id="shared-banner-container"></div>
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
async function shareFavs() {
  const favs = [...loadFavs()];
  if (!favs.length) { alert('お気に入りが空です。物件のチェックを入れてから共有してください。'); return; }
  const url = location.href.split('#')[0] + '#fav=' + favs.map(encodeURIComponent).join(',');
  try {
    await navigator.clipboard.writeText(url);
    alert('共有URLをコピーしました (' + favs.length + '件)\\n\\nLINEやメールに貼り付けて送ってください。\\n受け取った人が開くと、このリストだけ表示されます。');
  } catch {
    prompt('以下のURLをコピーして共有してください:', url);
  }
}
function importShared(ids) {
  const favs = loadFavs();
  let added = 0;
  ids.forEach(id => { if (!favs.has(id)) { favs.add(id); added++; } });
  saveFavs(favs);
  applyFavs();
  alert(added + '件を自分のお気に入りに追加しました (既にあった' + (ids.length - added) + '件はスキップ)');
}
function clearSharedView() {
  history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.remove('shared-view');
  document.getElementById('shared-banner-container').innerHTML = '';
  document.querySelectorAll('.shared-item').forEach(t => t.classList.remove('shared-item'));
}
function initSharedView() {
  const m = location.hash.match(/^#fav=(.+)$/);
  if (!m) return;
  const ids = m[1].split(',').map(decodeURIComponent);
  const idSet = new Set(ids);
  let matched = 0;
  document.querySelectorAll('tr[data-pid]').forEach(tr => {
    if (idSet.has(tr.dataset.pid)) { tr.classList.add('shared-item'); matched++; }
  });
  document.body.classList.add('shared-view');
  const container = document.getElementById('shared-banner-container');
  const idsEscaped = ids.map(id => id.replace(/'/g,"\\\\'"));
  container.innerHTML = '<div class="shared-banner"><span class="icon">🔗</span> <strong>共有されたお気に入りリスト</strong> (' + matched + '/' + ids.length + '件表示中)' +
    '<button class="btn-import" onclick="importShared([' + idsEscaped.map(i => "'"+i+"'").join(',') + '])">📥 自分のお気に入りに追加</button>' +
    '<button class="btn-back" onclick="clearSharedView()">✖ 元の一覧に戻る</button></div>';
}
document.addEventListener('change', e => {
  if (e.target.matches('.fav-cb')) toggleFav(e.target.dataset.pid, e.target.checked);
});
applyFavs();
if (location.hash.startsWith('#fav=')) {
  initSharedView();
} else {
  setView('20');
}
</script>
</body></html>`;
}

// Main
const raw = JSON.parse(await fs.readFile(SNAPSHOT, 'utf-8'));
const items = (Array.isArray(raw) ? raw : (raw.filtered || raw.items || [])).filter(x =>
  x.priceMan != null && Number(x.priceMan) >= 100 && Number(x.priceMan) <= 2000 &&
  x.areaM2 != null && Number(x.areaM2) >= 109
);
items.sort((a, b) => Number(a.priceMan) - Number(b.priceMan));
const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
const html = buildHtml(items, 0, ts);
await fs.writeFile(OUT_HTML, html, 'utf-8');
console.log(`✓ HTML rebuilt from snapshot: ${items.length} items`);
