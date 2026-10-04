/**
 * dsh-video-see —— 给 DSH agent 的**原生视觉**装上一双看视频的眼睛。
 *
 * 它只做一件事，但是把它做成**一次调用**：
 *
 *     video_see(path)  →  若干帧，作为真正的 image 内容块，连同各自的时间戳
 *
 * 为什么是"原生视觉"而不是"视觉桥"：本插件**不调用任何外部 VLM、不需要任何 API key、
 * 不把画面发到任何地方**。它只负责用 ffmpeg 把视频拆成帧、把帧提交成 DSH 附件，
 * 剩下的"看"由调用它的模型自己做——所以追问（"右上角那行小字写的什么"）
 * 可以用同一批帧继续问，而不是被一段有损的文字摘要挡在中间。
 *
 * 宿主半边存在的意义：让本包成为 cordis 树上的一行，
 * 否则工具不会被注册进模型可见的工具表。
 *
 * @module dsh-video-see
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createRunner, resolveExecutable } from './exec.js';
import { composeSheet, extractFrames, probeVideo, readFrameBytes } from './media.js';
import {
  DEFAULT_COUNT,
  DEFAULT_MAX_PIXELS,
  DEFAULT_MAX_WIDTH,
  MAX_FRAMES,
  endEdge,
  formatSeconds,
  planFrameSize,
  planGrid,
  planTimes,
} from './plan.js';

export const name = 'video-see';

/**
 * 依赖的宿主服务。三个都是**确定存在**的核心服务：
 * 声明一个从未被 provide 的服务会让这条 fiber 停在 PENDING，从而拖累整棵插件树。
 */
export const inject = ['subprocess', 'tools', 'attachments'];

/** 工具名。 */
export const TOOL_NAME = 'video_see';

/** 上传给附件服务的媒体类型：JPEG 足够看清画面，体积又远小于 PNG。 */
const MEDIA_TYPE = 'image/jpeg';

/** 抽帧默认 JPEG 质量（ffmpeg `-q:v`，2 最好 / 31 最差）。 */
const DEFAULT_QUALITY = 3;

/**
 * 注册工具。
 *
 * @param ctx - 宿主上下文（至少含 subprocess / tools / attachments）。
 * @param config - 插件配置，见 README；全部可缺省。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const run = createRunner((spec) => ctx.subprocess.spawn(spec), {
    graceMs: cfg.graceMs,
    timeoutMs: cfg.timeoutMs,
  });

  const dispose = ctx.tools.register(buildTool({ ctx, run, cfg }));
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        dispose();
      } catch {
        /* 卸载期的清理失败不该再抛出去 */
      }
    });
  }
}

/**
 * 构造工具定义。
 *
 * 导出出来是为了让测试能在**没有宿主**的情况下拿到同一份定义并驱动它——
 * 定义本身就是契约，测试必须打在这个契约上，而不是打在某个副本上。
 *
 * @param deps - 依赖。
 * @param deps.ctx - 宿主上下文。
 * @param deps.run - 进程 runner。
 * @param deps.cfg - 已归一化的配置。
 * @returns 可直接交给 `ctx.tools.register` 的定义。
 */
export function buildTool(deps) {
  const { ctx, run, cfg } = deps;

  return {
    name: TOOL_NAME,
    description:
      'Look at a video with your own eyes: sample frames with ffmpeg and return them as real images, ' +
      'each labelled with its timestamp. Use it whenever a question is about what a video shows. ' +
      'Reads the visual track only — there is no audio transcription, so never claim what was said. ' +
      'Frames are returned in one call: ask for more (or a tighter window) rather than guessing from a single frame.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: {
          type: 'string',
          description: 'Path to the video file, resolved by the process working directory. Any container ffmpeg can decode (mp4/mkv/mov/webm/avi/…).',
        },
        times: {
          type: 'array',
          // 同时收数字与字符串：模型很自然地会写 [12.5, 30]，而只声明 string 的话
          // 参数校验会在插件代码跑起来之前就把这次调用拒掉——报错还落在"类型不对"上，
          // 完全看不出它本来是个合法请求。
          items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          description: 'Exact moments to grab, as seconds (12.5) or clock strings ("01:30"). Overrides every/count. Moments past the end are pulled back inside the file, so a typo yields the last frame rather than an error.',
        },
        every: {
          type: 'number',
          description: 'One frame every N seconds across the window. Ignored when times is given.',
        },
        count: {
          type: 'integer',
          description: `How many evenly spaced frames to grab (1-${MAX_FRAMES}, default ${DEFAULT_COUNT}) when neither times nor every is given.`,
        },
        start: { type: 'number', description: 'Window start in seconds (default 0).' },
        end: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        width: {
          type: 'integer',
          description: `Maximum width per frame in pixels (default ${DEFAULT_MAX_WIDTH}). Total pixels are capped separately, so tall/portrait video is handled too.`,
        },
        mode: {
          type: 'string',
          enum: ['frames', 'sheet'],
          description:
            'frames (default): one image block per frame, full detail — best for reading what is on screen. ' +
            'sheet: a single contact sheet with every frame tiled in reading order — cheapest way to take in a whole clip at once, but per-cell detail is low.',
        },
      },
      required: ['input'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          mode: { type: 'string', enum: ['frames', 'sheet'] },
          durationSeconds: { type: 'number' },
          sourceWidth: { type: 'integer' },
          sourceHeight: { type: 'integer' },
          frameWidth: { type: 'integer' },
          frameHeight: { type: 'integer' },
          hasAudio: { type: 'boolean' },
          grid: {
            type: 'object',
            additionalProperties: false,
            properties: { cols: { type: 'integer' }, rows: { type: 'integer' } },
            required: ['cols', 'rows'],
          },
          // 采样的时刻表。图版模式下必须靠它才能把"第几格 = 第几秒"说清楚——
          // value.frames 那时只有一张图，推不出格子映射。
          sampledTimes: { type: 'array', items: { type: 'number' } },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'number' },
                label: { type: 'string' },
                image: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    attachmentId: { type: 'string' },
                    mediaType: { type: 'string' },
                    bytes: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
                },
              },
              required: ['time', 'label', 'image'],
            },
          },
        },
        required: [
          'path',
          'mode',
          'durationSeconds',
          'sourceWidth',
          'sourceHeight',
          'frameWidth',
          'frameHeight',
          'hasAudio',
          'sampledTimes',
          'frames',
        ],
      },
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => ({
        path: value.path,
        mode: value.mode,
        frames: value.frames.length,
      }),
    },
    timeoutMs: cfg.toolTimeoutMs,
    // 每次调用都写自己的临时目录，彼此不共享任何可变状态。
    isConcurrencySafe: () => true,
    presentCall(args) {
      return {
        card: 'generic',
        title: `Look at video ${basename(String(args?.input ?? ''))}`,
        kind: 'read',
        locations: [{ path: String(args?.input ?? '') }],
      };
    },
    async execute(args, exec) {
      return execute({ args, exec, ctx, run, cfg });
    },
  };
}

/**
 * 工具主体。
 *
 * 顺序刻意是"**先挡、再算、最后干重活**"：
 *   1. 先判路由能不能收图 —— 收不了就直接拒绝，不做任何解码；
 *   2. 再探测 + 算计划 —— 全是便宜操作；
 *   3. 最后才抽帧、拼图、提交附件。
 * 反过来写的话，一个不支持图片的模型会让 ffmpeg 白跑一趟才收到错误。
 */
async function execute(params) {
  const { args, exec, ctx, run, cfg } = params;

  const input = typeof args?.input === 'string' ? args.input.trim() : '';
  if (input === '') throw new Error('input must be a non-empty path to a video file');

  await assertImageCapableRoute(ctx, exec);

  const signal = exec?.signal;
  const info = await probeVideo({ run, ffprobePath: cfg.ffprobePath, input, signal });

  const times = planTimes({
    duration: info.duration,
    times: args.times,
    every: args.every,
    count: args.count,
    start: args.start,
    end: args.end,
    // 不留这一手的话，等分采样会把最后一帧正好落在 duration 上，
    // 而时长边界上没有帧——每次调用都会在最后一帧失败。
    edge: endEdge(info.fps),
    max: cfg.maxFrames,
  });
  if (times.length === 0) {
    throw new Error(
      `no frame could be planned for "${input}": its duration is ${info.duration} s, ` +
        'so there is no time inside the file to sample. Check that the path points at a real video.',
    );
  }

  const size = planFrameSize(info.width, info.height, {
    maxWidth: args.width ?? cfg.maxWidth,
    maxPixels: cfg.maxPixels,
  });
  const mode = args.mode === 'sheet' ? 'sheet' : 'frames';
  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('no attachment service is mounted, so frames cannot be handed back as images');

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-video-see-'));
  try {
    const extracted = await extractFrames({
      run,
      ffmpegPath: cfg.ffmpegPath,
      input,
      times,
      size,
      outDir: workDir,
      quality: cfg.quality,
      signal,
      timeoutMs: cfg.timeoutMs,
    });

    const grid = mode === 'sheet' ? planGrid(extracted.length) : null;
    const artifacts =
      mode === 'sheet'
        ? [
            {
              time: extracted[0].time,
              label: 'contact sheet',
              file: await composeSheet({
                run,
                ffmpegPath: cfg.ffmpegPath,
                outDir: workDir,
                outFile: join(workDir, 'sheet.jpg'),
                grid,
                signal,
                timeoutMs: cfg.timeoutMs,
              }),
            },
          ]
        : extracted;

    // saveImages 会**先整批校验再落盘**，所以不存在"提交了一半"的中间态。
    const refs = await attachments.saveImages(
      artifacts.map((artifact) => ({
        data: readFrameBytes(artifact.file),
        mediaType: MEDIA_TYPE,
        name: basename(artifact.file),
      })),
    );
    // 引用与产物必须一一对应：不对应就会往返回值里塞 undefined，
    // 而返回值要求无损 JSON——那时抛的是 generic 的快照错误，看不出根因。
    if (refs.length !== artifacts.length) {
      throw new Error(
        `attachment service returned ${refs.length} references for ${artifacts.length} frames; ` +
          'refusing to return a partial result',
      );
    }

    const images = refs.map(toImageValue);
    const value = {
      path: input,
      mode,
      durationSeconds: round(info.duration, 3),
      sourceWidth: info.width,
      sourceHeight: info.height,
      frameWidth: images[0]?.width ?? size.width,
      frameHeight: images[0]?.height ?? size.height,
      hasAudio: info.hasAudio,
      sampledTimes: times.map((time) => round(time, 3)),
      frames: artifacts.map((artifact, index) => ({
        time: round(artifact.time, 3),
        // 图版模式这一格装的是拼合图本身，不是某一时刻的单帧，
        // 所以标签必须说清它是什么，否则轨迹页里会显示成一个莫名其妙的时刻。
        label: mode === 'sheet' ? `contact sheet of ${times.length} frames` : formatSeconds(artifact.time),
        image: images[index],
      })),
    };
    if (grid !== null) value.grid = grid;
    return value;
  } finally {
    // 临时帧只是中转，绝不留在盘上——附件服务已经持有自己的副本。
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 把附件引用裁成 schema 允许的字段。
 *
 * 必须显式挑字段而不是展开 `ref`：`output.schema` 是 `additionalProperties: false`，
 * 多带一个未声明的键就会被 `validateJsonSchemaValue` 判为违约、整次调用报错。
 *
 * @param ref - `attachments.saveImages` 返回的引用。
 * @returns 提交给模型的值。
 */
function toImageValue(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: String(ref.mediaType),
    bytes: Math.round(Number(ref.bytes) || 0),
    width: Math.round(Number(ref.width) || 0),
    height: Math.round(Number(ref.height) || 0),
  };
}

/**
 * 渲染成模型可见的内容块：**一段文本 + N 张真图**。
 *
 * 文本那一块的职责是把"第几张 = 第几秒"钉死。图版模式尤其重要——
 * 格子是行优先排的，不写清楚的话模型只能猜哪个格子对应哪一秒。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderContent(value) {
  const head = [
    `<path>${value.path}</path>`,
    `<type>video</type>`,
    '<content>',
    `${value.durationSeconds} s, source ${value.sourceWidth}x${value.sourceHeight} px, ` +
      `frames ${value.frameWidth}x${value.frameHeight} px, audio track: ${value.hasAudio ? 'present (not transcribed)' : 'none'}`,
    '</content>',
  ];

  if (value.mode === 'sheet') {
    const grid = value.grid ?? { cols: value.sampledTimes.length, rows: 1 };
    head.push(
      `<contact-sheet cols="${grid.cols}" rows="${grid.rows}">`,
      'One image holds every sampled frame, tiled in reading order (left to right, then top to bottom).',
      'Cell k holds the frame sampled at the k-th timestamp:',
      ...value.sampledTimes.map((time, index) => `  cell ${index + 1} = ${formatSeconds(time)}`),
      'When the frame count does not fill the grid, the trailing cells are black padding — not video content.',
      '</contact-sheet>',
    );
  } else {
    head.push(
      '<frames>',
      ...value.frames.map((frame, index) => `  image ${index + 1} = ${frame.label}`),
      '</frames>',
    );
  }

  const blocks = [{ type: 'text', text: head.join('\n') }];
  for (const frame of value.frames) blocks.push({ type: 'image', attachment: { ...frame.image } });
  return blocks;
}

/**
 * 判断调用方模型是否声明了图片输入——**在动 ffmpeg 之前**。
 *
 * 与 `read_image` 同一条理由：一个只能交图、不能交文字的工具，
 * 在收不了图的模型上跑完一整轮解码再失败，是纯粹的浪费。
 *
 * 但这里比 `read_image` 宽松一档：**取不到路由信息时放行**。
 * `read_image` 取不到就拒绝，是因为它只做一次本地读，代价为零；
 * 而我们后面要做的是解码整段视频。不过"取不到"和"取到了、明确说不能收图"
 * 是两件事——前者在子代理 / headless 等场景很常见，一律拒绝会让工具在这些地方
 * 直接不可用，所以只在**拿到明确否定**时拒绝。
 *
 * @param ctx - 宿主上下文。
 * @param exec - 工具执行上下文。
 */
async function assertImageCapableRoute(ctx, exec) {
  let llm;
  try {
    llm = ctx.get('llm');
  } catch {
    return;
  }
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return;

  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (provider === undefined || model === undefined) return;

  let active;
  try {
    active = await llm.resolveModelInfo(provider, model, exec?.signal);
  } catch {
    return;
  }
  const modalities = active?.inputModalities;
  if (modalities === undefined) return;
  if (!modalities.includes('image')) {
    throw new Error(
      `cannot look at video for model "${model}": it does not declare image input, ` +
        'and video_see returns frames as images. Switch to an image-capable model to use it.',
    );
  }
}

/**
 * 归一化配置。全部有默认值，所以配置缺失时插件照常加载。
 *
 * @param config - 原始配置（可缺省）。
 * @returns 归一化后的配置。
 */
export function resolveConfig(config) {
  const raw = config ?? {};
  return {
    ffmpegPath: resolveExecutable(raw.ffmpegPath, ['DSH_FFMPEG_PATH', 'FFMPEG_PATH'], 'ffmpeg'),
    ffprobePath: resolveExecutable(raw.ffprobePath, ['DSH_FFPROBE_PATH', 'FFPROBE_PATH'], 'ffprobe'),
    maxFrames: clampInt(raw.maxFrames, 1, MAX_FRAMES, MAX_FRAMES),
    maxWidth: clampInt(raw.maxWidth, 32, 4096, DEFAULT_MAX_WIDTH),
    maxPixels: clampInt(raw.maxPixels, 1, 4096 * 4096, DEFAULT_MAX_PIXELS),
    quality: clampInt(raw.quality, 2, 31, DEFAULT_QUALITY),
    timeoutMs: clampInt(raw.timeoutMs, 1000, 3600000, 120000),
    toolTimeoutMs: clampInt(raw.toolTimeoutMs, 1000, 3600000, 600000),
    graceMs: clampInt(raw.graceMs, 100, 30000, 2000),
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

export { planFrameSize, planGrid, planTimes } from './plan.js';
