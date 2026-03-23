/**
 * smartclass-downloader 脚本侧单元测试。
 *
 * 为什么这里直接测 userscript 文件本身？
 *
 * 1. 这份脚本没有独立构建步骤，最怕“测试测的是复制出来的辅助代码，真正运行的脚本却没被覆盖到”。
 * 2. 因此脚本文件在 Node 环境下会只导出纯函数，不启动浏览器 UI。
 * 3. 这样可以直接验证“请求体组装”“日期/时间解析”“多片段 new_id 处理”等关键逻辑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./smartclass-downloader.user.js');

test('parseDate 应兼容斜杠与中文日期格式', () => {
  assert.equal(helpers.parseDate('病理学 王老师 2026/03/20 08:00:00-08:45:00'), '2026-03-20');
  assert.equal(helpers.parseDate('病理学 王老师 2026年3月20日 08:00-08:45'), '2026-03-20');
});

test('parseTimeRangeFromMeta 应提取 HH:mm 级别时间段', () => {
  assert.deepEqual(
    helpers.parseTimeRangeFromMeta('人体功能学 张玲 第二教室 2025-12-12 08:00:00-08:45:00'),
    { startHHmm: '08:00', endHHmm: '08:45' },
  );
  assert.deepEqual(
    helpers.parseTimeRangeFromMeta('人体功能学 张玲 第二教室 2025-12-12 08:00-08:45'),
    { startHHmm: '08:00', endHHmm: '08:45' },
  );
});

test('buildClassFlowHeadersForToken 应区分空 token 与非空 token', () => {
  assert.deepEqual(helpers.buildClassFlowHeadersForToken(''), {
    accept: 'application/json',
    'content-type': 'application/json',
  });

  assert.deepEqual(helpers.buildClassFlowHeadersForToken('  shared-token  '), {
    accept: 'application/json',
    'content-type': 'application/json',
    Authorization: 'Bearer shared-token',
  });
});

test('buildClassFlowIntakeItem 应对多片段补 segment 后缀并保留元数据', () => {
  const intakeItem = helpers.buildClassFlowIntakeItem({
    item: {
      newId: 'abc123',
      url: 'https://tmu.smartclass.cn/PlayPages/Video.aspx?NewID=abc123',
      meta: '病理学 王老师 第二教室 2026-03-20 08:00:00-08:45:00',
    },
    videoInfo: {
      CourseName: '病理学',
      TeacherList: [{ Name: '王老师' }],
      StartTime: '2026-03-20 08:00:00',
      StopTime: '2026-03-20 08:45:00',
    },
    segment: {
      PlayFileUri: 'https://cdn.example.com/path/content.html?authKey=abc',
    },
    segmentIndex: 1,
    segmentCount: 3,
  });

  assert.deepEqual(intakeItem, {
    new_id: 'abc123__seg2',
    page_url: 'https://tmu.smartclass.cn/PlayPages/Video.aspx?NewID=abc123',
    mp4_url: 'https://cdn.example.com/path/VGA.mp4',
    course_name: '病理学',
    teacher_name: '王老师',
    date: '2026-03-20',
    start_time: '08:00',
    end_time: '08:45',
    raw_title: '病理学 王老师 第二教室 2026-03-20 08:00:00-08:45:00 [片段2/3]',
  });
});

test('buildClassFlowBatchRequest 应生成稳定排序的 batch 请求体', () => {
  const body = helpers.buildClassFlowBatchRequest({
    semester: ' 2025-2026-2 ',
    resolvedItems: [
      {
        item: {
          newId: 'day-b',
          url: 'https://example.test/b',
          meta: '病理学 王老师 第二教室 2026-03-20 09:00:00-09:45:00',
        },
        videoInfo: {
          CourseName: '病理学',
          TeacherList: [{ Name: '王老师' }],
          StartTime: '2026-03-20 09:00:00',
          StopTime: '2026-03-20 09:45:00',
          VideoSegmentInfo: [{ PlayFileUri: 'https://cdn.example.com/b/content.html?ts=1' }],
        },
      },
      {
        item: {
          newId: 'day-a',
          url: 'https://example.test/a',
          meta: '病理学 王老师 第二教室 2026-03-20 08:00:00-08:45:00',
        },
        videoInfo: {
          CourseName: '病理学',
          TeacherList: [{ Name: '王老师' }],
          StartTime: '2026-03-20 08:00:00',
          StopTime: '2026-03-20 08:45:00',
          VideoSegmentInfo: [{ PlayFileUri: 'https://cdn.example.com/a/content.html?ts=1' }],
        },
      },
    ],
  });

  assert.equal(body.source, 'userscript');
  assert.equal(body.semester, '2025-2026-2');
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].new_id, 'day-a');
  assert.equal(body.items[0].start_time, '08:00');
  assert.equal(body.items[1].new_id, 'day-b');
  assert.equal(body.items[1].start_time, '09:00');
});
