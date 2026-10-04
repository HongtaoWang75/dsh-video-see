/**
 * 端到端断言：用**真的 ffmpeg** 驱动工具定义，只有 DSH 的三个服务是桩件。
 *
 * 素材是现造的（`testsrc2` + 正弦音轨），所以仓库里不需要躺二进制视频，
 * 也不会出现"素材是什么、还能不能代表今天的输入"这种问题。
 *
 * @module dsh-video-see/test/tool
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createRunner } from '../lib/exec.js';
import { buildTool, resolveConfig } from '../lib/index.js';
import { MAX_FRAMES } from '../lib/plan.js';
import {
  checkSchemaSubset,
  findFfmpeg,
  hasFfmpeg,
  makeCtx,
  makeExec,
  makeTestVideo,
  validateAgainstSchema,
  withTempDir,
} from './harness.mjs';

const paths = findFfmpeg();
const ready = await hasFfmpeg();
const temp = withTempDir();
const video = ready ? await makeTestVideo(temp.dir, { seconds: 3, width: 320, height: 240 }) : null;
after(() => temp.cleanup());

/** 按宿主的方式组装工具：配置 → runner → 定义。 */
function makeTool(ctx, config) {
  const cfg = resolveConfig({ ffmpegPath: paths.ffmpeg, ffprobePath: paths.ffprobe, ...config });
  const run = createRunner((spec) => ctx.subprocess.spawn(spec), {
    graceMs: cfg.graceMs,
    timeoutMs: cfg.timeoutMs,
  });
  return buildTool({ ctx, run, cfg });
}

test('测试台自检：契约检查器必须真的会说不，否则上面两条是假绿灯', () => {
  // 一个恒返回 [] 的检查器会让"schema 合法"永远通过——比没有测试更糟。
  assert.notDeepEqual(checkSchemaSubset({ type: 'integer', minimum: 1 }), [], '未支持的关键字要被抓到');
  assert.notDeepEqual(checkSchemaSubset({ type: 'array', maxItems: 3, items: { type: 'string' } }), []);
  assert.notDeepEqual(checkSchemaSubset({ type: 'string', pattern: '^a' }), []);
  assert.notDeepEqual(checkSchemaSubset({ type: 'object', oneOf: [{ type: 'string' }] }), [], 'type 与 oneOf 不能并存');
  assert.notDeepEqual(checkSchemaSubset({ type: 'object', items: { type: 'string' } }), [], 'items 只能挂在 array 上');
  assert.notDeepEqual(checkSchemaSubset({ type: 'object', properties: { a: { type: 'bogus' } } }), []);
  assert.deepEqual(checkSchemaSubset({ type: 'string', description: 'ok' }), [], '合法 schema 不能误报');

  assert.notDeepEqual(validateAgainstSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] }, { a: 'x', b: 1 }), [], '多余的键要被抓到');
  assert.notDeepEqual(validateAgainstSchema({ type: 'integer' }, 1.5), []);
  assert.notDeepEqual(validateAgainstSchema({ type: 'string', enum: ['a'] }, 'b'), []);
  assert.deepEqual(validateAgainstSchema({ type: 'string', enum: ['a'] }, 'a'), []);
});

test('注册契约：output 必须是 { schema, render }，宿主 register() 会硬校验', () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  assert.equal(definition.name, 'video_see');
  assert.equal(typeof definition.description, 'string');
  assert.ok(definition.description.length > 40, '描述是模型唯一的说明书，不能是敷衍的一句');
  assert.equal(definition.parameters.type, 'object');
  assert.deepEqual(definition.parameters.required, ['input']);
  assert.equal(definition.output.schema.type, 'object', '输出 schema 必须是对象根');
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
  assert.equal(definition.isConcurrencySafe({}), true);
});

test('注册契约：schema 只能用宿主支持的那个子集（用了别的关键字 = 插件装不上）', () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  assert.deepEqual(checkSchemaSubset(definition.parameters, 'parameters'), []);
  assert.deepEqual(checkSchemaSubset(definition.output.schema, 'output.schema'), []);
});

test('参数契约：times 同时收数字与字符串（模型天然会写 [12.5]，只收 string 会误拒）', () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  const items = definition.parameters.properties.times.items;
  assert.deepEqual(validateAgainstSchema(items, 12.5, 'times[0]'), []);
  assert.deepEqual(validateAgainstSchema(items, '01:30', 'times[0]'), []);
  assert.notDeepEqual(validateAgainstSchema(items, { seconds: 1 }, 'times[0]'), []);
});

test('只看视觉轨：描述里必须写明没有语音转写，避免模型凭画面编台词', () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  assert.match(definition.description, /no audio transcription/i);
});

test('e2e 默认抽帧：一次调用拿回 N 张真图，且每张都带时间戳', { skip: !ready }, async () => {
  const { ctx, attachments } = makeCtx();
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video }, makeExec());

  assert.deepEqual(validateAgainstSchema(definition.output.schema, value), [], '返回值必须贴合已声明的 schema');
  assert.equal(value.mode, 'frames');
  assert.ok(Math.abs(value.durationSeconds - 3) < 0.2, `时长应约 3 秒，实得 ${value.durationSeconds}`);
  assert.equal(value.sourceWidth, 320);
  assert.equal(value.sourceHeight, 240);
  assert.equal(value.hasAudio, true);
  assert.equal(value.frames.length, 8);
  assert.equal(value.sampledTimes.length, 8);
  assert.deepEqual(value.sampledTimes, [...value.sampledTimes].sort((a, b) => a - b), '时刻必须升序');
  assert.ok(value.sampledTimes[0] >= 0);
  // 末帧必须严格落在时长之内——落在 3.000 上时 ffmpeg 一个包都写不出来
  assert.ok(value.sampledTimes.at(-1) < value.durationSeconds, '末帧不能贴到时长边界');

  // 帧尺寸要与计划一致：320x240 在 768/640k 预算下不需要缩放
  assert.equal(value.frameWidth, 320);
  assert.equal(value.frameHeight, 240);
  assert.equal(attachments.saved.length, 8);
  for (const frame of value.frames) {
    assert.ok(frame.image.bytes > 200, '每张图都得有实际内容');
    assert.equal(frame.image.width, 320);
    assert.equal(frame.image.height, 240);
  }
});

test('e2e render：一段文本 + N 个 image 内容块，文本里写死"第几张 = 第几秒"', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video, count: 3 }, makeExec());
  const blocks = definition.output.render({}, value);

  assert.equal(blocks.length, 1 + 3);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /<path>/);
  assert.match(blocks[0].text, /image 1 = 0:00\.000/);
  for (const block of blocks.slice(1)) {
    assert.equal(block.type, 'image');
    assert.equal(typeof block.attachment.attachmentId, 'string');
    assert.equal(block.attachment.mediaType, 'image/jpeg');
  }
  // render 的产物要能无损 JSON 快照（宿主会做这一步）
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(blocks)));
});

test('e2e 定点抽帧：times 里的时刻被真实采到', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video, times: ['0.5', '2.5'] }, makeExec());
  assert.deepEqual(value.sampledTimes, [0.5, 2.5]);
  assert.equal(value.frames.length, 2);
  assert.equal(validateAgainstSchema(definition.output.schema, value).length, 0);
});

test('e2e 图版模式：N 帧拼成一张图，并把"第几格 = 第几秒"交代清楚', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video, count: 6, mode: 'sheet' }, makeExec());

  assert.equal(value.mode, 'sheet');
  assert.equal(value.frames.length, 1, '图版模式只回一张图');
  assert.equal(value.sampledTimes.length, 6, '但采样时刻表要完整');
  assert.equal(value.grid.cols * value.grid.rows >= 6, true);
  // 图版一定比单帧大：它是 cols x rows 排出来的
  assert.ok(value.frameWidth > 320 || value.frameHeight > 240, '图版尺寸应大于单帧');

  const blocks = definition.output.render({}, value);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /cell 1 = 0:00\.000/);
  assert.match(blocks[0].text, /cell 6 = /);
  assert.match(blocks[0].text, /black padding/);
  // 那一格装的是拼合图，标签不能说成某一个时刻的单帧
  assert.match(value.frames[0].label, /contact sheet of 6 frames/);
  assert.equal(validateAgainstSchema(definition.output.schema, value).length, 0);
});

test('e2e 时序不回退：抽出的帧按时刻单调递增', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video, count: 12 }, makeExec());
  const labels = value.frames.map((frame) => frame.time);
  assert.deepEqual(labels, [...labels].sort((a, b) => a - b));
});

test('图片能力门：模型声明不收图时，必须在跑 ffmpeg 之前就拒绝', { skip: !ready }, async () => {
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) };
  const { ctx, calls } = makeCtx({ llm });
  const definition = makeTool(ctx, {});
  await assert.rejects(
    () => definition.execute({ input: video }, makeExec()),
    /does not declare image input/,
  );
  assert.equal(calls.length, 0, '被拒绝的调用不该解码任何东西');
});

test('图片能力门：声明了 image 的模型放行', { skip: !ready }, async () => {
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
  const { ctx } = makeCtx({ llm });
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video, count: 1 }, makeExec());
  assert.equal(value.frames.length, 1);
});

test('图片能力门：取不到路由信息时放行（子代理 / headless 场景）', { skip: !ready }, async () => {
  const llm = { resolveModelInfo: async () => { throw new Error('unknown model'); } };
  const { ctx } = makeCtx({ llm });
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: video, count: 1 }, makeExec());
  assert.equal(value.frames.length, 1);
});

test('参数边界：count 超上限被收敛到配置的 maxFrames，不是照单全收', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, { maxFrames: 3 });
  const value = await definition.execute({ input: video, count: 100000 }, makeExec());
  assert.equal(value.frames.length, 3);
});

test('参数边界：maxFrames 自己也逃不过 MAX_FRAMES 这道闸', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, { maxFrames: 100000 });
  // 只验证计划层：真跑 64 次抽帧没必要，planTimes 单测已经覆盖了封顶行为
  assert.equal(resolveConfig({ maxFrames: 100000 }).maxFrames, MAX_FRAMES);
  assert.equal(definition.name, 'video_see');
});

test('参数边界：input 为空要报错，不能拿空路径去喂 ffprobe', async () => {
  const { ctx, calls } = makeCtx();
  const definition = makeTool(ctx, {});
  await assert.rejects(() => definition.execute({ input: '   ' }, makeExec()), /non-empty/);
  await assert.rejects(() => definition.execute({}, makeExec()), /non-empty/);
  assert.equal(calls.length, 0);
});

test('失败路径：文件不存在时错误里要带上路径，别只说 exit 1', { skip: !ready }, async () => {
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  await assert.rejects(
    () => definition.execute({ input: 'E:\\definitely-not-here\\nope.mp4' }, makeExec()),
    /nope\.mp4/,
  );
});

test('无音频的视频：hasAudio 必须如实为 false', { skip: !ready }, async () => {
  const silent = temp.dir + '/silent.mp4';
  const { run } = await import('./harness.mjs');
  await run([
    'ffmpeg', '-hide_banner', '-v', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1',
    '-c:v', 'mpeg4', '-q:v', '5', '-an', silent,
  ]);
  const { ctx } = makeCtx();
  const definition = makeTool(ctx, {});
  const value = await definition.execute({ input: silent, count: 1 }, makeExec());
  assert.equal(value.hasAudio, false);
});
