// ==UserScript==
  // @name         智慧课堂：批量抓MP4 + 自动命名下载（队列版）
  // @namespace    https://github.com/ZJHSteven/smartclass-downloader
  // @version      0.6.3
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

  /******************* 文件命名（新规则 v2） *******************/
  /**
   * 【为什么要在这里集中处理命名？】
   * - 命名规则经常改：集中在一处，后续只改这里就够了（不容易漏）。
   * - 命名要尽量“短、好读、可排序”：你后面在资源管理器里一眼就能扫出来。
   *
   * 【你要求的新格式（示例）】
   * - 旧：2025-12-12_人体功能学_张玲_第二教室_08-00-08-45.mp4（太长）
   * - 新：12.12-生理-王栋-8-9.mp4
   *
   * 规则拆开讲：
   * 1) 日期：只保留“月.日”，去掉年份；不要横杠，用点（12.9 / 11.29）
   * 2) 课程：如果在对应表里有简写，就替换成简写；没有就保留原名
   * 3) 老师：只保留老师名，不写教室/地点
   * 4) 时间：只保留“小时”，不写分钟；用 “开始小时-结束小时”
   */

  /**
   * 课程名 -> 简写 对应表
   * - key：站点原始课程名（或常见写法）
   * - value：你希望显示的简写
   */
  const COURSE_NAME_ALIAS = {
    '人体功能学': '生理',
    '病原与免疫': '病原',
    '马克思主义基本原理': '马原',
    '医学基础II': '生化',
    '医学基础Ⅱ': '生化',
    '医学术语学2': '英语',
    '医学术语学Ⅱ': '英语'
  };

  /**
   * 把“课程全名”转换成“简写”（如果表里有）
   * @param {string} courseNameFull 课程全名（来自页面 title 或 API）
   * @returns {string} 如果命中映射表则返回简写，否则返回原字符串（trim 后）
   */
  function abbreviateCourseName(courseNameFull) {
    const raw = String(courseNameFull ?? '').trim(); // 统一成字符串，并去掉首尾空白
    return COURSE_NAME_ALIAS[raw] || raw; // 命中映射表 -> 简写；否则保留原名
  }

  /**
   * 把 YYYY-MM-DD 格式日期变成 “M.D”（去掉年份、去掉前导 0）
   * @param {string} ymd 例如：2025-12-09
   * @returns {string} 例如：12.9；解析失败时返回空串
   */
  function formatDateToMD(ymd) {
    const m = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); // 严格匹配年月日
    if (!m) return ''; // 解析失败：交给调用者决定怎么兜底
    const month = String(Number(m[2])); // Number(...) 会自动去掉前导 0（'09' -> 9）
    const day = String(Number(m[3])); // 同上（'10' -> 10）
    return `${month}.${day}`; // 按你的要求：用点，不要横杠
  }

  /**
   * 从 “HH:mm” 中提取小时，返回不带前导 0 的字符串
   * @param {string} hhmm 例如：08:45
   * @returns {string} 例如：8；解析失败时返回空串
   */
  function extractHour(hhmm) {
    const m = String(hhmm ?? '').match(/^(\d{2}):(\d{2})$/); // 只关心小时，分钟用来校验格式
    if (!m) return ''; // 解析失败：交给调用者兜底
    return String(Number(m[1])); // 去前导 0（'08' -> 8）
  }

  /**
   * 拼出最终 mp4 文件名（统一出口）
   * @param {object} x 输入信息（允许部分缺失，缺失会做兜底）
   * @param {string} x.dateYmd YYYY-MM-DD
   * @param {string} x.courseName 课程名（会走简写表）
   * @param {string} x.teacherName 教师名
   * @param {string} x.startHHmm 开始时间 HH:mm
   * @param {string} x.endHHmm 结束时间 HH:mm
   * @returns {string} 文件名（已 sanitize，带 .mp4）
   */
  function buildMp4FilenameV2({ dateYmd, courseName, teacherName, startHHmm, endHHmm }) {
    const dateMd = formatDateToMD(dateYmd) || '未知日期'; // 日期尽量短；缺失时给一个可识别占位
    const courseShort = abbreviateCourseName(courseName) || '课程'; // 课程名为空时兜底
    const teacher = String(teacherName ?? '').trim() || '未知教师'; // 老师名为空时兜底
    const startHour = extractHour(startHHmm) || '0'; // 小时提取失败时兜底（避免空字段导致连字符不好看）
    const endHour = extractHour(endHHmm) || '0'; // 同上
    return sanitizeFilename(`${dateMd}-${courseShort}-${teacher}-${startHour}-${endHour}.mp4`); // 统一用连字符分隔
  }

  // 从 title="人体功能学 张玲 第二教室 2025-12-12 08:00:00-08:45:00"
  // 生成文件名（新规则）：12.12-生理-张玲-8-8.mp4
  function filenameFromMeta(meta) {
    const raw = (meta || '').trim();
    const m = raw.match(/^(.*)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}):\d{2}-(\d{2}:\d{2}):\d{2}$/);
    if (!m) return sanitizeFilename(raw || '课程录播') + '.mp4'; // 不符合预期格式：直接把原文本当文件名兜底

    const prefixRaw = m[1].trim(); // “课程 老师 教室” 这段（不同学校可能略有差异）
    const parts = prefixRaw.split(/\s+/g).filter(Boolean); // 按空白切分：连续空格也算一个分隔

    // 经验规则：常见的 title 是 “课程名 老师名 教室名”
    // - 课程名通常在第 1 段
    // - 老师名通常在第 2 段
    // - 教室名在第 3 段（我们按你的要求不写）
    const courseName = parts[0] || prefixRaw || '课程'; // 如果切分失败，就用整段 prefixRaw
    const teacherName = parts[1] || '未知教师'; // 老师拿不到就兜底

    const dateYmd = m[2]; // YYYY-MM-DD
    const startHHmm = m[3]; // HH:mm
    const endHHmm = m[4]; // HH:mm

    return buildMp4FilenameV2({ // 统一走 v2 规则
      dateYmd,
      courseName,
      teacherName,
      startHHmm,
      endHHmm
    });
  }

  /**
   * 从 meta 文本里解析“日期”（用于：日期下拉筛选 / 最新日期判断）
   *
   * 【为什么要写得更鲁棒？】
   * - 你反馈“最新日期明明是 12/13，却默认选了 12/11”：
   *   常见原因是：有的条目日期格式不是 `YYYY-MM-DD`（可能是 `YYYY/MM/DD`、`YYYY.MM.DD`、甚至 `YYYY年MM月DD日`），
   *   原来的正则只认 `YYYY-MM-DD`，导致那天的条目 date 解析失败，直接被当成“没有日期”，自然就进不了下拉/最新日期判断。
   *
   * @param {string} meta 例如：人体功能学 张玲 第二教室 2025-12-12 08:00:00-08:45:00
   * @returns {string} 统一返回 `YYYY-MM-DD`；解析失败则返回空串
   */
  function parseDate(meta) {
    const s = String(meta ?? ''); // 统一成字符串，避免 null/undefined 报错

    // 小工具：把 1 位月份/日期补成 2 位（8 -> 08）
    const pad2 = (n) => String(n).padStart(2, '0');

    // 1) 常见格式：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD（分隔符可能不同）
    let m = s.match(/(\d{4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})/);
    if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`; // 统一成 ISO 方便排序

    // 2) 中文格式：YYYY年MM月DD日
    m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`; // 同样统一

    return ''; // 解析不了：就返回空，调用方再决定怎么处理
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
    // 1) 老师：只取第一个老师（多数课程只有一个老师；多个老师也避免文件名过长）
    const teacher = (v.TeacherList && v.TeacherList[0] && v.TeacherList[0].Name) ? v.TeacherList[0].Name : '未知教师';

    // 2) 日期：只要 YYYY-MM-DD，再转成 “M.D”
    const dateYmd = (v.StartTime || '').slice(0, 10);

    // 3) 时间：只要 HH:mm（分钟仅用于解析；最终文件名只保留小时）
    const startHHmm = (v.StartTime || '').slice(11, 16);
    const endHHmm = (v.StopTime || '').slice(11, 16);

    // 4) 课程：先拿原始名，再走简写表
    const courseName = v.CourseName || '课程';

    // 5) 按你要求的新规则拼出文件名（不带教室信息）
    return buildMp4FilenameV2({
      dateYmd,
      courseName,
      teacherName: teacher,
      startHHmm,
      endHHmm
    });
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

  /**
   * 等待 csrkToken 被“页面真实请求”捕获到。
   *
   * 场景：你如果一上来就点“批量下载”，但页面还没触发过任何带 token 的接口请求，
   *       我们脚本就拿不到 token，API 会报“验证不通过”。
   * 解决：这里做一个“短暂等待”（不会无限等），尽量等到 token 出现再发 API。
   *
   * @param {number} maxMs 最大等待毫秒数
   * @returns {Promise<string>} 等到则返回 token，否则返回空串
   */
  async function waitForCsrkToken(maxMs) {
    const start = Date.now(); // 记录起点时间
    while (Date.now() - start < maxMs) { // 轮询直到超时
      const t = getCsrkToken(); // 每次都走统一入口（内存/URL/cookie/localStorage）
      if (t) return t; // 一旦有 token 立刻返回
      await new Promise(r => setTimeout(r, 120)); // 小睡一会，避免死循环占用 CPU
    }
    return ''; // 超时：返回空串
  }

  // 调用 API 获取视频信息
  async function getVideoInfoByNewId(newId) {
    /**
     * 内部小函数：真正发一次请求（为了下面“失败后重试”逻辑更清晰）
     * @param {string} csrkToken 本次要用的 token（可能为空）
     */
    async function fetchOnce(csrkToken) {
      const url = new URL('/Video/GetVideoInfoDtoByID', location.origin); // 构造接口 URL
      url.searchParams.set('csrkToken', csrkToken); // token（为空也会带上，但通常会失败）
      url.searchParams.set('NewId', newId); // 课程 NewId
      url.searchParams.set('isGetLink', 'true'); // 站点常用参数：要求返回播放链接
      url.searchParams.set('VideoPwd', ''); // 没有密码则空
      url.searchParams.set('Answer', ''); // 没有答题则空
      url.searchParams.set('isloadstudent', 'true'); // 站点常用参数

      const resp = await fetch(url.toString(), { credentials: 'include' }); // 带 cookie
      const json = await resp.json(); // 解析 JSON
      if (!json?.Success) {
        const msg = String(json?.Message || 'API返回失败'); // 把 Message 统一成字符串
        const e = new Error(msg); // 用 Error 承载消息
        e.__tm_apiMessage = msg; // 附加字段：方便上层判断是不是 token 问题
        throw e; // 抛出，让上层处理（重试/降级）
      }
      return json.Value; // 成功：直接返回 Value
    }

    try {
      // 1) 先拿一次 token（如果为空，短暂等一下）
      let csrkToken = getCsrkToken();
      if (!csrkToken) csrkToken = await waitForCsrkToken(2500); // 2.5 秒内有 token 就更稳

      // 2) 第一次请求
      return await fetchOnce(csrkToken);
    } catch (err) {
      // 3) 常见失败：验证不通过（token 没抓到 / token 过期）
      const msg = String(err?.__tm_apiMessage || err?.message || '');
      if (msg.includes('验证不通过') || msg.toLowerCase().includes('token')) {
        // 再等一会 token（有时候页面稍后才发带 token 的请求）
        const csrkToken2 = await waitForCsrkToken(6000);
        if (csrkToken2) {
          try {
            log('[API] 发现 token，重试一次：', newId);
            return await fetchOnce(csrkToken2);
          } catch (e2) {
            log('[API错误-重试仍失败]', newId, e2.message);
            throw e2;
          }
        }
      }

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
    // 只保留“能解析出来的日期”，避免 '' 这种空值干扰“最新日期”判断
    const dates = uniq(items.map(x => x.date).filter(Boolean)).sort();
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
        return { handoffToTab: false };
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
          // 多片段视频：在结尾追加 -segN，保证同一节课的多个片段不会互相覆盖
          fn = fn.replace(/\.mp4$/i, `-seg${i + 1}.mp4`);
        }

        log('[API] 开始下载：', fn);
        // 关键修复：必须 await，确保“并发控制/队列计数”是真正按下载完成来走的。
        // 否则会出现：看起来“只下了两节课”，实际是第三节被浏览器/网络节流排队了，过几分钟才开始。
        await gmDownloadWithFallback(withKey, noKey, fn);
      }

      return { handoffToTab: false };
    } catch (err) {
      log('[API失败] 降级为后台页模式：', item.newId, err.message);
      openBackupTab(item);
      // 重要：这类任务已经“交给后台页去做”了，队列处理器不要在本页提前 -inflight。
      // 否则会导致 inflight 计数失真 → 并发失控 → 更容易被站点节流 → “下载不全/过几分钟才继续”。
      return { handoffToTab: true };
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

    // 默认：本页负责把 inflight -1（即：下载在本页完成）
    // 但如果 API 失败改走“后台页下载”，就由后台页在完成/超时后 -1。
    let shouldDecrementInThisTab = true;
    try {
      const r = await downloadByApi(next);
      if (r && r.handoffToTab) shouldDecrementInThisTab = false;
    } finally {
      if (shouldDecrementInThisTab) {
        const current = Math.max(0, Number(localStorage.getItem(inflightKey) || '1') - 1);
        localStorage.setItem(inflightKey, String(current));
      }
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

/**
 * 把 GM_download 包装成 Promise（关键修复：让“队列并发控制”真正按下载完成来计算）
 *
 * 你反馈的现象：
 * - “同一天 3 节课只下了 2 节，中间莫名少一节”
 * - “过 5 分钟又开始下”
 *
 * 常见根因就是：以前代码只是“发起下载”，并没有等下载真正结束就把队列并发放开了，导致：
 * - 浏览器/站点节流把部分下载排队（你感觉像是“漏了”）
 * - 过一段时间节流解除/队列空出来，又继续（你感觉像“过几分钟又开始了”）
 *
 * 这里我们统一把一次下载抽象成：Promise< {ok:boolean, err?:string} >
 * 上层可以 await 它，队列就不会“提前放行”。
 */
function __tmStartGmDownload(url, filename) {
  return new Promise((resolve) => {
    try {
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

        onload: () => resolve({ ok: true }),

        onerror: (err) => {
          const msg = (err && (err.error || err.message)) ? String(err.error || err.message) : '下载失败';
          resolve({ ok: false, err: msg });
        },

        ontimeout: () => resolve({ ok: false, err: '下载超时（网络不稳定/被节流）' }),
      });
    } catch (e) {
      resolve({ ok: false, err: String(e?.message || e || 'GM_download异常') });
    }
  });
}

// 单次下载（不带降级）：返回 Promise，方便上层 await
async function gmDownload(url, filename) {
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

  const r = await __tmStartGmDownload(url, filename);

  const st = __tmDlState.get(filename);
  if (st) {
    if (r.ok) {
      st.status = 'done';
      st.speed = 0;
      st.err = '';
    } else {
      st.status = 'error';
      st.err = r.err || '下载失败';
    }
    __tmDlState.set(filename, st);
  }
  renderDlState();

  if (r.ok) log('下载完成：', filename);
  else log('下载失败：', filename, r.err || '');

  return r;
}

// 带降级重试的下载函数（先试带参数，失败后试无参数）：返回 Promise，方便上层 await
async function gmDownloadWithFallback(urlWithKey, urlNoKey, filename) {
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

  const r1 = await __tmStartGmDownload(urlWithKey, filename);
  if (r1.ok) {
    const st = __tmDlState.get(filename);
    if (st) {
      st.status = 'done';
      st.speed = 0;
      st.err = '';
      __tmDlState.set(filename, st);
    }
    renderDlState();
    log('下载完成：', filename);
    return r1;
  }

  // 第一次失败：尝试无参数版本
  log('[降级] 带参数版本失败，尝试无参数版本：', filename, r1.err || '');

  if (!urlNoKey) {
    const st = __tmDlState.get(filename);
    if (st) {
      st.status = 'error';
      st.err = r1.err || '带参数失败，且无无参数版本可用';
      __tmDlState.set(filename, st);
    }
    renderDlState();
    return { ok: false, err: r1.err || '下载失败' };
  }

  // 为第二次尝试重置一下计数（让 UI 看起来更直观）
  const st2 = __tmDlState.get(filename);
  if (st2) {
    const t = Date.now();
    st2.status = 'downloading';
    st2.loaded = 0;
    st2.total = -1;
    st2.speed = 0;
    st2.t0 = t;
    st2.lastT = t;
    st2.lastLoaded = 0;
    st2.err = `降级中：${r1.err || '带参数失败'}`;
    __tmDlState.set(filename, st2);
  }
  renderDlState();

  const r2 = await __tmStartGmDownload(urlNoKey, filename);

  const st = __tmDlState.get(filename);
  if (st) {
    if (r2.ok) {
      st.status = 'done';
      st.speed = 0;
      st.err = '';
    } else {
      st.status = 'error';
      st.err = r2.err || '下载失败';
    }
    __tmDlState.set(filename, st);
  }
  renderDlState();

  if (r2.ok) log('下载完成：', filename);
  else log('下载失败：', filename, r2.err || '');

  return r2;
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
        // 关键修复：必须等下载真正结束（成功/失败/超时）再释放 inflight，避免并发计数失真
        const r = await gmDownload(mp4, wantedName);

        // inflight -1
        const inflightKey = 'tm_inflight';
        const inflight = Math.max(0, Number(localStorage.getItem(inflightKey) || '1') - 1);
        localStorage.setItem(inflightKey, String(inflight));

        // 成功才自动关闭：失败时保留页面，方便你手动点播放/重试排查
        if (r && r.ok) {
          // 尝试自动关闭标签页（只对脚本打开的页通常有效；不行也无所谓）
          setTimeout(() => { try { window.close(); } catch(e) {} }, 3000);
        } else {
          log('[自动下载] 本次下载失败，未自动关闭标签页：', wantedName);
        }
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
  // 记住上一次“日期下拉”的选项集合：
  // - 目的1：避免 updateUI 每 5 秒重建一次下拉，导致你手动选的日期被“悄悄改回最新日期”
  // - 目的2：减少 DOM 抖动（下拉闪一下、点选体验差）
  let __tmLastDatesKey = '';

  function updateUI() {
    const rec = parseRecommendList();

    const info = qs('#tm_info', panel);
    info.textContent = `本页 NewID=${getParam('NewID') || '(无)'} ｜ 推荐条目数=${rec.length} ｜ 已捕获MP4数=${mp4Set.size} ｜ 已捕获csrkToken=${__tmCsrkToken ? '是' : '否'}`;

    // 日期下拉
    // 下拉里只展示“有效日期”，避免出现空白选项误导你
    const dates = uniq(rec.map(x => x.date).filter(Boolean)).sort();
    const sel = qs('#tm_date', panel);
    const prevValue = sel.value; // 记录“你当前手动选的是哪天”（修复：不会被定时刷新覆盖）
    const datesKey = dates.join('|'); // 用 join 出一个简单 hash（足够用了）

    // 只有日期集合变化时才重建 options（避免每次都把你选中的值冲掉）
    if (datesKey !== __tmLastDatesKey) {
      sel.innerHTML = dates.length
        ? dates.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')
        : `<option value="">(无日期)</option>`;
      __tmLastDatesKey = datesKey;
    }

    // 选中逻辑（优先级）：
    // 1) 如果你之前选的日期还存在，就继续选它
    // 2) 否则（比如列表变化了），自动选最新日期
    if (dates.length) {
      const keep = (prevValue && dates.includes(prevValue)) ? prevValue : '';
      sel.value = keep || getLatestDate(rec);
    }

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
