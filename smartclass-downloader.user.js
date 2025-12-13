// ==UserScript==
  // @name         智慧课堂：批量抓MP4 + 自动命名下载（队列版）
  // @namespace    https://github.com/ZJHSteven/smartclass-downloader
  // @version      0.6.1
  // @description  通过API直接获取视频信息，秒级生成下载任务。支持队列批量下载，带降级方案。
  // @match        https://tmu.smartclass.cn/PlayPages/Video.aspx*
  // @run-at      document-start
  // @grant        GM_download
  // @grant        GM_openInTab
// ==/UserScript==

(function () {
  'use strict';

  /************* csrkToken 捕获与缓存（核心修复） *************
   *
   * 你遇到的典型报错：Success=false, Message="验证不通过"
   * 99% 都是 csrkToken 没拿到 / 拿错了 / 为空导致的。
   *
   * 旧逻辑的问题：只“猜”token 在 URL / cookie / window 变量里；
   * 但实际站点很可能：
   * - token 根本不在 URL
   * - token 放在 HttpOnly Cookie（JS 读不到）
   * - 或者 token 只在页面自己发的网络请求里出现
   *
   * 新逻辑（更稳）：
   * - 脚本尽早运行（metadata 里加 @run-at document-start）
   * - hook XHR / fetch 时，遇到 /Video/GetVideoInfoDtoByID 就把请求里的 csrkToken 抠出来
   * - 抠到后写入 localStorage，后续 API 直接复用，不再“猜”
   ***********************************************************/
  const CSRK_STORE_KEY = 'tm_csrkToken_v2'; // localStorage 的 key（改版本号避免污染旧值）
  let __tmCsrkToken = '';                  // 运行时内存缓存：优先读它，避免每次都碰 localStorage

  // 读取历史缓存（在某些隐私模式下 localStorage 可能会抛异常，所以要 try/catch）
  try {
    __tmCsrkToken = String(localStorage.getItem(CSRK_STORE_KEY) || '').trim();
  } catch (e) {
    __tmCsrkToken = '';
  }

  /**
   * 记住并持久化 token。
   * @param {string} tok - 从网络请求中抓到的 csrkToken
   */
  function rememberCsrkToken(tok) {
    if (!tok) return;                  // 空值直接忽略
    tok = String(tok).trim();          // 统一转字符串并去空白
    if (tok.length < 6) return;        // 太短一般是无效值（避免把空串/0/1 之类写进去）

    if (tok !== __tmCsrkToken) {       // 只在变化时写入，减少 localStorage 写频率
      __tmCsrkToken = tok;
      try { localStorage.setItem(CSRK_STORE_KEY, tok); } catch (e) {}
      console.log('[TM] 捕获 csrkToken =', tok);
    }
  }

  /**
   * 从请求 body 中尝试提取 csrkToken（做一个更鲁棒的兜底）。
   * 注意：大多数情况下 token 在 URL query 里即可，本函数属于“多做一步更稳”。
   * @param {any} body - XHR.send(body) 或 fetch(init.body)
   * @returns {string} 解析到的 token（解析不到返回空串）
   */
  function tryExtractCsrkTokenFromBody(body) {
    if (!body) return '';

    try {
      // 1) 常见：application/x-www-form-urlencoded（字符串）
      if (typeof body === 'string') {
        const s = body.trim();
        if (!s) return '';

        // 1.1) 也有可能是 JSON 字符串
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
          const obj = JSON.parse(s);
          return (obj && (obj.csrkToken || obj.CsrkToken)) ? String(obj.csrkToken || obj.CsrkToken) : '';
        }

        // 1.2) 按 URLSearchParams 解析（foo=bar&csrkToken=xxx）
        return new URLSearchParams(s).get('csrkToken') || '';
      }

      // 2) URLSearchParams
      if (body instanceof URLSearchParams) {
        return body.get('csrkToken') || '';
      }

      // 3) FormData
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const v = body.get('csrkToken');
        return v ? String(v) : '';
      }
    } catch (e) {}

    return '';
  }

  /**
   * 从“任意 URL”里尝试识别目标接口，并提取 csrkToken。
   * @param {string} urlStr - 请求 URL（可能是绝对/相对）
   * @param {any} [body] - 可选：请求 body，用来做兜底提取
   */
  function tryExtractTokenFromAnyUrl(urlStr, body) {
    try {
      const u = new URL(urlStr, location.origin); // 兼容相对路径
      if (u.pathname.toLowerCase() !== '/video/getvideoinfodtobyid') return;

      // 先从 query 里拿（最常见）
      rememberCsrkToken(u.searchParams.get('csrkToken'));

      // 如果 query 没有，再从 body 兜底（少数站点会 POST）
      if (!__tmCsrkToken) {
        rememberCsrkToken(tryExtractCsrkTokenFromBody(body));
      }
    } catch (e) {}
  }

  /******************* 工具 *******************/
  const qs = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));

  // HTML 转义：防止把页面里的 title 等内容直接塞 innerHTML 时触发“意外的 HTML 注入”
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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

  // 从 PlayFileUri 推导出 mp4 地址（带/不带 authKey 两个版本）
  function mp4FromPlayUri(playUri) {
    if (!playUri) return { withKey: '', noKey: '' };
    // content.html 替换为 VGA.mp4，保留 query 参数（timestamp/authKey）
    const withKey = playUri.replace(/content\.html(\?.*)?$/i, 'VGA.mp4$1');
    // 不带参数的纯净版本
    const noKey = withKey.split('?')[0];
    return { withKey, noKey };
  }

  // 从 API 返回的 Value 对象构建文件名
  function buildFilenameFromApi(v) {
    const teacher = (v.TeacherList && v.TeacherList[0] && v.TeacherList[0].Name) ? v.TeacherList[0].Name : '未知教师';
    const date = (v.StartTime || '').slice(0, 10);
    const st = (v.StartTime || '').slice(11, 16).replace(':', '-');
    const et = (v.StopTime || '').slice(11, 16).replace(':', '-');
    const courseName = v.CourseName || '课程';
    const classroom = v.ClassRoomName || '';
    return sanitizeFilename(`${date}_${courseName}_${teacher}_${classroom}_${st}-${et}.mp4`);
  }

  // 获取 csrkToken（从页面或cookie）
  function getCsrkToken() {
    // 0) 优先用我们“抓到并缓存”的 token（最可靠）
    if (__tmCsrkToken) return __tmCsrkToken;

    // 尝试从 URL 参数获取
    const fromUrl = getParam('csrkToken');
    if (fromUrl) return fromUrl;
    
    // 尝试从 cookie 获取
    const match = document.cookie.match(/csrkToken=([^;]+)/);
    if (match) return match[1];
    
    // 尝试从页面脚本中查找（有些站点会写在全局变量）
    if (window.csrkToken) return window.csrkToken;

    // 再兜底：从 localStorage 读（避免“刷新后内存缓存丢了”）
    try {
      const fromStore = String(localStorage.getItem(CSRK_STORE_KEY) || '').trim();
      if (fromStore) {
        __tmCsrkToken = fromStore;
        return fromStore;
      }
    } catch (e) {}
    
    // 默认返回空（某些情况下不需要token也能访问）
    return '';
  }

  // 调用 API 获取视频信息
  async function getVideoInfoByNewId(newId) {
    const csrkToken = getCsrkToken();
    const url = new URL('/Video/GetVideoInfoDtoByID', location.origin);
    url.searchParams.set('csrkToken', csrkToken);
    url.searchParams.set('NewId', newId);
    url.searchParams.set('isGetLink', 'true');
    url.searchParams.set('VideoPwd', '');
    url.searchParams.set('Answer', '');
    url.searchParams.set('isloadstudent', 'true');

    try {
      const resp = await fetch(url.toString(), { credentials: 'include' });
      const json = await resp.json();
      if (!json?.Success) {
        throw new Error(json?.Message || 'API返回失败');
      }
      return json.Value;
    } catch (err) {
      log('[API错误]', newId, err.message);
      throw err;
    }
  }

  /******************* UI + 日志 *******************/
  // 统一把 UI 样式抽出来：
  // - 避免一坨 inline style 难维护
  // - 颜色/对比度统一调，解决“灰字+灰底看不清”的问题
  const tmStyle = document.createElement('style');
  tmStyle.id = 'tm_style';
  tmStyle.textContent = `
    #tm_panel {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 999999;

      width: min(540px, calc(100vw - 24px));
      max-height: min(72vh, 820px);

      display: flex;
      flex-direction: column;

      background: rgba(18, 22, 34, 0.92);
      color: #f6f7ff;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(10px);

      font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    #tm_panel * { box-sizing: border-box; }

    #tm_panel .tm-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 12px 12px 8px 12px;
    }
    #tm_panel .tm-title {
      font-size: 13px;
      font-weight: 900;
      letter-spacing: 0.2px;
      color: #ffffff;
    }
    #tm_panel .tm-actions { display: flex; gap: 8px; }

    #tm_panel .tm-body {
      padding: 0 12px 12px 12px;
      overflow: auto;
    }

    #tm_panel .tm-info {
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: rgba(255, 255, 255, 0.92);
      margin-bottom: 10px;
    }

    #tm_panel .tm-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    #tm_panel .tm-label {
      color: rgba(255, 255, 255, 0.92);
      font-weight: 800;
    }

    #tm_panel .tm-select {
      flex: 1;
      min-width: 140px;
      padding: 7px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(0, 0, 0, 0.18);
      color: #ffffff;
      outline: none;
    }
    #tm_panel .tm-select:focus {
      border-color: rgba(79, 140, 255, 0.70);
      box-shadow: 0 0 0 3px rgba(79, 140, 255, 0.18);
    }

    #tm_panel .tm-btn {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      padding: 7px 10px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 800;
      user-select: none;
      transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
    }
    #tm_panel .tm-btn:hover { background: rgba(255, 255, 255, 0.12); }
    #tm_panel .tm-btn:active { transform: translateY(1px); }
    #tm_panel .tm-btn.primary {
      background: linear-gradient(135deg, rgba(79, 140, 255, 0.95), rgba(122, 92, 255, 0.95));
      border-color: rgba(255, 255, 255, 0.22);
    }
    #tm_panel .tm-btn.ghost { background: transparent; }

    #tm_panel .tm-help {
      padding: 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.18);
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: #ffffff; /* 关键：提示框文字用纯白，避免灰字看不清 */
      margin-bottom: 10px;
    }
    #tm_panel .tm-help-title { font-weight: 900; margin-bottom: 6px; color: #ffffff; }
    #tm_panel .tm-help ul { margin: 0; padding-left: 18px; }
    #tm_panel .tm-help li { margin: 4px 0; color: #ffffff; }
    #tm_panel code { color: #d7e6ff; background: rgba(255, 255, 255, 0.08); padding: 1px 6px; border-radius: 8px; }

    #tm_panel details.tm-details summary {
      cursor: pointer;
      font-weight: 900;
      color: rgba(255, 255, 255, 0.94);
      margin-bottom: 8px;
      user-select: none;
      list-style: none;
    }
    #tm_panel details.tm-details summary::-webkit-details-marker { display: none; }
    #tm_panel .tm-log {
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(0, 0, 0, 0.24);
      padding: 10px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: rgba(245, 248, 255, 0.96);
      margin: 0;
    }

    #tm_panel #tm_extra { margin: 10px 0; }

    #tm_panel #tm_dl_box {
      padding: 10px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
    }
    #tm_panel .tm-dl-title { font-weight: 900; margin-bottom: 8px; }
    #tm_panel .tm-dl-item {
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 12px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.12);
    }
    #tm_panel .tm-dl-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    #tm_panel .tm-dl-name { color: #ffffff; opacity: 1; word-break: break-all; } /* 关键：下载状态标题用纯白 */
    #tm_panel .tm-dl-status { font-weight: 900; white-space: nowrap; }
    #tm_panel .tm-dl-status--done { color: #6dff7a; }
    #tm_panel .tm-dl-status--error { color: #ff6b6b; }
    #tm_panel .tm-dl-status--downloading { color: #8ab4ff; }
    #tm_panel .tm-bar {
      height: 8px;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      overflow: hidden;
      margin: 6px 0 8px 0;
    }
    #tm_panel .tm-bar > div { height: 100%; }
    #tm_panel .tm-dl-detail { color: #ffffff; opacity: 1; } /* 关键：进度/速度详情用纯白 */

    #tm_panel .tm-list { display: flex; flex-direction: column; gap: 10px; }
    #tm_panel .tm-item {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.06);
    }
    #tm_panel .tm-item-meta { font-weight: 900; color: #ffffff; margin-bottom: 6px; }
    #tm_panel .tm-item-sub { color: rgba(255, 255, 255, 0.90); margin-top: 4px; }
    #tm_panel .tm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    #tm_panel .tm-empty { color: rgba(255, 255, 255, 0.88); padding: 10px; }
  `;
  document.documentElement.appendChild(tmStyle);

  const panel = document.createElement('div');
  panel.id = 'tm_panel';
  panel.innerHTML = `
    <div class="tm-header">
      <div class="tm-title">智慧课堂下载助手（API加速版）</div>
      <div class="tm-actions">
        <button id="tm_toggle" class="tm-btn ghost" type="button" title="折叠/展开面板">折叠</button>
        <button id="tm_clear" class="tm-btn" type="button" title="清空日志">清空日志</button>
      </div>
    </div>

    <div id="tm_body" class="tm-body">
      <div id="tm_info" class="tm-info"></div>

      <div class="tm-row">
        <span class="tm-label">选择日期</span>
        <select id="tm_date" class="tm-select"></select>
        <button id="tm_dl_date" class="tm-btn primary" type="button">下载该日期（队列）</button>
        <button id="tm_dl_latest" class="tm-btn" type="button">下载最新日期（队列）</button>
        <button id="tm_dl_this" class="tm-btn" type="button">下载本页</button>
      </div>

      <div class="tm-help">
        <div class="tm-help-title">使用提示</div>
        <ul>
          <li>脚本会从页面网络请求里捕获并缓存 <code>csrkToken</code>，解决“验证不通过”。</li>
          <li>若“本页下载”提示没抓到 MP4，请先点一下播放触发取源请求。</li>
        </ul>
      </div>

      <details class="tm-details" style="margin-bottom:10px;">
        <summary>日志（点开看细节）</summary>
        <pre id="tm_log" class="tm-log"></pre>
      </details>

      <div id="tm_extra"></div>
      <div id="tm_list" class="tm-list"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);
  window.__tm_panel = panel; // 保存面板引用供其他功能使用

  const logEl = qs('#tm_log', panel);
  function log(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.log('[TM]', msg);
    logEl.textContent += `[TM] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
  qs('#tm_clear', panel).addEventListener('click', () => logEl.textContent = '');

  // 面板折叠/展开：给屏幕留空间（把状态存到 localStorage，刷新后还能记住）
  (function initPanelCollapse(){
    const KEY = 'tm_ui_collapsed_v1';
    const btn = qs('#tm_toggle', panel);
    const body = qs('#tm_body', panel);

    function setCollapsed(collapsed) {
      body.style.display = collapsed ? 'none' : '';
      btn.textContent = collapsed ? '展开' : '折叠';
      try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) {}
    }

    let collapsed = false;
    try { collapsed = localStorage.getItem(KEY) === '1'; } catch (e) {}
    setCollapsed(collapsed);

    btn.addEventListener('click', () => setCollapsed(body.style.display !== 'none'));
  })();

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
      // 关键：尽早从“页面真实请求”里抠出 csrkToken（不再猜 token 在哪）
      tryExtractTokenFromAnyUrl(this.__tm_url);
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      // 再兜底一次：如果 token 放在 POST body（少见），这里也能抓到
      tryExtractTokenFromAnyUrl(this.__tm_url || '', body);
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
      // 关键：fetch 也要抓一次（页面可能用 fetch 调用 GetVideoInfo）
      tryExtractTokenFromAnyUrl(url, init && init.body);
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

  // 通过 API 直接下载（不再打开后台页）
  async function downloadByApi(item) {
    try {
      log('[API] 获取视频信息：', item.newId);
      const v = await getVideoInfoByNewId(item.newId);
      
      const segments = v.VideoSegmentInfo || [];
      if (!segments.length) {
        log('[API] 无视频片段：', item.newId);
        return;
      }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const { withKey, noKey } = mp4FromPlayUri(seg.PlayFileUri);
        
        if (!withKey) {
          log('[API] 无法解析 mp4 地址：', seg.PlayFileUri);
          continue;
        }

        let fn = buildFilenameFromApi(v);
        if (segments.length > 1) {
          fn = fn.replace('.mp4', `_seg${i + 1}.mp4`);
        }

        log('[API] 开始下载：', fn);
        gmDownloadWithFallback(withKey, noKey, fn);
      }
    } catch (err) {
      log('[API失败] 降级为后台页模式：', item.newId, err.message);
      openBackupTab(item);
    }
  }

  // 备用方案：打开后台页（当API失败时使用）
  function openBackupTab(item) {
    const u = new URL(item.url);
    u.searchParams.set('tm_autodl', '1');
    u.searchParams.set('tm_fn', item.filename);
    u.searchParams.set('tm_newid', item.newId);
    log('[备用] 打开后台页：', u.toString());
    GM_openInTab(u.toString(), { active: false, insert: true, setParent: true });
  }

  // 队列处理器（支持并发）
  let lastQueueSize = -1;
  async function processQueue(concurrency = 3) {
    const inflightKey = 'tm_inflight';
    const inflight = Number(localStorage.getItem(inflightKey) || '0');
    const q = loadQueue();
    
    if (q.length !== lastQueueSize) {
      if (q.length === 0) {
        if (lastQueueSize > 0) log('[队列] 全部完成');
      } else {
        log(`[队列] 剩余 ${q.length} 个任务`);
      }
      lastQueueSize = q.length;
    }

    if (q.length === 0) return;
    if (inflight >= concurrency) return;

    const next = q.shift();
    saveQueue(q);
    lastQueueSize = q.length;

    localStorage.setItem(inflightKey, String(inflight + 1));

    try {
      await downloadByApi(next);
    } finally {
      const current = Math.max(0, Number(localStorage.getItem(inflightKey) || '1') - 1);
      localStorage.setItem(inflightKey, String(current));
    }
  }

  setInterval(() => processQueue(3), 1000);

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

  // 旧的队列调度器已禁用，openNextFromQueue函数仅作为API失败时的降级备用

  /******************* 自动下载模式（后台页自己下载自己） *******************/
function bytesHuman(n) {
  if (typeof n !== 'number' || n < 0) return '未知';
  const units = ['B','KB','MB','GB'];
  let i = 0, x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)}${units[i]}`;
}

function ensureDlBox() {
  // 把进度展示塞进面板里：优先插到 tm_extra，避免打断主列表阅读
  const host = qs('#tm_extra', panel) || window.__tm_panel || document.body;
  let box = host.querySelector('#tm_dl_box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tm_dl_box';
    box.innerHTML = `
      <div class="tm-dl-title">下载状态</div>
      <div id="tm_dl_rows" style="display:flex; flex-direction:column; gap:10px;"></div>
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
      <div class="tm-dl-item">
        <div class="tm-dl-top">
          <div class="tm-dl-name">${escapeHtml(s.filename)}</div>
          <div class="tm-dl-status tm-dl-status--${escapeHtml(s.status)}">${escapeHtml(s.status)}</div>
        </div>
        <div class="tm-bar">
          <div style="width:${barW}%; background:${color};"></div>
        </div>
        <div class="tm-dl-detail">${escapeHtml(detail)}</div>
      </div>
    `;
  }).join('');
}

// 带降级重试的下载函数（先试带参数，失败后试无参数）
function gmDownloadWithFallback(urlWithKey, urlNoKey, filename) {
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
  log('开始下载(带参数)：', filename);

  GM_download({
    url: urlWithKey,
    name: filename,
    saveAs: false,
    timeout: 60000,

    onprogress: (e) => {
      const st = __tmDlState.get(filename);
      if (!st) return;

      const t = Date.now();
      const loaded = (typeof e.loaded === 'number') ? e.loaded : st.loaded;
      const total  = (typeof e.total === 'number') ? e.total : st.total;

      const dt = Math.max(1, t - st.lastT);
      const dL = Math.max(0, loaded - st.lastLoaded);
      const speed = Math.floor((dL * 1000) / dt);

      st.loaded = loaded;
      st.total = total;
      st.speed = speed;
      st.lastT = t;
      st.lastLoaded = loaded;

      __tmDlState.set(filename, st);

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
      log('[降级] 带参数版本失败，尝试无参数版本：', filename);
      // 降级到无参数版本
      gmDownload(urlNoKey, filename);
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

// 原有的 gmDownload 函数（现在作为降级方案）
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

    log('自动下载模式启动，目标文件名：', wantedName);

    // 等待 mp4 出现（最多 25 秒）
    const start = Date.now();
    while (Date.now() - start < 25000) {
      scanPerformance();

      const mp4 = Array.from(mp4Set).find(u => u.includes('tmuvod.smartclass.cn') || u.includes('.mp4'));
      if (mp4) {
        log('准备下载：', mp4);
        gmDownload(mp4, wantedName);

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
    info.textContent = `本页 NewID=${getParam('NewID') || '(无)'} ｜ 推荐条目数=${rec.length} ｜ 已捕获MP4数=${mp4Set.size} ｜ 已捕获csrkToken=${__tmCsrkToken ? '是' : '否'}`;

    // 日期下拉
    const dates = uniq(rec.map(x => x.date)).sort();
    const sel = qs('#tm_date', panel);
    sel.innerHTML = dates.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if (dates.length) sel.value = getLatestDate(rec);

    // 列表展示
    const list = qs('#tm_list', panel);
    if (!rec.length) {
      list.innerHTML = `<div class="tm-empty">未检测到相关推荐列表（ul.about_video）。</div>`;
      return;
    }
    list.innerHTML = rec.map(it => `
      <div class="tm-item">
        <div class="tm-item-meta">${escapeHtml(it.meta)}</div>
        <div class="tm-item-sub">NewID：<span class="tm-mono">${escapeHtml(it.newId)}</span></div>
        <div class="tm-item-sub">文件名：<span class="tm-mono">${escapeHtml(it.filename)}</span></div>
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
