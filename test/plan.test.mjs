/**
 * 纯函数断言：采样时刻与缩放尺寸。
 *
 * 这一组不碰 ffmpeg，因此**永远可跑**（没有 ffmpeg 的机器也能验），
 * 而且它们钉的正是"算错了也不报错、只会安静给出错图"的那几个点。
 *
 * @module dsh-video-see/test/plan
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_COUNT,
  DEFAULT_MAX_PIXELS,
  MAX_FRAMES,
  endEdge,
  formatSeconds,
  parseSeconds,
  planFrameSize,
  planGrid,
  planTimes,
} from '../lib/plan.js';

test('parseSeconds 认得出秒数与时钟格式', () => {
  assert.equal(parseSeconds(12.5), 12.5);
  assert.equal(parseSeconds('12.5'), 12.5);
  assert.equal(parseSeconds('01:30'), 90);
  assert.equal(parseSeconds('00:01:30'), 90);
  assert.equal(parseSeconds('1:00:00.5'), 3600.5);
});

test('parseSeconds 认不出来就返回 null，绝不猜', () => {
  for (const bad of ['', '  ', 'abc', '1:2:3:4', '1:xx', null, undefined, {}, [], NaN, Infinity]) {
    assert.equal(parseSeconds(bad), null, `期望 null：${String(bad)}`);
  }
});

test('formatSeconds 补零到毫秒', () => {
  assert.equal(formatSeconds(0), '0:00.000');
  assert.equal(formatSeconds(5.5), '0:05.500');
  assert.equal(formatSeconds(65.25), '1:05.250');
  assert.equal(formatSeconds(-3), '0:00.000');
});

test('planTimes：默认等分，首尾都落在边界上', () => {
  const times = planTimes({ duration: 3 });
  assert.equal(times.length, DEFAULT_COUNT);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 3);
});

test('planTimes：时长非法时返回空数组，不编造时刻', () => {
  for (const duration of [0, -1, NaN, Infinity, undefined, null, '3']) {
    assert.deepEqual(planTimes({ duration }), [], `duration=${String(duration)}`);
  }
});

test('planTimes：越界时刻被夹紧（ffmpeg 抽不到越界帧，报错却不像时间戳的问题）', () => {
  const times = planTimes({ duration: 10, times: [5, 999] });
  assert.deepEqual(times, [5, 10]);
});

test('planTimes：显式时刻排序去重（1ms 内算同一帧）', () => {
  const times = planTimes({ duration: 10, times: ['3', '1', '1.0005', '2'] });
  assert.deepEqual(times, [1, 2, 3]);
});

test('planTimes：认不出的时刻被丢掉，而不是变成 NaN', () => {
  const times = planTimes({ duration: 10, times: ['abc', '2', null, {}] });
  assert.deepEqual(times, [2]);
});

test('planTimes：窗口起止写反要修好，不能给空区间', () => {
  const times = planTimes({ duration: 10, start: 8, end: 2, count: 3 });
  assert.deepEqual(times, [2, 5, 8]);
});

test('planTimes：every 极小时不会先造出千万级数组', () => {
  const started = Date.now();
  const times = planTimes({ duration: 3600, every: 0.001 });
  assert.ok(times.length <= MAX_FRAMES, `期望封顶 ${MAX_FRAMES}，实得 ${times.length}`);
  assert.ok(Date.now() - started < 2000, '生成循环必须有界');
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 3600, '抽稀后仍要覆盖到窗口末尾');
});

test('planTimes：超限抽稀时保住首尾，而不是砍掉尾巴', () => {
  const times = planTimes({ duration: 100, count: 200 });
  assert.equal(times.length, MAX_FRAMES);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 100);
});

test('planTimes：max=1 不除零（旧版会算出 NaN 下标）', () => {
  const times = planTimes({ duration: 10, count: 5, max: 1 });
  assert.equal(times.length, 1);
  assert.ok(Number.isFinite(times[0]));
});

test('endEdge：按帧率给出末尾避让，未知帧率时保守取 0.1', () => {
  assert.equal(endEdge(25), 0.06);
  assert.equal(endEdge(60), 0.05);
  assert.equal(endEdge(1000), 0.05);
  assert.equal(endEdge(null), 0.1);
  assert.equal(endEdge(0), 0.1);
});

test('planTimes + edge：末帧必须落在时长之内（边界上没有帧，-ss 到边界必然抽空）', () => {
  const edge = endEdge(25);
  const times = planTimes({ duration: 3, count: 8, edge });
  assert.equal(times.length, 8);
  assert.equal(times[0], 0);
  assert.ok(times.at(-1) < 3, `末帧 ${times.at(-1)} 必须 < 3`);
  assert.equal(times.at(-1), 3 - edge);
});

test('planTimes + edge：显式 times 越界同样被夹到可用边界内', () => {
  const times = planTimes({ duration: 3, times: ['2.99', '99'], edge: 0.06 });
  assert.deepEqual(times, [2.94]);
});

test('planTimes + edge：视频比避让还短时不返回空，退化成 0 处一帧', () => {
  const times = planTimes({ duration: 0.03, count: 8, edge: 0.06 });
  assert.deepEqual(times, [0]);
});

test('planTimes：unknown 的 max 收敛到默认上限', () => {
  assert.equal(planTimes({ duration: 10, count: 1000, max: -5 }).length, MAX_FRAMES);
  assert.equal(planTimes({ duration: 10, count: 1000, max: NaN }).length, MAX_FRAMES);
});

test('planFrameSize：横屏按宽度上限缩', () => {
  const size = planFrameSize(1920, 1080, { maxWidth: 768, maxPixels: DEFAULT_MAX_PIXELS });
  assert.deepEqual(size, { width: 768, height: 432, resized: true });
  assert.ok(size.width * size.height <= DEFAULT_MAX_PIXELS);
});

test('planFrameSize：竖屏必须按面积算（只卡宽度会超预算近一倍）', () => {
  const size = planFrameSize(2160, 4096, { maxWidth: 768, maxPixels: DEFAULT_MAX_PIXELS });
  assert.equal(size.width, 580);
  assert.equal(size.height, 1100);
  assert.ok(size.width * size.height <= DEFAULT_MAX_PIXELS, '面积必须进预算');
  // 反例：只按宽度缩到 768 会得到 768×1456 ≈ 1.12M 像素
  assert.ok(768 * 1456 > DEFAULT_MAX_PIXELS);
});

test('planFrameSize：不需要缩小时原样返回，连取偶都不做（否则会改宽高比）', () => {
  const size = planFrameSize(101, 101, { maxWidth: 4096, maxPixels: 4096 * 4096 });
  assert.deepEqual(size, { width: 101, height: 101, resized: false });
});

test('planFrameSize：输出恒为偶数（多数编码器要求），且绝不为 0', () => {
  for (const [w, h] of [[1921, 1081], [33, 33], [4095, 2161], [100, 3]]) {
    const size = planFrameSize(w, h, { maxWidth: 768, maxPixels: DEFAULT_MAX_PIXELS });
    assert.ok(size.width > 0 && size.height > 0, `${w}x${h} 出现了 0`);
    if (size.resized) {
      assert.equal(size.width % 2, 0, `${w}x${h} 的宽 ${size.width} 不是偶数`);
      assert.equal(size.height % 2, 0, `${w}x${h} 的高 ${size.height} 不是偶数`);
    }
  }
});

test('planFrameSize：源尺寸非法时不抛错，退回 1x1', () => {
  assert.deepEqual(planFrameSize(0, 0, {}), { width: 1, height: 1, resized: false });
  assert.deepEqual(planFrameSize(NaN, 100, {}), { width: 1, height: 1, resized: false });
});

test('planGrid：格子数够用且接近正方', () => {
  assert.deepEqual(planGrid(1), { cols: 1, rows: 1 });
  assert.deepEqual(planGrid(4), { cols: 2, rows: 2 });
  assert.deepEqual(planGrid(9), { cols: 3, rows: 3 });
  for (const count of [2, 3, 5, 6, 7, 8, 10, 12, 16, 20]) {
    const grid = planGrid(count);
    assert.ok(grid.cols * grid.rows >= count, `${count} 帧放不进 ${grid.cols}x${grid.rows}`);
    assert.ok(grid.cols <= count && grid.rows <= count);
  }
});
