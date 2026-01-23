// ==UserScript==
// @name         智慧课堂：批量抓MP4 + Gopeed外部下载（队列版）
  // @namespace    https://github.com/ZJHSteven/smartclass-downloader
// @version      0.7.5
// @description  通过API获取视频信息，批量提交到Gopeed外部下载器（不走浏览器下载）。
  // @match        https://tmu.smartclass.cn/PlayPages/Video.aspx*
// @run-at      document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
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

  /******************* Gopeed 外部下载器配置（替代 GM_download） *******************/
  /**
   * 你给的 curl 示例使用了：
   * - API 基址：http://127.0.0.1:9999
   * - token 头：x-api-token: Mm520520
   *
   * 注意：Gopeed 文档里同时出现过 /request、/api/tasks/batch、/api/server/info 等不同路径，
   * 你的 Gopeed 版本如果是 /api/v1/*，可以直接改下面的路径。
   * 这里把“路径”做成可配置，避免每次改逻辑。
   */
  const GOPEED_CONFIG = {
    baseUrl: 'http://127.0.0.1:9999',      // Gopeed API 基址（建议 127.0.0.1，避免 localhost 解析问题）
    apiToken: 'Mm520520',                  // Gopeed API Token（你设置的令牌）
    tokenHeader: 'x-api-token',            // Token 头名称（你给的示例是 x-api-token）
    createMode: 'tasks',                   // 创建任务模式：tasks | batch | request
    tasksPath: '/api/v1/tasks',            // 单任务创建路径（若你的 Gopeed 用 /api，可改成 /api/tasks）
    batchPath: '/api/v1/tasks/batch',      // 批量创建路径（若你的 Gopeed 用 /api，可改成 /api/tasks/batch）
    requestPath: '/api/v1/request',        // 简版请求路径（若你的 Gopeed 用 /request，可改成 /request）
    timeoutMs: 15000,                      // API 超时（毫秒）
    defaultSavePath: '',                   // 默认保存目录（空串表示用 Gopeed 默认目录）
    includeRefererHeader: true,            // 是否附带 Referer（部分站点需要）
    includeCookieHeader: false             // 是否附带 Cookie（如需鉴权可改 true）
  };

  /**
   * UI 行为配置（默认值偏保守，避免自动展开打扰）
   */
  const UI_CONFIG = {
    autoOpenLatest: false,                 // 是否自动展开“最新日期”（默认否）
    refreshMs: 5000,                       // UI 刷新间隔（毫秒）
    miniLogLines: 2                        // 迷你日志默认展示行数
  };

  /**
   * 统一拼接 baseUrl + path，避免出现双斜杠或漏斜杠。
   * @param {string} base 基址（如 http://127.0.0.1:9999）
   * @param {string} path 路径（如 /api/tasks）
   * @returns {string} 拼好的完整 URL
   */
  function joinUrl(base, path) {
    const b = String(base || '').replace(/\/+$/g, ''); // 去掉 base 末尾多余斜杠
    const p = String(path || '').replace(/^\/+/g, ''); // 去掉 path 开头多余斜杠
    return `${b}/${p}`;                                // 统一用单斜杠连接
  }

  /**
   * 构造 Gopeed API 请求头。
   * @returns {Record<string, string>} 请求头对象
   */
  function buildGopeedHeaders() {
    const headers = {};                                                   // 先准备空对象
    headers['accept'] = 'application/json';                               // 告诉服务端期望 JSON
    headers['content-type'] = 'application/json';                         // 请求体是 JSON
    if (GOPEED_CONFIG.apiToken) {                                         // 有 token 才附带
      headers[GOPEED_CONFIG.tokenHeader] = GOPEED_CONFIG.apiToken;        // 使用你给的 token 头
    }
    return headers;                                                       // 返回完整头对象
  }

  /**
   * 构造“下载请求”需要的 HTTP 头（给 Gopeed 代请求时用）。
   * @returns {Record<string, string>} 请求头对象
   */
  function buildGopeedDownloadHeaders() {
    const headers = {};                                                   // 初始化空对象
    if (GOPEED_CONFIG.includeRefererHeader) {                             // 需要 Referer 才加
      headers['Referer'] = location.href;                                 // 保持与浏览器访问一致
    }
    if (GOPEED_CONFIG.includeCookieHeader && document.cookie) {           // 需要 Cookie 才加
      headers['Cookie'] = document.cookie;                                // 透传当前页面 Cookie
    }
    return headers;                                                       // 返回结果
  }

  /**
   * 使用 GM_xmlhttpRequest 发送 JSON 请求（避免 CORS）。
   * @param {string} method HTTP 方法（GET/POST 等）
   * @param {string} url 完整 URL
   * @param {object|null} bodyObj JSON 对象（GET 时可传 null）
   * @param {number} timeoutMs 超时毫秒数
   * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
   */
  function gmRequestJson(method, url, bodyObj, timeoutMs) {
    return new Promise((resolve) => {                                     // 用 Promise 包一层方便 await
      const bodyText = bodyObj ? JSON.stringify(bodyObj) : '';            // POST 才需要 body
      GM_xmlhttpRequest({                                                 // 调用 Tampermonkey 的跨域请求
        method: method,                                                   // 设置方法
        url: url,                                                         // 设置 URL
        headers: buildGopeedHeaders(),                                    // 设置 Gopeed API 头
        data: bodyText,                                                   // 写入请求体
        timeout: timeoutMs,                                               // 设置超时
        onload: (resp) => {                                               // 成功返回
          const status = Number(resp.status || 0);                        // 统一成数字状态码
          const text = String(resp.responseText || '');                   // 统一成文本
          let data = null;                                                // 先准备解析结果
          try { data = text ? JSON.parse(text) : null; } catch (e) {}     // 尝试解析 JSON
          resolve({ ok: status >= 200 && status < 300, status, data, text }); // 返回结构化结果
        },
        onerror: () => {                                                  // 网络错误
          resolve({ ok: false, status: 0, data: null, text: '网络错误' }); // 统一成失败结构
        },
        ontimeout: () => {                                                // 超时
          resolve({ ok: false, status: 0, data: null, text: '请求超时' }); // 统一成失败结构
        }
      });
    });
  }

  /**
   * 构造 Gopeed “创建任务”请求体。
   * @param {string} url 下载地址
   * @param {string} filename 期望的文件名
   * @returns {{req: object, opts?: object}} 任务创建结构
   */
  function buildGopeedCreateTaskBody(url, filename) {
    const req = {                                                        // Gopeed 的 Request 结构
      url: url                                                          // 必填：下载地址
    };
    const extraHeaders = buildGopeedDownloadHeaders();                   // 可选的额外请求头
    if (Object.keys(extraHeaders).length > 0) {                          // 只有真的有头才塞进去
      req.extra = { header: extraHeaders };                              // HttpReqExtra：header
    }

    const opts = {};                                                     // Options：下载选项（Gopeed 新版字段名）
    if (filename) {                                                      // 有文件名才设置
      opts.name = filename;                                              // 自定义文件名
    }
    if (GOPEED_CONFIG.defaultSavePath) {                                 // 有默认目录才设置
      opts.path = GOPEED_CONFIG.defaultSavePath;                         // 自定义保存路径
    }

    const body = { req };                                                // 先放 req
    if (Object.keys(opts).length > 0) body.opts = opts;                  // 只有有字段才挂 opts
    return body;                                                         // 返回最终 body
  }

  /**
   * 把一个下载任务提交给 Gopeed（按配置的 createMode 走）。
   * @param {string} url 下载地址
   * @param {string} filename 自定义文件名
   * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
   */
  async function submitGopeedTask(url, filename) {
    const body = buildGopeedCreateTaskBody(url, filename);               // 生成任务 body（req + opts）

    if (GOPEED_CONFIG.createMode === 'tasks') {                          // 模式：单任务 /api/tasks
      const endpoint = joinUrl(GOPEED_CONFIG.baseUrl, GOPEED_CONFIG.tasksPath); // 拼接 URL
      return await gmRequestJson('POST', endpoint, body, GOPEED_CONFIG.timeoutMs); // 直接提交
    }

    if (GOPEED_CONFIG.createMode === 'batch') {                          // 模式：批量 /api/tasks/batch
      const endpoint = joinUrl(GOPEED_CONFIG.baseUrl, GOPEED_CONFIG.batchPath); // 拼接 URL
      const batchBody = { reqs: [body.req] };                             // 只放一个请求，也合法
      if (body.opts) batchBody.opts = body.opts;                          // 有 opts 才挂上
      return await gmRequestJson('POST', endpoint, batchBody, GOPEED_CONFIG.timeoutMs); // 提交
    }

    // 兜底模式：/request（官方文档明确有此端点，但不保证支持 name/path）
    const endpoint = joinUrl(GOPEED_CONFIG.baseUrl, GOPEED_CONFIG.requestPath); // 拼接 URL
    const requestBody = { url: url, labels: { filename: filename || '' } };     // 只提交 url + 标签
    return await gmRequestJson('POST', endpoint, requestBody, GOPEED_CONFIG.timeoutMs); // 提交
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

  // 从 PlayFileUri 推导出 mp4 地址（我们优先使用“无参数”的纯净版本）
  function mp4FromPlayUri(playUri) {
    if (!playUri) return { withKey: '', noKey: '' };                 // 入参为空直接返回
    // content.html 替换为 VGA.mp4，保留 query 参数（timestamp/authKey 等）
    const withKey = playUri.replace(/content\.html(\?.*)?$/i, 'VGA.mp4$1'); // 带参数版本
    // 不带参数的纯净版本（去掉 ? 后面的所有参数）
    const noKey = withKey.split('?')[0];                             // 无参数版本
    return { withKey, noKey };                                       // 返回两个版本
  }

  /**
   * 根据你的需求：优先“无参数”版本，避免 authKey 过期。
   * @param {string} playUri 播放地址
   * @returns {string} 无参数 mp4（拿不到则返回空串）
   */
  function pickMp4Url(playUri) {
    const r = mp4FromPlayUri(playUri);                               // 先解析两种版本
    return r.noKey || '';                                            // 只返回无参数版本
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
        throw e; // 抛出，让上层处理（重试/记录）
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
    #tm_panel .tm-log-mini {
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.20);
      background: rgba(255, 255, 255, 0.10);
      color: #ffffff;
      margin-top: 10px;
      max-height: 44px; /* 固定高度，避免挤占列表空间 */
      overflow: hidden;
    }
    #tm_panel .tm-log-line {
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
      color: #ffffff;
    }
    #tm_panel .tm-log-empty { color: rgba(255, 255, 255, 0.85); }
    #tm_panel .tm-log {
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(255, 255, 255, 0.10);
      padding: 10px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #ffffff;
      margin: 0;
    }

    #tm_panel #tm_extra { margin: 10px 0; }

    #tm_panel .tm-list { display: flex; flex-direction: column; gap: 10px; }
    #tm_panel details.tm-day summary {
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    #tm_panel details.tm-day summary::-webkit-details-marker { display: none; }
    #tm_panel .tm-day {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.06);
    }
    #tm_panel .tm-day-summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    #tm_panel .tm-day-title {
      font-weight: 900;
      color: #ffffff;
    }
    #tm_panel .tm-day-sub {
      color: rgba(255, 255, 255, 0.78);
      font-size: 12px;
    }
    #tm_panel .tm-day-actions { display: flex; gap: 8px; }
    #tm_panel .tm-day-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }
    #tm_panel .tm-item {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.06);
    }
    #tm_panel .tm-item-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    #tm_panel .tm-item-actions { display: flex; gap: 8px; }
    #tm_panel .tm-tag {
      display: inline-block;
      padding: 0 6px;
      border-radius: 999px;
      background: rgba(255, 208, 92, 0.20);
      color: #ffd36b;
      font-size: 11px;
      font-weight: 900;
      margin-left: 6px;
      vertical-align: middle;
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

      <div class="tm-help">
        <div class="tm-help-title">使用提示</div>
        <ul>
          <li>已改为 <code>Gopeed</code> 外部下载器提交任务（不再使用浏览器下载）。</li>
          <li>请确认 Gopeed 已开启 TCP API，并配置了 Token（示例：<code>x-api-token</code>）。</li>
          <li>列表按日期倒序展示，可下载“整天”或“单节”。</li>
        </ul>
      </div>

      <div id="tm_log_mini" class="tm-log-mini"></div>
      <details class="tm-details" style="margin-top:10px;">
        <summary>日志（点开看全部）</summary>
        <pre id="tm_log" class="tm-log"></pre>
      </details>

      <div id="tm_extra"></div>
      <div id="tm_list" class="tm-list"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);
  window.__tm_panel = panel; // 保存面板引用供其他功能使用

  const logEl = qs('#tm_log', panel);                                     // 完整日志的 DOM
  const logMiniEl = qs('#tm_log_mini', panel);                            // 迷你日志的 DOM
  const __tmLogLines = [];                                                // 日志行缓存（内存）
  const __tmLogMax = 200;                                                 // 最多保留 200 行，防止过长
  const __tmLogMiniCount = UI_CONFIG.miniLogLines;                        // 默认展示最近 N 条

  /**
   * 渲染“迷你日志”（只显示最近几条）。
   */
  function renderLogMini() {
    if (!logMiniEl) return;                                               // 没有 DOM 就直接退出
    if (__tmLogLines.length === 0) {                                      // 没日志时显示占位
      logMiniEl.innerHTML = `<div class="tm-log-line tm-log-empty">暂无日志</div>`; // 占位提示
      return;                                                             // 结束
    }
    const tail = __tmLogLines.slice(-__tmLogMiniCount);                   // 取最近 N 条
    logMiniEl.innerHTML = tail.map(l =>                                   // 逐条渲染
      `<div class="tm-log-line">${escapeHtml(l)}</div>`                   // 每条单独一行
    ).join('');                                                           // 合并 HTML
  }

  /**
   * 追加一条日志到缓存与 UI。
   * @param {string} line 日志文本（已经拼好）
   */
  function appendLogLine(line) {
    __tmLogLines.push(line);                                              // 写入缓存
    if (__tmLogLines.length > __tmLogMax) {                               // 超过上限则丢弃最旧
      __tmLogLines.shift();                                               // 移除第一条
    }
    logEl.textContent = __tmLogLines.join('\n') + '\n';                   // 重新渲染完整日志
    logEl.scrollTop = logEl.scrollHeight;                                 // 滚动到底部
    renderLogMini();                                                      // 同步更新迷你日志
  }

  /**
   * 清空日志（完整 + 迷你）。
   */
  function clearLogs() {
    __tmLogLines.length = 0;                                              // 清空缓存
    logEl.textContent = '';                                               // 清空完整日志
    renderLogMini();                                                      // 刷新迷你日志
  }

  /**
   * 统一日志入口：控制台 + 面板日志。
   * @param {...any} args 日志参数
   */
  function log(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '); // 拼接日志文本
    const ts = new Date().toLocaleTimeString();                           // 加上时间戳，方便定位
    const line = `[TM ${ts}] ${msg}`;                                     // 形成一条完整日志
    console.log('[TM]', msg);                                             // 控制台输出（保留原样）
    appendLogLine(line);                                                  // 写入面板日志
  }

  renderLogMini();                                                        // 初始化迷你日志
  qs('#tm_clear', panel).addEventListener('click', () => clearLogs());     // 清空按钮

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
  /**
   * 构造“当前页面课程”的条目（用于补齐列表）。
   * @returns {object|null} 当前页条目；如果拿不到 NewID 则返回 null
   */
  function buildCurrentPageItem() {
    const newId = getParam('NewID') || getParam('NewId') || '';           // 优先从 URL 拿当前页 NewID
    if (!newId) return null;                                              // 没有 NewID 就无法走 API，直接放弃

    const titleEl = qs('#courseName');                                    // 页面上的课程标题节点
    const metaRaw = (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(); // 优先用 title，其次 text
    const meta = metaRaw || (document.title || '').trim();                // 如果都没有，再兜底用 document.title

    const filename = filenameFromMeta(meta || `NewID_${newId}`);          // 用现有规则生成文件名
    const date = parseDate(meta);                                         // 尝试从 meta 解析日期（失败就为空）

    return {                                                              // 组装成与推荐列表一致的结构
      newId,                                                              // NewID（关键字段）
      url: location.href,                                                 // 当前页面 URL
      meta: meta || `当前课程（NewID=${newId}）`,                          // meta 文本兜底
      date,                                                               // 解析到的日期
      filename,                                                           // 生成的文件名
      isCurrent: true                                                     // 标记：这是当前页
    };
  }

  /**
   * 把“当前页课程”合并进列表（避免重复）。
   * @param {Array<object>} items 推荐列表
   */
  function mergeCurrentPageItem(items) {
    const current = buildCurrentPageItem();                               // 先构造当前页条目
    if (!current) return;                                                 // 构造失败则不处理

    const hasSameNewId = items.some(it => it.newId && it.newId === current.newId); // 判断是否已存在同 NewID
    if (hasSameNewId) return;                                             // 已存在就不重复添加

    const hasSameFilename = items.some(it => it.filename === current.filename); // 再判断是否同文件名
    if (hasSameFilename) return;                                          // 同文件名也视为已包含

    items.push(current);                                                  // 追加到列表
  }

  function parseRecommendList() {
    const ul = qs('ul.about_video');                                     // 推荐列表容器
    if (!ul) return [];                                                  // 没找到直接返回空数组

    const items = [];                                                    // 用于收集结果
    qsa('li a[href*="Video.aspx?NewID="]', ul).forEach(a => {            // 遍历每个推荐项
      const href = a.getAttribute('href') || '';                         // 取出 href
      const full = new URL(href, location.origin).toString();            // 补成绝对地址
      const u = new URL(full);                                           // 解析 URL
      const newId = u.searchParams.get('NewID') || '';                   // 取出 NewID

      const titleP = qs('p.title', a);                                   // 标题节点
      const meta = (titleP?.getAttribute('title') || '').trim();         // meta 文本

      if (newId) {                                                       // 只有有 NewID 才收录
        items.push({                                                     // 记录一条
          newId,                                                         // NewID
          url: full,                                                     // 详情页 URL
          meta,                                                          // meta 原始文本
          date: parseDate(meta),                                         // 解析出的日期
          filename: filenameFromMeta(meta || `NewID_${newId}`)           // 生成文件名
        });
      }
    });

    mergeCurrentPageItem(items);                                         // 把当前页课程补进列表
    sortItemsForDisplay(items);                                          // 按日期倒序 + 时间排序
    return items;                                                        // 返回结果
  }

  /**
   * 列表排序：日期倒序（新日期在前），同一天按 meta 正序（接近上课顺序）。
   * @param {Array<{date:string,meta:string}>} items 课程列表
   */
  function sortItemsForDisplay(items) {
    items.sort((a, b) => {                                                // 自定义排序
      const ca = !!a.isCurrent;                                           // 是否当前页 A
      const cb = !!b.isCurrent;                                           // 是否当前页 B
      if (ca !== cb) return ca ? -1 : 1;                                  // 当前页优先显示在最上
      const da = a.date || '';                                            // A 的日期
      const db = b.date || '';                                            // B 的日期
      if (da !== db) return db.localeCompare(da);                         // 日期倒序
      return (a.meta || '').localeCompare(b.meta || '');                  // 同日按 meta
    });
  }

  /**
   * 获取“最新日期”（用于默认展开）。
   * @param {Array<{date:string}>} items 课程列表
   * @returns {string} 最新日期（YYYY-MM-DD）
   */
  function getLatestDate(items) {
    const dates = uniq(items.map(x => x.date).filter(Boolean)).sort();    // 排序后的日期列表
    return dates[dates.length - 1] || '';                                 // 取最后一个就是最新
  }

  /**
   * 按日期分组，方便 UI 分组展示。
   * @param {Array<{date:string}>} items 课程列表
   * @returns {Record<string, Array>} 日期 -> 条目数组
   */
  function groupItemsByDate(items) {
    const map = {};                                                       // 用对象做分组
    for (const it of items) {                                             // 遍历每条
      const d = it.date || '未知日期';                                    // 日期为空时兜底
      if (!map[d]) map[d] = [];                                           // 初始化分组
      map[d].push(it);                                                    // 塞入分组
    }
    return map;                                                           // 返回分组结果
  }

  /**
   * 通过 API 获取 mp4，再把任务提交给 Gopeed。
   * @param {object} item 单条课程信息
   */
  async function downloadByApi(item) {
    try {
      log('[API] 获取视频信息：', item.newId);                            // 日志：开始请求
      const v = await getVideoInfoByNewId(item.newId);                    // 调 API 拿信息

      const segments = v.VideoSegmentInfo || [];                          // 课程片段列表
      if (!segments.length) {                                             // 没有片段直接返回
        log('[API] 无视频片段：', item.newId);                            // 日志提示
        return;                                                           // 结束
      }

      for (let i = 0; i < segments.length; i++) {                         // 逐片段处理
        const seg = segments[i];                                          // 当前片段
        const mp4Url = pickMp4Url(seg.PlayFileUri);                       // 只取无参数 mp4

        if (!mp4Url) {                                                    // 取不到就跳过
          log('[API] 无法解析无参数 mp4 地址：', seg.PlayFileUri);         // 日志提示
          continue;                                                       // 进入下一个片段
        }

        let fn = buildFilenameFromApi(v);                                 // 基础文件名
        if (segments.length > 1) {                                        // 多片段需要区分
          fn = fn.replace(/\.mp4$/i, `-seg${i + 1}.mp4`);                  // 追加分段后缀
        }

        log('[Gopeed] 提交下载：', fn);                                    // 日志提示
        const r = await submitGopeedTask(mp4Url, fn);                     // 提交到 Gopeed
        if (!r.ok) {                                                      // 提交失败
          log('[Gopeed] 提交失败：', fn, r.status || '', r.text || '');    // 输出失败原因
        } else {                                                          // 提交成功
          log('[Gopeed] 已提交：', fn);                                    // 成功日志
        }
      }
    } catch (err) {
      log('[API失败] 仅记录错误，不再降级：', item.newId, err.message);     // 取消降级逻辑
    }
  }

  /******************* 队列：提交到 Gopeed（内存队列即可） *******************/
  const __tmQueue = [];                                                   // 内存队列（本页有效）
  const __tmQueueSet = new Set();                                         // 去重集合（按 newId）
  let __tmInflight = 0;                                                   // 当前进行中的数量
  const __tmConcurrency = 2;                                              // 并发提交数量（保守一点）

  /**
   * 把任务加入队列（避免重复）。
   * @param {Array<object>} items 任务列表
   */
  function enqueue(items) {
    let added = 0;                                                        // 记录实际新增数
    for (const it of items) {                                             // 遍历每条
      if (__tmQueueSet.has(it.newId)) continue;                           // 已存在则跳过
      __tmQueue.push(it);                                                 // 进入队列
      __tmQueueSet.add(it.newId);                                         // 加入去重集合
      added += 1;                                                         // 计数 +1
    }
    log(`队列加入 ${added} 条，当前队列总数=${__tmQueue.length}`);          // 输出队列状态
  }

  /**
   * 队列处理器：按并发限制提交给 Gopeed。
   */
  async function processQueue() {
    if (__tmInflight >= __tmConcurrency) return;                          // 并发满了先退出
    if (__tmQueue.length === 0) return;                                   // 队列为空直接返回

    const next = __tmQueue.shift();                                       // 取出一个任务
    __tmQueueSet.delete(next.newId);                                      // 同步去重集合
    __tmInflight += 1;                                                    // 并发 +1

    try {
      await downloadByApi(next);                                          // 执行下载逻辑
    } finally {
      __tmInflight = Math.max(0, __tmInflight - 1);                       // 并发 -1，防止负数
    }
  }

  setInterval(processQueue, 400);                                         // 轻量轮询（不要太频繁）

  /******************* 渲染列表 + 按钮逻辑 *******************/
  let __tmItemMap = new Map();                                            // newId -> item 映射
  let __tmItemsByDate = {};                                               // date -> items 映射

  function updateUI() {
    const rec = parseRecommendList();                                     // 解析推荐列表

    const info = qs('#tm_info', panel);                                   // 信息栏 DOM
    info.textContent = `本页 NewID=${getParam('NewID') || '(无)'} ｜ 推荐条目数=${rec.length} ｜ 队列=${__tmQueue.length} ｜ 并发=${__tmInflight}/${__tmConcurrency} ｜ 已捕获MP4数=${mp4Set.size} ｜ 已捕获csrkToken=${__tmCsrkToken ? '是' : '否'} ｜ Gopeed=${GOPEED_CONFIG.baseUrl} ｜ Token=${GOPEED_CONFIG.apiToken ? '已配置' : '未配置'}`; // 更新状态信息

    __tmItemMap = new Map(rec.map(it => [it.newId, it]));                 // 建立 newId 映射
    const currentItem = rec.find(it => it.isCurrent);                     // 当前页条目（如果有）
    const otherItems = rec.filter(it => !it.isCurrent);                   // 非当前页条目
    __tmItemsByDate = groupItemsByDate(otherItems);                       // 建立日期分组（排除当前页）

    const list = qs('#tm_list', panel);                                   // 列表容器
    if (!rec.length) {                                                    // 没有条目
      list.innerHTML = `<div class="tm-empty">未检测到相关推荐列表（ul.about_video）。</div>`; // 空态提示
      return;                                                             // 结束
    }

    const openSet = new Set();                                            // 保存已展开的日期
    list.querySelectorAll('details.tm-day[open]').forEach(el => {          // 读取现有展开状态
      const d = el.getAttribute('data-date') || '';                       // 读出日期
      if (d) openSet.add(d);                                              // 有日期才记录展开状态
    });

    const latestDate = getLatestDate(otherItems);                         // 最新日期（用于自动展开）
    const dates = Object.keys(__tmItemsByDate).sort((a, b) => b.localeCompare(a)); // 日期倒序

    // 1) 当前页条目（如果有）放在最上方，且不包“日期大框”
    const currentHtml = currentItem ? `
      <div class="tm-item" data-newid="${escapeHtml(currentItem.newId)}">
        <div class="tm-item-row">
          <div class="tm-item-meta">${escapeHtml(currentItem.meta)} <span class="tm-tag">当前页</span></div>
          <div class="tm-item-actions">
            <button class="tm-btn" type="button" data-action="download-item" data-newid="${escapeHtml(currentItem.newId)}">下载本节</button>
          </div>
        </div>
        <div class="tm-item-sub">NewID：<span class="tm-mono">${escapeHtml(currentItem.newId)}</span></div>
        <div class="tm-item-sub">文件名：<span class="tm-mono">${escapeHtml(currentItem.filename)}</span></div>
      </div>
    ` : '';

    // 2) 其它课程仍按日期分组显示
    const groupedHtml = dates.map(d => {                                  // 逐日渲染
      const items = __tmItemsByDate[d] || [];                             // 该日期的课程
      const shouldOpen = openSet.size                                     // 是否已有展开记录
        ? openSet.has(d)                                                  // 有记录就按记录决定
        : (UI_CONFIG.autoOpenLatest ? d === latestDate : false);          // 否则按配置决定是否自动展开
      const openAttr = shouldOpen ? 'open' : '';                          // open 属性

      const itemsHtml = items.map(it => `                               // 构建单日条目 HTML
        <div class="tm-item" data-newid="${escapeHtml(it.newId)}">       
          <div class="tm-item-row">                                     
            <div class="tm-item-meta">${escapeHtml(it.meta)}</div>       
            <div class="tm-item-actions">                               
              <button class="tm-btn" type="button" data-action="download-item" data-newid="${escapeHtml(it.newId)}">下载本节</button>
            </div>
          </div>
          <div class="tm-item-sub">NewID：<span class="tm-mono">${escapeHtml(it.newId)}</span></div>
          <div class="tm-item-sub">文件名：<span class="tm-mono">${escapeHtml(it.filename)}</span></div>
        </div>
      `).join('');                                                        // 合并单日条目 HTML

      // 组装“日期分组”的完整 HTML
      return `
        <details class="tm-day" data-date="${escapeHtml(d)}" ${openAttr}>
          <summary class="tm-day-summary">
            <div>
              <div class="tm-day-title">${escapeHtml(d)}</div>
              <div class="tm-day-sub">共 ${items.length} 节</div>
            </div>
            <div class="tm-day-actions">
              <button class="tm-btn primary" type="button" data-action="download-day" data-date="${escapeHtml(d)}">下载当天全部</button>
            </div>
          </summary>
          <div class="tm-day-list">
            ${itemsHtml}
          </div>
        </details>
      `;
    }).join('');                                                          // 合并整体 HTML

    list.innerHTML = `${currentHtml}${groupedHtml}`;                      // 合并输出（当前页在最上）
  }

  setTimeout(updateUI, 1200);                                             // 延迟首次刷新（等 DOM 稳定）
  setInterval(updateUI, UI_CONFIG.refreshMs);                             // 定时刷新列表（可配置）

  // 列表事件：统一用事件委托，避免频繁绑定
  qs('#tm_list', panel).addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');                 // 找到最近的按钮
    if (!btn) return;                                                     // 不是按钮就忽略

    const summary = btn.closest('summary');                               // 判断是否在 summary 内
    if (summary) {                                                        // 在 summary 内则阻止折叠
      ev.preventDefault();                                                // 阻止默认折叠行为
      ev.stopPropagation();                                               // 阻止事件冒泡
    }

    const action = btn.getAttribute('data-action') || '';                 // 取出动作类型
    if (action === 'download-day') {                                      // 下载整天
      const d = btn.getAttribute('data-date') || '';                      // 取出日期
      const items = __tmItemsByDate[d] || [];                             // 取出当天课程
      if (!items.length) {                                                // 没有课程就提示
        log('该日期无条目：', d);                                         // 输出日志
        return;                                                           // 结束
      }
      enqueue(items);                                                     // 加入队列
      return;                                                             // 结束
    }

    if (action === 'download-item') {                                     // 下载单节
      const newId = btn.getAttribute('data-newid') || '';                 // 取出 NewID
      const item = __tmItemMap.get(newId);                                // 取出对应条目
      if (!item) {                                                        // 找不到条目
        log('未找到该条目：', newId);                                     // 输出日志
        return;                                                           // 结束
      }
      enqueue([item]);                                                    // 加入队列
    }
  });

})();
