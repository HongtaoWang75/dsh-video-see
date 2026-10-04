/**
 * 用**宿主自己的校验器**验一遍本插件的契约。
 *
 * 为什么需要一个单独的脚本：`npm test` 里跑的是**复刻版**校验器（因为插件零依赖，
 * 单测环境里拿不到 `@deepseek-ai/dsh-tools`）。复刻版能挡住绝大多数问题，
 * 但它的正确性本身没有保证——万一复刻错了，单测就是一片假绿灯。
 *
 * 这个脚本把两件事钉死：
 *   1. `assertSupportedJsonSchema` / `assertObjectJsonSchema`（真货）认我的 schema；
 *   2. `validateJsonSchemaValue`（真货）认我真实产出的返回值。
 *
 * 找得到宿主就跑，找不到就**明确跳过**（不假装通过）。
 *
 *   node scripts/verify-host-contract.mjs
 *   DSH_TOOLS_MODULE=<path to dsh-tools/lib/index.js> node scripts/verify-host-contract.mjs
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRunner } from '../lib/exec.js';
import { buildTool, resolveConfig } from '../lib/index.js';
import {
  findFfmpeg,
  hasFfmpeg,
  makeCtx,
  makeExec,
  makeTestVideo,
  withTempDir,
} from '../test/harness.mjs';

/** 依次尝试这些位置找到宿主的 dsh-tools。 */
function locateHostTools() {
  const candidates = [];
  if (process.env.DSH_TOOLS_MODULE) candidates.push(process.env.DSH_TOOLS_MODULE);
  // dsh 的全局 npm 安装位置
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    );
  }
  candidates.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
    failures.push(label);
  }
}

const hostToolsPath = locateHostTools();
if (hostToolsPath === null) {
  console.log('SKIP: 找不到宿主的 @deepseek-ai/dsh-tools —— 这一项没有验证，不是通过。');
  console.log('      用 DSH_TOOLS_MODULE=<...>/dsh-tools/lib/index.js 指定路径后重跑。');
  process.exit(0);
}
console.log(`宿主校验器：${hostToolsPath}\n`);

const host = await import(pathToFileURL(hostToolsPath).href);
for (const required of ['assertSupportedJsonSchema', 'assertObjectJsonSchema', 'validateJsonSchemaValue']) {
  if (typeof host[required] !== 'function') {
    console.log(`SKIP: 宿主的 dsh-tools 没有导出 ${required}，无法验证。`);
    process.exit(0);
  }
}

const { ctx } = makeCtx();
const cfg = resolveConfig({ ...findFfmpeg() });
const run = createRunner((spec) => ctx.subprocess.spawn(spec), { graceMs: cfg.graceMs, timeoutMs: cfg.timeoutMs });
const definition = buildTool({ ctx, run, cfg });

console.log('[1] schema 子集（真 assertSupportedJsonSchema）');
assert(definition.parameters, 'parameters');
assert(definition.output.schema, 'output.schema');
function assert(schema, label) {
  try {
    host.assertSupportedJsonSchema(schema);
    check(label, true);
  } catch (error) {
    check(label, false, String(error?.message ?? error));
  }
}

console.log('\n[2] 输出必须是对象根（真 assertObjectJsonSchema）');
try {
  host.assertObjectJsonSchema(definition.output.schema);
  check('object root', true);
} catch (error) {
  check('object root', false, String(error?.message ?? error));
}

console.log('\n[3] register() 的硬性要求：output = { schema, render }');
check('output.render 是函数', typeof definition.output?.render === 'function');
check('output.schema 是对象', typeof definition.output?.schema === 'object');

if (!(await hasFfmpeg())) {
  console.log('\nSKIP: 没有可用的 ffmpeg，跳过真跑一遍的返回值校验。');
} else {
  const temp = withTempDir();
  try {
    const video = await makeTestVideo(temp.dir, { seconds: 2, width: 320, height: 240 });
    const value = await definition.execute({ input: video, count: 4 }, makeExec());
    console.log('\n[4] 真实返回值（真 validateJsonSchemaValue）');
    const violations = host.validateJsonSchemaValue(definition.output.schema, JSON.parse(JSON.stringify(value)), 'value');
    check('返回值合规', violations.length === 0, violations.join('; '));

    console.log('\n[5] render 产物必须是无损 JSON');
    const blocks = definition.output.render({}, JSON.parse(JSON.stringify(value)));
    check('render 返回数组', Array.isArray(blocks));
    check('首块是文本', blocks[0]?.type === 'text');
    check('其余是图片块', blocks.slice(1).every((block) => block.type === 'image' && typeof block.attachment?.attachmentId === 'string'));
    check('可无损 JSON 往返', JSON.stringify(JSON.parse(JSON.stringify(blocks))) === JSON.stringify(blocks));

    console.log('\n[6] presentationMeta 产物必须是无损 JSON');
    const meta = definition.output.presentationMeta({}, JSON.parse(JSON.stringify(value)));
    check('presentationMeta 可往返', JSON.stringify(JSON.parse(JSON.stringify(meta))) === JSON.stringify(meta));
  } finally {
    temp.cleanup();
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项未通过：${failures.join('; ')}`);
  process.exit(1);
}
console.log('✓ 宿主契约全部通过');
