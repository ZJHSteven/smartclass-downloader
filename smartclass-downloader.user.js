// ==UserScript==
// @name         智慧课堂：批量抓MP4 + 自动命名下载（队列版）
// @namespace    https://example.local/
// @version      0.4
// @description  解析“相关推荐”列表(NewID+title)，按日期队列打开后台播放页；在每个页里通过拦截 XHR/fetch/DOM 捕获 mp4 URL 并 GM_download 自动下载。
// @match        https://tmu.smartclass.cn/PlayPages/Video.aspx*
// @grant        GM_download
// @grant        GM_openInTab
// ==/UserScript==

(function () {
  'use strict';

  /******************* 工具 *******************/
  const qs = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));

  function sanitizeFilename(name) {
    return String(name)
      .replace(/[\\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getParam(name) {
    return new URL(location.href).searchParams.get(name);
  }

  function uniq(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
  }

  // 从 title="人体功能学 张玲 第二教室 2025-12-12 08:00:00-08:45:00"
  // 生成文件名：2025-12-12_人体功能学_张玲_第二教室_08-00-08-45.mp4
  function filenameFromMeta(meta) {
    const raw = (meta || '').trim();
    const m = raw.match(/^(.*)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}):\d{2}-(\d{2}:\d{2}):\d{2}$/);
    if (!m) return sanitizeFilename(raw || '课程录播') + '.mp4';
    const prefix = m[1].trim().replace(/\s+/g,'_');
    const date = m[2];
    const t1 = m[3].replace(':','-');
    const t2 = m[4].replace(':','-');
    return sanitizeFilename(`${date}_${prefix}_${t1}-${t2}.mp4`);
  }

  function parseDate(meta) {
    return (meta.match(/(\d{4}-\d{2}-\d{2})/) || [,''])[1];
  }

  /******************* UI + 日志 *******************/
  const panel = document.createElement('div');
  panel.style.cssText = `
    position:fixed; right:16px; bottom:16px; z-index:999999;
    width:520px; max-height:60vh; overflow:auto;
    background:#0b0f14; color:#eaf2ff; padding:12px;
    border-radius:12px; font-size:12px; line-height:1.45;
    box-shadow:0 10px 28px rgba(0,0,0,.45);
    border:1px solid rgba(255,255,255,.10);
  `;
  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
      <div style="font-weight:900;">智慧课堂下载助手（队列版）</div>
      <button id="tm_clear" style="cursor:pointer; padding:4px 8px;">清空日志</button>
    </div>
    <div id="tm_info" style="opacity:.85; margin:6px 0 10px;"></div>

    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; align-items:center;">
      <label style="opacity:.85;">选择日期：</label>
      <select id="tm_date" style="padding:4px 6px;"></select>
      <button id="tm_dl_date" style="cursor:pointer; font-weight:800; padding:4px 10px;">下载该日期（队列）</button>
      <button id="tm_dl_latest" style="cursor:pointer; padding:4px 10px;">下载最新日期（队列）</button>
      <button id="tm_dl_this" style="cursor:pointer; padding:4px 10px;">下载本页</button>
    </div>

    <div style="opacity:.75; margin-bottom:8px;">
      说明：不靠自动播放。页面一旦“请求/返回/DOM中出现 mp4 链接”，就抓到并触发下载。
    </div>

    <details style="margin-bottom:8px;">
      <summary style="cursor:pointer; opacity:.9;">日志（点开看细节）</summary>
      <pre id="tm_log" style="white-space:pre-wrap; word-break:break-word; background:#071018; padding:8px; border-radius:10px; margin-top:8px; border:1px solid rgba(255,255,255,.08);"></pre>
    </details>

    <div id="tm_list"></div>
  `;
  document.documentElement.appendChild(panel);

  const logEl = qs('#tm_log', panel);
  function log(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.log('[TM]', msg);
    logEl.textContent += `[TM] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
  qs('#tm_clear', panel).addEventListener('click', () => logEl.textContent = '');

  /******************* 抓 mp4：XHR/fetch/DOM/资源兜底 *******************/
  const mp4Set = new Set();

  function addMp4(url, from='unknown') {
    if (!url) return;
    if (!url.includes('.mp4')) return;
    // 过滤掉奇怪的“伪 mp4”
    if (url.startsWith('blob:')) return;

    if (!mp4Set.has(url)) {
      mp4Set.add(url);
      log(`抓到MP4(${from}):`, url);
    }
  }

  // 1) 拦截 XHR
  (function hookXHR(){
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try { this.__tm_url = new URL(url, location.origin).toString(); } catch(e) { this.__tm_url = String(url); }
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      this.addEventListener('load', () => {
        const u = this.__tm_url || '';
        if (u.includes('.mp4')) addMp4(u, 'XHR-req');

        // 尝试从响应文本里扒 mp4
        try {
          const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
          if (ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
            const txt = this.responseText || '';
            const ms = txt.match(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/g);
            if (ms) ms.forEach(x => addMp4(x, 'XHR-res'));
          }
        } catch(e) {}
      });
      return origSend.call(this, body);
    };
  })();

  // 2) 拦截 fetch
  (function hookFetch(){
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? new URL(input, location.origin).toString() : (input && input.url) || '';
      if (url.includes('.mp4')) addMp4(url, 'fetch-req');

      const res = await origFetch(input, init);
      try {
        const clone = res.clone();
        const ct = (clone.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
          const txt = await clone.text();
          const ms = txt.match(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/g);
          if (ms) ms.forEach(x => addMp4(x, 'fetch-res'));
        }
      } catch(e) {}
      return res;
    };
  })();

  // 3) 监听 DOM：video/source/src 变化
  (function hookDOM(){
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          const el = m.target;
          if (el && (el.tagName === 'VIDEO' || el.tagName === 'SOURCE')) {
            const src = el.getAttribute('src') || '';
            if (src.includes('.mp4')) addMp4(src, 'DOM-attr');
          }
        }
      }
    });
    mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['src'] });
  })();

  // 4) 兜底扫 performance
  function scanPerformance() {
    const entries = performance.getEntriesByType('resource') || [];
    for (const e of entries) {
      const u = e.name || '';
      if (u.includes('.mp4')) addMp4(u, 'perf');
    }
  }
  setInterval(scanPerformance, 1200);

  /******************* 解析“相关推荐” *******************/
  function parseRecommendList() {
    const ul = qs('ul.about_video');
    if (!ul) return [];

    const items = [];
    qsa('li a[href*="Video.aspx?NewID="]', ul).forEach(a => {
      const href = a.getAttribute('href') || '';
      const full = new URL(href, location.origin).toString();
      const u = new URL(full);
      const newId = u.searchParams.get('NewID') || '';

      const titleP = qs('p.title', a);
      const meta = (titleP?.getAttribute('title') || '').trim();

      if (newId) {
        items.push({
          newId,
          url: full,
          meta,
          date: parseDate(meta),
          filename: filenameFromMeta(meta || `NewID_${newId}`)
        });
      }
    });

    // 日期+时间排序（更像课表顺序）
    items.sort((x,y) => (x.meta || '').localeCompare(y.meta || ''));
    return items;
  }

  function getLatestDate(items) {
    const dates = uniq(items.map(x => x.date)).sort();
    return dates[dates.length - 1] || '';
  }

  /******************* 队列：后台打开 → 每页自动下载 *******************/
  const queueKey = 'tm_queue_v1';

  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(queueKey) || '[]'); } catch(e) { return []; }
  }
  function saveQueue(q) {
    localStorage.setItem(queueKey, JSON.stringify(q));
  }

  function enqueue(items) {
    const q = loadQueue();
    // 去重：按 newId
    const have = new Set(q.map(x => x.newId));
    for (const it of items) if (!have.has(it.newId)) q.push(it);
    saveQueue(q);
    log(`队列加入 ${items.length} 条，当前队列总数=${q.length}`);
  }

  function openNextFromQueue(concurrency = 2) {
    // 用 localStorage 做一个很轻量的“并发计数”
    const inflightKey = 'tm_inflight';
    const inflight = Number(localStorage.getItem(inflightKey) || '0');

    if (inflight >= concurrency) {
      log(`并发已满(${inflight}/${concurrency})，稍后再开下一个`);
      return;
    }

    const q = loadQueue();
    if (!q.length) {
      log('队列为空：没有要下载的条目');
      return;
    }

    const next = q.shift();
    saveQueue(q);

    // 标记 inflight +1
    localStorage.setItem(inflightKey, String(inflight + 1));

    const u = new URL(next.url);
    u.searchParams.set('tm_autodl', '1');
    u.searchParams.set('tm_fn', next.filename);
    u.searchParams.set('tm_newid', next.newId);

    log('打开后台页：', u.toString());
    GM_openInTab(u.toString(), { active: false, insert: true, setParent: true });
  }

  // 队列调度器：每 1.5 秒尝试开一个
  setInterval(() => openNextFromQueue(2), 1500);

  /******************* 自动下载模式（后台页自己下载自己） *******************/
function bytesHuman(n) {
  if (typeof n !== 'number' || n < 0) return '未知';
  const units = ['B','KB','MB','GB'];
  let i = 0, x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)}${units[i]}`;
}

function ensureDlBox() {
  // 把进度展示塞进面板里（你脚本里 panel 我之前让你挂到 window.__tm_panel 了）
  const host = window.__tm_panel || document.body;
  let box = host.querySelector('#tm_dl_box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tm_dl_box';
    box.style.cssText = `
      margin:8px 0; padding:10px;
      border:1px solid rgba(255,255,255,.18);
      border-radius:12px;
      background:rgba(255,255,255,.04);
    `;
    box.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px;">下载状态</div>
      <div id="tm_dl_rows" style="display:flex; flex-direction:column; gap:8px;"></div>
    `;
    host.appendChild(box);
  }
  return box.querySelector('#tm_dl_rows');
}

const __tmDlState = new Map(); // filename -> state

function renderDlState() {
  const rows = ensureDlBox();
  const items = Array.from(__tmDlState.values()).slice(-6); // 只显示最近6条，免得太长
  rows.innerHTML = items.map(s => {
    const pct = (s.total > 0) ? Math.floor((s.loaded / s.total) * 100) : 0;
    const barW = (s.total > 0) ? pct : 5;

    const color =
      s.status === 'done' ? '#7CFC00' :
      s.status === 'error' ? '#ff6b6b' :
      '#8ab4ff';

    const detail =
      s.status === 'downloading'
        ? `${pct}%  ${bytesHuman(s.loaded)}/${bytesHuman(s.total)}  速度≈${bytesHuman(s.speed)}/s`
        : (s.status === 'done' ? '完成' : (s.err || '失败'));

    return `
      <div style="border:1px solid rgba(255,255,255,.10); border-radius:10px; padding:8px;">
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <div style="opacity:.95; word-break:break-all;">${s.filename}</div>
          <div style="color:${color}; font-weight:800; white-space:nowrap;">${s.status}</div>
        </div>
        <div style="height:8px; background:rgba(255,255,255,.10); border-radius:999px; overflow:hidden; margin:6px 0;">
          <div style="height:100%; width:${barW}%; background:${color};"></div>
        </div>
        <div style="opacity:.85;">${detail}</div>
      </div>
    `;
  }).join('');
}

// 这个就是你要替换的 gmDownload
function gmDownload(url, filename) {
  const now = Date.now();
  __tmDlState.set(filename, {
    filename,
    status: 'downloading',
    loaded: 0,
    total: -1,
    speed: 0,
    t0: now,
    lastT: now,
    lastLoaded: 0,
    err: ''
  });
  renderDlState();
  log('开始下载：', filename);

  GM_download({
    url,
    name: filename,
    saveAs: false,
    timeout: 60000, // 1分钟无响应算超时（不影响正常大文件，只是让你能看到“卡住了”）

    onprogress: (e) => {
      const st = __tmDlState.get(filename);
      if (!st) return;

      const t = Date.now();
      const loaded = (typeof e.loaded === 'number') ? e.loaded : st.loaded;
      const total  = (typeof e.total === 'number') ? e.total : st.total;

      // 粗略速度：最近一次回调的增量 / 时间
      const dt = Math.max(1, t - st.lastT);
      const dL = Math.max(0, loaded - st.lastLoaded);
      const speed = Math.floor((dL * 1000) / dt);

      st.loaded = loaded;
      st.total = total;
      st.speed = speed;
      st.lastT = t;
      st.lastLoaded = loaded;

      __tmDlState.set(filename, st);

      // 限流渲染，避免太频繁
      if (!st.__lastRender || t - st.__lastRender > 300) {
        st.__lastRender = t;
        renderDlState();
      }
    },

    onload: () => {
      const st = __tmDlState.get(filename);
      if (st) {
        st.status = 'done';
        st.speed = 0;
        __tmDlState.set(filename, st);
      }
      renderDlState();
      log('下载完成：', filename);
    },

    onerror: (err) => {
      const st = __tmDlState.get(filename);
      if (st) {
        st.status = 'error';
        st.err = (err && (err.error || err.message)) ? String(err.error || err.message) : '下载失败';
        __tmDlState.set(filename, st);
      }
      renderDlState();
      log('下载失败：', filename, JSON.stringify(err || {}));
    },

    ontimeout: () => {
      const st = __tmDlState.get(filename);
      if (st) {
        st.status = 'error';
        st.err = '下载超时（网络不稳定/被节流）';
        __tmDlState.set(filename, st);
      }
      renderDlState();
      log('下载超时：', filename);
    },
  });
}


  async function runAutoDownloadIfNeeded() {
    if (getParam('tm_autodl') !== '1') return;

    const wantedName = sanitizeFilename(getParam('tm_fn') || '课程录播.mp4');
    const newId = getParam('tm_newid') || '';

    // 防重复
    const doneKey = `tm_done_${newId}_${wantedName}`;
    if (localStorage.getItem(doneKey) === '1') {
      log('已下载过，跳过：', wantedName);
      // inflight -1
      const inflightKey = 'tm_inflight';
      const inflight = Math.max(0, Number(localStorage.getItem(inflightKey) || '1') - 1);
      localStorage.setItem(inflightKey, String(inflight));
      return;
    }

    log('自动下载模式启动，目标文件名：', wantedName);

    // 等待 mp4 出现（最多 25 秒）
    const start = Date.now();
    while (Date.now() - start < 25000) {
      scanPerformance();

      const mp4 = Array.from(mp4Set).find(u => u.includes('tmuvod.smartclass.cn') || u.includes('.mp4'));
      if (mp4) {
        log('准备下载：', mp4);
        gmDownload(mp4, wantedName);
        localStorage.setItem(doneKey, '1');

        // inflight -1
        const inflightKey = 'tm_inflight';
        const inflight = Math.max(0, Number(localStorage.getItem(inflightKey) || '1') - 1);
        localStorage.setItem(inflightKey, String(inflight));

        // 尝试自动关闭标签页（只对脚本打开的页通常有效；不行也无所谓）
        setTimeout(() => { try { window.close(); } catch(e) {} }, 3000);
        return;
      }

      await new Promise(r => setTimeout(r, 350));
    }

    log('超时仍未抓到 mp4：这页可能没触发取源接口（后台节流/站点逻辑），建议手动点一下播放再试。');

    // inflight -1
    const inflightKey = 'tm_inflight';
    const inflight = Math.max(0, Number(localStorage.getItem(inflightKey) || '1') - 1);
    localStorage.setItem(inflightKey, String(inflight));
  }

  runAutoDownloadIfNeeded();

  /******************* 渲染列表 + 按钮逻辑 *******************/
  function updateUI() {
    const rec = parseRecommendList();

    const info = qs('#tm_info', panel);
    info.textContent = `本页 NewID=${getParam('NewID') || '(无)'} ｜ 推荐条目数=${rec.length} ｜ 已捕获MP4数=${mp4Set.size}`;

    // 日期下拉
    const dates = uniq(rec.map(x => x.date)).sort();
    const sel = qs('#tm_date', panel);
    sel.innerHTML = dates.map(d => `<option value="${d}">${d}</option>`).join('');
    if (dates.length) sel.value = getLatestDate(rec);

    // 列表展示
    const list = qs('#tm_list', panel);
    if (!rec.length) {
      list.innerHTML = `<div style="opacity:.7;">未检测到相关推荐列表（ul.about_video）。</div>`;
      return;
    }
    list.innerHTML = rec.map(it => `
      <div style="border-top:1px solid rgba(255,255,255,.10); padding:8px 0;">
        <div style="opacity:.95;">${it.meta}</div>
        <div style="opacity:.75;">NewID=${it.newId}</div>
        <div style="opacity:.75;">文件名=${it.filename}</div>
      </div>
    `).join('');
  }

  setTimeout(updateUI, 1200);
  setInterval(updateUI, 5000);

  // 下载本页：一旦抓到 mp4 就下；没抓到就提示你点播放
  qs('#tm_dl_this', panel).addEventListener('click', () => {
    scanPerformance();
    const mp4 = Array.from(mp4Set).find(u => u.includes('.mp4'));
    const meta = (qs('#courseName')?.textContent || '').trim();
    const fn = filenameFromMeta(meta || document.title || '课程录播');

    if (!mp4) {
      log('本页尚未抓到 mp4：请点一下播放或稍等 1-2 秒后再点。');
      return;
    }
    log('手动下载本页：', mp4);
    gmDownload(mp4, fn);
  });

  // 下载选定日期（队列）
  qs('#tm_dl_date', panel).addEventListener('click', () => {
    const rec = parseRecommendList();
    const d = qs('#tm_date', panel).value;
    const pick = rec.filter(x => x.date === d);
    if (!pick.length) { log('该日期无条目：', d); return; }
    enqueue(pick);
  });

  // 下载最新日期（队列）
  qs('#tm_dl_latest', panel).addEventListener('click', () => {
    const rec = parseRecommendList();
    const d = getLatestDate(rec);
    const pick = rec.filter(x => x.date === d);
    if (!pick.length) { log('列表里找不到最新日期条目'); return; }
    log('最新日期为：', d);
    enqueue(pick);
  });

})();
