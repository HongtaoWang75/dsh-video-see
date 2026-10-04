/**
 * `.mjs` 测试台：一套**够用的假宿主**，让工具定义能在没有 DSH 的情况下被真实驱动。
 *
 * 三条设计原则：
 *   1. **假的是宿主，不是被测物。** ffmpeg/ffprobe 走真的 `child_process.spawn`，
 *      视频是真的、帧是真的、JPEG 是真的——只有 DSH 的三个服务是桩件。
 *   2. **桩件要按契约校验。** 附件桩会像真服务那样检查 JPEG 魔数、读出真实像素尺寸，
 *      所以"ffmpeg 其实没抽出图"这种事故在测试里就会炸，而不是等到线上。
 *   3. **schema 要真校验。** 真宿主会做两件事：`register()` 时用
 *      `assertSupportedJsonSchema` 卡 schema 子集，成功后用 `validateJsonSchemaValue`
 *      卡返回值。测试里两个都有等价物——否则"用了一个不支持的 JSON Schema 关键字"
 *      这类错误会让插件**在加载时**就炸掉整棵插件树，而单测却一路绿灯。
 *
 * @module dsh-video-see/test/harness
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 用真的 `child_process` 实现 DSH 的 `ctx.subprocess.spawn` 契约。
 *
 * @param calls - 记录每次调用的数组（测试据此断言"到底跑没跑 ffmpeg"）。
 * @returns `spawn(spec)`。
 */
export function makeStubSpawn(calls = []) {
  return function spawnStub(spec) {
    calls.push([...spec.argv]);
    const [file, ...args] = spec.argv;
    const child = spawn(file, args, {
      cwd: spec.cwd ?? process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) child.kill();
      else spec.signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    return {
      done: new Promise((resolve) => {
        child.on('error', () => resolve({ exitCode: 127, signal: null }));
        child.on('close', (code, signal) => resolve({ exitCode: code ?? 0, signal: signal ?? null }));
      }),
      collected: {
        stdout: { readFrom: () => readStream(out) },
        stderr: { readFrom: () => readStream(err) },
      },
    };
  };
}

function readStream(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  return { text, lossy: false, truncated: false, bytes: text.length };
}

/**
 * 附件服务桩：像真服务那样**先整批校验再给出引用**，并解析真实像素尺寸。
 *
 * @returns `{ saveImages, saved }`。
 */
export function makeStubAttachments() {
  const saved = [];
  return {
    saved,
    async saveImages(inputs) {
      if (inputs.length > 64) throw new Error('stub: image batch exceeds the per-message limit');
      for (const input of inputs) assertJpeg(input.data);
      const refs = inputs.map((input, index) => {
        const size = readJpegSize(input.data);
        const ref = {
          attachmentId: `stub-${saved.length + index}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: size.width,
          height: size.height,
        };
        return ref;
      });
      saved.push(...refs);
      return refs;
    },
  };
}

function assertJpeg(data) {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error('stub: attachment bytes are not a JPEG (the extractor produced something else)');
  }
}

/**
 * 从 JPEG 字节里读出真实像素尺寸（走 SOF 段）。
 * 之所以不调 ffprobe：这里要验证的正是"ffmpeg 抽出来的图到底多大"，
 * 用同一个工具去验证自己会让断言失去意义。
 *
 * @param data - JPEG 字节。
 * @returns `{ width, height }`。
 */
export function readJpegSize(data) {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    // SOF0..SOF15，排除 DHT(c4) / JPG(c8) / DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);
      return { width, height };
    }
    const length = data.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error('stub: no SOF marker found in the JPEG');
}

/**
 * 造一个假 ctx：三个服务齐全，`get('llm')` 的行为可注入。
 *
 * @param options - 桩件选项。
 * @returns `{ ctx, calls, attachments }`。
 */
export function makeCtx(options = {}) {
  const calls = [];
  const attachments = options.attachments ?? makeStubAttachments();
  const services = {
    subprocess: { spawn: makeStubSpawn(calls) },
    attachments,
  };
  return {
    calls,
    attachments,
    ctx: {
      subprocess: services.subprocess,
      tools: {
        register(definition) {
          return () => {};
        },
      },
      get(serviceName) {
        if (serviceName === 'llm') return options.llm;
        return services[serviceName];
      },
    },
  };
}

/** 造一个假 agent：路由成对出现，供图片能力门使用。 */
export function makeExec(options = {}) {
  return {
    signal: options.signal,
    agent: {
      options: { provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-flash' },
      session: { requestHeader: () => undefined },
    },
  };
}

/** 真宿主 `assertSupportedJsonSchema` 允许的关键字子集。 */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
/** 纯注释关键字：值必须是无损 JSON，但不参与校验。 */
const ANNOTATION_KEYWORDS = new Set(['title', 'description', 'default', 'examples', '$comment']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * 复刻真宿主的 `assertSupportedJsonSchema`：**只允许那个子集**。
 *
 * 这条断言比看上去重要：`ctx.tools.register()` 在插件 `apply()` 期间就会调用它，
 * 抛错 → 这条 fiber 失败 → 启动审计把整个插件树报成 "Failed to load plugins"。
 * 也就是说用了一个不支持的 JSON Schema 关键字（`minimum` / `maxItems` / `pattern` …）
 * 不是"工具不好用"，而是**插件装不上**，所以必须在单测里挡住。
 *
 * @param schema - 待检查的 schema。
 * @param path - 诊断路径。
 * @returns 违约描述数组。
 */
export function checkSchemaSubset(schema, path = 'schema') {
  const violations = [];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} must be a schema object`];
  }
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  if (hasType && hasOneOf) return [...violations, `${path} cannot declare both type and oneOf`];
  if (!hasType && !hasOneOf) return violations;

  if (hasOneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`);
    } else {
      schema.oneOf.forEach((child, index) => {
        violations.push(...checkSchemaSubset(child, `${path}.oneOf[${index}]`));
      });
    }
    return violations;
  }

  const type = schema.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    violations.push(`${path}.type must be one of ${[...SCHEMA_TYPES].join('/')}`);
    return violations;
  }
  const onlyOn = { properties: 'object', required: 'object', additionalProperties: 'object', items: 'array' };
  for (const [key, owner] of Object.entries(onlyOn)) {
    if (Object.hasOwn(schema, key) && type !== owner) violations.push(`${path}.${key} is not supported on type "${type}"`);
  }
  if ((Object.hasOwn(schema, 'enum') || Object.hasOwn(schema, 'const')) && !['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    violations.push(`${path}.enum is not supported on type "${type}"`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    violations.push(...checkSchemaSubset(child, `${path}.properties.${key}`));
  }
  if (schema.items !== undefined) violations.push(...checkSchemaSubset(schema.items, `${path}.items`));
  return violations;
}

/**
 * 校验一个值是否符合已声明的 schema —— **只支持本插件用到的那个子集**
 * （type / oneOf / properties / required / additionalProperties / items / enum）。
 *
 * 真宿主用 `validateJsonSchemaValue` 做同样的事；这个等价物存在的意义是
 * 让"返回值多带了一个键"在 `npm test` 里就暴露，而不是等运行时抛 `ToolOutputError`。
 *
 * @param schema - 已声明的 schema。
 * @param value - 待校验的值。
 * @param path - 诊断路径前缀。
 * @returns 违约描述数组（空数组 = 通过）。
 */
export function validateAgainstSchema(schema, value, path = 'value') {
  const violations = [];
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((child) => validateAgainstSchema(child, value, path).length === 0);
    return matched.length === 1 ? [] : [`${path} must match exactly one of the oneOf branches (matched ${matched.length})`];
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path} must be an object`];
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${path}.${key} is not declared`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      violations.push(...validateAgainstSchema(child, value[key], `${path}.${key}`));
    }
    return violations;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    value.forEach((item, index) => {
      violations.push(...validateAgainstSchema(schema.items ?? {}, item, `${path}[${index}]`));
    });
    return violations;
  }
  if (schema.type === 'string' && typeof value !== 'string') return [`${path} must be a string`];
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return [`${path} must be a finite number`];
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path} must be an integer`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path} must be a boolean`];
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return [`${path} must be one of ${schema.enum.join('/')}`];
  }
  return violations;
}

/** 找一个可用的 ffmpeg/ffprobe 对；找不到就返回 null（测试据此跳过）。 */
export function findFfmpeg() {
  const explicit = process.env.DSH_FFMPEG_PATH;
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) {
    return { ffmpeg: explicit, ffprobe: process.env.DSH_FFPROBE_PATH ?? 'ffprobe' };
  }
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
}

/**
 * 用 ffmpeg 现造一段测试视频——测试因此**不需要二进制素材**，
 * 也就不会出现"素材躺在仓库里、几年后没人知道它是什么"的情况。
 *
 * @param dir - 输出目录。
 * @param options - 时长与尺寸。
 * @returns 视频路径；失败时抛错（由调用方决定跳过）。
 */
export async function makeTestVideo(dir, options = {}) {
  const seconds = options.seconds ?? 3;
  const width = options.width ?? 320;
  const height = options.height ?? 240;
  const file = join(dir, 'fixture.mp4');
  const argv = [
    'ffmpeg', '-hide_banner', '-v', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'mpeg4', '-q:v', '5',
    '-c:a', 'aac', '-shortest',
    file,
  ];
  await run(argv);
  return file;
}

/** 直接跑一条命令（测试自带，不走被测代码）。 */
export function run(argv, cwd) {
  return new Promise((resolve, reject) => {
    const [file, ...args] = argv;
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const err = [];
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(-400)}`));
    });
  });
}

/** 建一个用完即删的临时目录。 */
export function withTempDir(prefix = 'dsh-video-see-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 环境里有没有可用的 ffmpeg。 */
export async function hasFfmpeg() {
  try {
    await run(['ffmpeg', '-hide_banner', '-version']);
    await run(['ffprobe', '-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}
