/**
 * emp_fetch_local.js — 従業員数（②）年金機構データのローカル・フェッチャ
 * ---------------------------------------------------------------
 * 【なぜローカルか】GAS（UrlFetchApp）はUser-Agentを「Google-Apps-Script」固定でしか送れず、
 * 非ブラウザUAを403遮断する年金機構のWAFを通過できない（nettestで実証: トップ200/検索403）。
 * そのため年金機構の検索だけをローカル（PC）で行い、結果をGASの「従業員数キャッシュ」シートに
 * 投入する。GASの「2. 従業員数>実行」はキャッシュを使って判定・dryrun・適用まで完結する。
 *
 * フロー:
 *   1. HubSpot（読み取り専用）から対象dealの法人番号を収集（fill=空/0、update=1以上）
 *   2. 未取得（emp_cache_local.json のTTL外）の法人番号を年金機構で検索（1200ms間隔・礼儀あるアクセス）
 *   3. 結果を web アプリの「従業員数キャッシュ」へ追記（GASの既存 appendRows_ 経由）
 *
 * 実行: node emp_fetch_local.js [--fill] [--update] [--limit 300]
 *   --fill / --update … 対象の限定（省略時は両方） / --limit … 1回で検索する法人番号数の上限
 * ※HubSpotへの書き込みは行わない。GAS側はEMP_FETCH_MODE=local で運用する。
 */
const fs = require('fs');
const path = require('path');

// ---- 設定 ----
// 認証・URL: GitHub Actions では Secrets（HS_TOKEN / GAS_WEB_URL）、ローカルでは gas_run/params_bootstrap.json
let HS_TOKEN = process.env.HS_TOKEN || '';
if (!HS_TOKEN) {
  try {
    const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'gas_run', 'params_bootstrap.json'), 'utf8'));
    HS_TOKEN = params[0];
  } catch (e) { /* リポジトリ単体環境（GitHub等）ではファイルが無い */ }
}
if (!HS_TOKEN) {
  console.error('ERROR: HS_TOKEN が未設定です（環境変数 HS_TOKEN か gas_run/params_bootstrap.json を設定してください）');
  process.exit(1);
}
const WEB_URL = process.env.GAS_WEB_URL || 'https://script.google.com/macros/s/AKfycbxnsq89breuqmvKm94wzFwlxsNB0qAFXr6RPMvO93BOSZr4VWPJG-ejdzkGcQe9XTjWQQ/exec';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const INTERVAL_MS = 1200;        // 年金機構への検索間隔（礼儀あるアクセス）
const CACHE_DAYS_OK = 30;        // okキャッシュの有効期間（年金機構は毎月更新）
const CACHE_DAYS_NONE = 3;       // 0件キャッシュの再試行期間
const LOCAL_CACHE = path.join(__dirname, 'emp_cache_local.json');
const LOCAL_STATE = path.join(__dirname, 'emp_fetch_state.json');   // createdateカーソル（進行管理）

// ---- 判定・パーサ（05_GAS_開始診断.gs の同名関数と同期すること。リポジトリ単体で動くよう内蔵） ----
function isValidHoujin_(num) {
  if (!num || !/^\d{13}$/.test(num)) return false;
  const base = num.slice(1);
  let total = 0;
  for (let n = 1; n <= 12; n++) {
    total += Number(base.charAt(12 - n)) * (n % 2 === 1 ? 1 : 2);
  }
  return Number(num.charAt(0)) === 9 - (total % 9);
}
function nenkinStrip_(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, '').replace(/[\s\u3000]+/g, '');
}
function parseNenkinResult_(html) {
  const s = String(html);
  if (s.indexOf('法人番号は13桁で入力してください') >= 0) return { status: 'format', count: 0, offices: 0 };
  if (s.indexOf('該当する事業所がありません') >= 0) return { status: 'none', count: 0, offices: 0 };
  const i = s.indexOf('検索結果');
  const seg = i >= 0 ? s.slice(i) : s;
  const hit = seg.match(/([\d,]+)件が該当しました/);
  if (!hit) return { status: 'unknown', count: 0, offices: 0 };
  const ths = [];
  const re = /<th[^>]*>([\s\S]*?)<\/th>/g;
  let m;
  while ((m = re.exec(seg))) ths.push(nenkinStrip_(m[1]));
  let colCount = -1, colState = -1;
  for (let c = 0; c < ths.length; c++) {
    if (ths[c].indexOf('被保険者数') >= 0) colCount = c;
    if (ths[c].indexOf('現存') >= 0 && ths[c].indexOf('全喪') >= 0) colState = c;
  }
  if (colCount < 0) colCount = 7;
  if (colState < 0) colState = 4;
  let sum = 0, rows = 0;
  const rre = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rm;
  while ((rm = rre.exec(seg))) {
    const tds = [];
    const tre = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tm;
    while ((tm = tre.exec(rm[1]))) tds.push(nenkinStrip_(tm[1]));
    if (!tds.length) continue;
    rows++;
    if (tds[colState] === '全喪') continue;
    const n = Number(String(tds[colCount] || '').replace(/,/g, ''));
    if (!isNaN(n)) sum += n;
  }
  const upd = s.match(/データ更新日：(\d+年\d+月\d+日)/);
  const hitN = Number(hit[1].replace(/,/g, ''));
  return {
    status: 'ok', count: sum, offices: rows, hit: hitN,
    partial: rows < hitN,
    datadate: upd ? upd[1] : ''
  };
}

// ---- CLI ----
const args = process.argv.slice(2);
const doFill = args.includes('--fill') || (!args.includes('--fill') && !args.includes('--update'));
const doUpdate = args.includes('--update') || (!args.includes('--fill') && !args.includes('--update'));
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 300;

// ---- HubSpot（読み取り専用） ----
async function hsSearch(filterGroups, after) {
  const body = { filterGroups, limit: 200, sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }],
    properties: ['houjin', 'kigyouzentaininzuu', 'dealname', 'company_name'] };
  if (after) body.after = after;
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + HS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HubSpot ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}
// GAS の empFilterGroups_ と同じ対象定義
const FILL_GROUPS = [
  { filters: [{ propertyName: 'kigyouzentaininzuu', operator: 'NOT_HAS_PROPERTY' }, { propertyName: 'houjin', operator: 'HAS_PROPERTY' }] },
  { filters: [{ propertyName: 'kigyouzentaininzuu', operator: 'LT', value: '1' }, { propertyName: 'houjin', operator: 'HAS_PROPERTY' }] }
];
const UPDATE_GROUP = [{ filters: [{ propertyName: 'kigyouzentaininzuu', operator: 'GTE', value: '1' }, { propertyName: 'houjin', operator: 'HAS_PROPERTY' }] }];

// 対象収集: 取得済み（キャッシュ有効）はスキップして先へ進む＋createdateカーソルで全体を回転する
// （先頭の取得済み法人ばかりを見て止まるのを防ぐ。HubSpot検索はページング10,000件上限のため）
async function collectHoujins(mode, cache, cursor, limit) {
  const groups = mode === 'fill' ? FILL_GROUPS : UPDATE_GROUP;
  const fgs = groups.map((g) => {
    const f = g.filters.slice();
    if (cursor) f.push({ propertyName: 'hs_createdate', operator: 'GTE', value: String(cursor) });
    return { filters: f };
  });
  const out = new Map();
  let after = null, scanned = 0, maxCreated = cursor || 0, exhausted = false;
  while (out.size < limit && scanned < 9000) {
    const r = await hsSearch(fgs, after);
    const res = r.results || [];
    scanned += res.length;
    for (const d of res) {
      const cd = Number(d.properties.hs_createdate) || 0;
      if (cd > maxCreated) maxCreated = cd;
      const no = String(d.properties.houjin || '').trim();
      if (!isValidHoujin_(no)) continue;
      if (out.has(no)) continue;
      if (cacheValid(cache[no])) continue;   // ★取得済みは候補にしない（進行のため）
      const name = String(d.properties.company_name || d.properties.dealname || '').trim();
      const e = out.get(no) || { name, ids: [] };
      if (!e.name) e.name = name;
      if (e.ids.length < 20) e.ids.push(String(d.id));
      out.set(no, e);
    }
    if (!r.paging || !r.paging.next) { exhausted = true; break; }
    after = r.paging.next.after;
  }
  return {
    targets: [...out.entries()].slice(0, limit).map(([no, e]) => ({ no, name: e.name, ids: e.ids.join(',') })),
    maxCreated, exhausted, scanned
  };
}

// 法人番号に紐づく全dealIDをHSから直接取得（ウィンドウ走査だけだと多deal法人で欠落するため）
async function dealIdsForHoujin(no) {
  const ids = [];
  let after = null, total = 0, name = '';
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'houjin', operator: 'EQ', value: no }] }],
      limit: 100, properties: ['dealname', 'company_name']
    };
    if (after) body.after = after;
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + HS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HubSpot ' + res.status);
    const r = await res.json();
    total = r.total || 0;
    for (const d of (r.results || [])) {
      if (ids.length < 500) ids.push(String(d.id));
      if (!name) name = String(d.properties.company_name || d.properties.dealname || '').trim();
    }
    after = r.paging && r.paging.next ? r.paging.next.after : null;
  } while (after && ids.length < 500);
  return {
    ids: ids.length < total ? ids.join(',') + '…他' + (total - ids.length) + '件' : ids.join(','),
    name, total
  };
}

// ---- 年金機構（ローカルから・実証済みフロー） ----
function tokenFrom(html) { const m = String(html).match(/name="hdnTransactionToken"\s+value="([^"]+)"/); return m ? m[1] : null; }
function cookieFrom(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return raw.map((c) => String(c).split(';')[0]).join('; ');
}
async function nenkinSearchChain(houjins) {
  const out = [];
  let ses = null;
  for (let i = 0; i < houjins.length; i++) {
    const no = houjins[i];
    let r = null;
    for (let t = 0; t < 2 && !r; t++) {
      try {
        if (!ses) {
          const g = await fetch('https://www.nenkin.go.jp/do/search_section/', {
            headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ja' }
          });
          if (!g.ok) throw new Error('GET ' + g.status);
          const html = await g.text();
          const token = tokenFrom(html);
          if (!token) throw new Error('トークン取得失敗');
          ses = { cookie: cookieFrom(g), token };
        }
        const payload = [
          'hdnPrefectureCode=', 'hdnSearchOffice=1', 'hdnSearchCriteria=3',
          'txtOfficeName=', 'txtOfficeAddress=', 'txtHoujinNo=' + encodeURIComponent(no),
          'hdnDisplayItemsRestorationScreenDto=', 'hdnDisplayItemsRestorationScreenDtoKeepParam=false',
          'hdnTransactionToken=' + encodeURIComponent(ses.token), 'hdnTokenKeepParam=false',
          'gmnId=GB10001SC010', 'hdnErrorFlg=',
          'eventId=' + encodeURIComponent('/SEARCH.HTML'), encodeURIComponent('/search.html') + '='
        ].join('&');
        const p = await fetch('https://www.nenkin.go.jp/do/search_section', {
          method: 'post',
          headers: {
            'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ja',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Cookie: ses.cookie,
            Referer: 'https://www.nenkin.go.jp/do/search_section/',
            Origin: 'https://www.nenkin.go.jp'
          },
          body: payload
        });
        if (!p.ok) throw new Error('POST ' + p.status);
        const html = await p.text();
        const next = tokenFrom(html);
        if (next) ses.token = next; else { ses = null; }
        r = parseNenkinResult_(html);
        if (r.status === 'unknown') { ses = null; r = null; }
      } catch (e) {
        ses = null;
        if (t === 1) r = { status: 'error', count: 0, offices: 0, error: String(e) };
      }
    }
    if (!r) r = { status: 'error', count: 0, offices: 0, error: 'unknown' };
    out.push({ no, r });
    process.stdout.write(`  ${i + 1}/${houjins.length} ${no} -> ${r.status}${r.status === 'ok' ? ' ' + r.count : ''}\n`);
    if (i < houjins.length - 1) await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
  return out;
}

// ---- キャッシュ（ローカル） ----
function loadLocalCache() {
  try { return JSON.parse(fs.readFileSync(LOCAL_CACHE, 'utf8')); } catch (e) { return {}; }
}
function saveLocalCache(cache) {
  fs.writeFileSync(LOCAL_CACHE, JSON.stringify(cache), 'utf8');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8')); } catch (e) { return {}; }
}
function saveState(state) {
  fs.writeFileSync(LOCAL_STATE, JSON.stringify(state), 'utf8');
}
function cacheValid(entry) {
  if (!entry || !entry.at) return false;
  const age = Date.now() - new Date(entry.at).getTime();
  if (entry.status === 'ok') return age < CACHE_DAYS_OK * 86400000;
  if (entry.status === 'none') return age < CACHE_DAYS_NONE * 86400000;
  return false;   // error は即再試行
}

// ---- GAS（web アプリ）へキャッシュ投入 ----
async function pushCache(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const res = await fetch(WEB_URL, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetName: '従業員数キャッシュ', rows: slice })
    });
    const text = await res.text();
    if (!text.includes('"added"')) throw new Error('web app push failed: ' + text.slice(0, 200));
    console.log('  push: ' + slice.length + '行 -> ' + text.trim());
  }
}

// ---- メイン ----
(async () => {
  // --push-all: 年金機構へ行かず、emp_cache_local.json の内容をそのまま再投入する（レイアウト移行・再構築用）
  if (process.argv.includes('--push-all')) {
    const cache = loadLocalCache();
    const rows = Object.entries(cache).map(([no, e]) => [
      no, e.name || '', e.ids || '', e.count || 0, e.offices || 0, e.status || '',
      e.at || new Date().toISOString(), e.datadate || ''
    ]);
    if (!rows.length) { console.log('emp_cache_local.json にデータがありません'); return; }
    await pushCache(rows);
    console.log('re-push 完了: ' + rows.length + '行（' + rows.length + '法人）');
    return;
  }
  console.log('対象: ' + (doFill ? '補完(fill) ' : '') + (doUpdate ? '更新(update)' : '') + ' / limit=' + LIMIT);
  const cache = loadLocalCache();
  const state = loadState();
  const modes = (doFill ? ['fill'] : []).concat(doUpdate ? ['update'] : []);
  let anyFetched = false;
  for (const mode of modes) {
    const cursorKey = mode === 'fill' ? 'cursorFill' : 'cursorUpdate';
    const cursor = Number(state[cursorKey]) || 0;
    console.log('[' + mode + '] カーソル=' + (cursor ? new Date(cursor).toISOString() : '(先頭)'));
    const { targets, maxCreated, exhausted, scanned } = await collectHoujins(mode, cache, cursor, LIMIT);
    console.log('[' + mode + '] 未取得の対象: ' + targets.length + '件（走査' + scanned + 'deal）');
    if (targets.length) {
      anyFetched = true;
      const results = await nenkinSearchChain(targets.map((t) => t.no));
      const now = new Date().toISOString();
      const pushRows = [];
      for (const { no, r } of results) {
        // 法人名/dealIdsはHSから全件取得して正確に記録する（ウィンドウ走査だと欠落するため）
        let info = { name: '', ids: '', total: 0 };
        try { info = await dealIdsForHoujin(no); } catch (e) { /* 失敗時はターゲット時点の値で記録 */ }
        const t = targets.find((x) => x.no === no) || { name: '', ids: '' };
        const name = info.name || t.name;
        const ids = info.ids || t.ids;
        cache[no] = {
          status: r.status, count: r.status === 'ok' ? r.count : 0, offices: r.offices || 0,
          datadate: r.datadate || '', at: now, name, ids
        };
        // 列: 法人番号 / 法人名 / dealIds / 被保険者数 / 事業所数 / 状況 / 取得日時 / 年金データ更新日
        pushRows.push([no, name, ids, cache[no].count, cache[no].offices, r.status, now, cache[no].datadate]);
        process.stdout.write('  ids: ' + no + ' -> ' + (info.total || '?') + 'deal\n');
      }
      await pushCache(pushRows);   // 成功してからローカルキャッシュを更新（失敗時は次回再取得）
      saveLocalCache(cache);
    }
    // カーソル前進（同一createdate固まりで停滞しないよう+1ms）。1周したら先頭へ（回転制）
    if (exhausted) {
      state[cursorKey] = 0;
      console.log('[' + mode + '] 1周完了 → 先頭から再開');
    } else if (maxCreated > cursor) {
      state[cursorKey] = maxCreated + 1;
    }
    saveState(state);
  }
  if (!anyFetched) console.log('取得すべきデータはありません（対象範囲は全て取得済み）');
  console.log('\n次のステップ: GASの「2. 従業員数 > 2. 実行」（または run_emp_loop.ps1）で判定・プレビューへ');
})().catch((e) => { console.error('ERROR: ' + e.stack); process.exit(1); });
