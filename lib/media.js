/**
 * 媒体层：ffprobe 探测 + ffmpeg 抽帧 + 图版拼合。
 *
 * 这里只做"调命令、解析、给结果"，所有算术都在 {@link module:dsh-video-see/plan} 里，
 * 所以本文件的职责边界很清楚：**命令拼得对不对、ffprobe 的输出读得对不对**。
 *
 * @module dsh-video-see/media
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runChecked } from './exec.js';
import { formatSeconds } from './plan.js';

/** ffprobe 单次探测的超时：它只读头部，超过这个数说明文件或磁盘有问题。 */
const PROBE_TIMEOUT_MS = 60000;

/**
 * 探测一个视频。
 *
 * 注意 `rotation`：手机竖拍常是"编码尺寸 1920×1080 + 旋转 90°"，
 * ffmpeg 解码时会**自动旋转**，而 ffprobe 报的是**编码尺寸**。
 * 若拿编码尺寸去算 `scale=W:H`，旋转后的画面会被拉扁——
 * 这是个不会报错、只会安静出错的坑，所以按旋转角把宽高换过来。
 *
 * @param params - 探测参数。
 * @param params.run - {@link createRunner} 返回的 runner。
 * @param params.ffprobePath - ffprobe 可执行文件。
 * @param params.input - 视频路径。
 * @param params.signal - 取消信号。
 * @returns 归一化后的媒体信息。
 */
export async function probeVideo(params) {
  const { stdout } = await runChecked(
    params.run,
    [
      params.ffprobePath,
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      params.input,
    ],
    { label: `ffprobe ${params.input}`, timeoutMs: PROBE_TIMEOUT_MS, signal: params.signal },
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`ffprobe returned output that is not JSON for "${params.input}": ${String(error?.message ?? error)}`);
  }

  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (video === undefined) {
    throw new Error(`"${params.input}" has no video stream; video_see only reads video files`);
  }
  const audio = streams.find((stream) => stream?.codec_type === 'audio');

  const duration = readDuration(parsed, video);
  const rotation = readRotation(video);
  const coded = { width: numberOr(video.width, 0), height: numberOr(video.height, 0) };
  // 旋转 90/270 时，观众看到的宽高与编码宽高是互换的。
  const upright =
    Math.abs(rotation) % 180 === 90
      ? { width: coded.height, height: coded.width }
      : { width: coded.width, height: coded.height };

  return {
    duration,
    width: upright.width,
    height: upright.height,
    codedWidth: coded.width,
    codedHeight: coded.height,
    rotation,
    fps: parseRational(video.r_frame_rate) ?? parseRational(video.avg_frame_rate),
    videoCodec: stringOr(video.codec_name, 'unknown'),
    hasAudio: audio !== undefined,
    audioCodec: audio === undefined ? null : stringOr(audio.codec_name, 'unknown'),
    container: stringOr(parsed?.format?.format_name, 'unknown'),
  };
}

/**
 * 按给定时刻逐个抽帧。
 *
 * 用 `-ss <t> -i` 的**前置定位**（先定位再解码，快）而不是 `-i ... -ss`（解到 t 才丢，慢）：
 * 现代 ffmpeg 会从关键帧解码到精确时刻，输出仍是精确帧。
 *
 * 每个时刻一次调用而不是拼一条 `select` 滤镜：`select` 要在滤镜里解析时间表达式，
 * 出错时报的还是滤镜语法错；逐个调用既好定位，失败信息也直接指向那个时刻。
 *
 * @param params - 抽帧参数。
 * @param params.run - runner。
 * @param params.ffmpegPath - ffmpeg 可执行文件。
 * @param params.input - 视频路径。
 * @param params.times - 时刻数组（秒）。
 * @param params.size - {@link planFrameSize} 的结果；`resized:false` 时不加 `-vf`。
 * @param params.outDir - 输出目录。
 * @param params.quality - JPEG 质量（2 最好 / 31 最差）。
 * @param params.signal - 取消信号。
 * @param params.timeoutMs - 单帧超时。
 * @returns `[{ index, time, file }]`，顺序与 `times` 一致。
 */
export async function extractFrames(params) {
  const frames = [];
  for (let index = 0; index < params.times.length; index += 1) {
    const time = params.times[index];
    const file = join(params.outDir, `frame_${String(index).padStart(3, '0')}.jpg`);
    const argv = [
      params.ffmpegPath,
      '-hide_banner', '-v', 'error', '-nostdin', '-y',
      '-ss', formatSeconds(time),
      '-i', params.input,
      '-frames:v', '1',
      '-an', '-sn', '-dn',
      ...(params.size?.resized === true
        ? ['-vf', `scale=${params.size.width}:${params.size.height}`]
        : []),
      '-q:v', String(params.quality ?? 3),
      file,
    ];
    await runChecked(params.run, argv, {
      label: `ffmpeg frame @${formatSeconds(time)}`,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
    frames.push({ index, time, file });
  }
  return frames;
}

/**
 * 把已抽好的帧拼成一张图版（contact sheet）。
 *
 * 走"先落地、再按 image2 序列输入拼"而不是一条 `select`+`tile` 的大滤镜：
 * 前者每一帧都已经被验证过（能抽出来就说明解码没问题），拼合失败只可能是拼合的事；
 * 后者一旦失败，报错在滤镜语法上，根本看不出是哪一帧的问题。
 *
 * @param params - 拼合参数。
 * @param params.run - runner。
 * @param params.ffmpegPath - ffmpeg 可执行文件。
 * @param params.outDir - 序列所在目录（`frame_%03d.jpg`）。
 * @param params.outFile - 图版输出路径。
 * @param params.grid - `{ cols, rows }`。
 * @param params.signal - 取消信号。
 * @param params.timeoutMs - 超时。
 * @returns 图版文件路径。
 */
export async function composeSheet(params) {
  const { cols, rows } = params.grid;
  const argv = [
    params.ffmpegPath,
    '-hide_banner', '-v', 'error', '-nostdin', '-y',
    '-i', join(params.outDir, 'frame_%03d.jpg'),
    // padding 让格子之间有缝，读图时不会把相邻两格看成一张
    '-vf', `tile=${cols}x${rows}:padding=6:color=black`,
    '-frames:v', '1',
    '-q:v', '3',
    params.outFile,
  ];
  await runChecked(params.run, argv, {
    label: 'ffmpeg tile',
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  return params.outFile;
}

/** 读文件字节（帧很小，直接同步读，省一层异步编排）。 */
export function readFrameBytes(file) {
  return readFileSync(file);
}

/** 时长：优先 format.duration，其次视频流自身的 duration。 */
function readDuration(parsed, video) {
  const candidates = [parsed?.format?.duration, video?.duration, parsed?.format?.tags?.DURATION];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * 读旋转角（度）。ffprobe ≥ 5 放在 `side_data_list[].rotation`，
 * 旧版本放 `tags.rotate`，两者都认。
 *
 * @param video - 视频流对象。
 * @returns 归一化到 (-180, 180] 的角度；读不到返回 0。
 */
function readRotation(video) {
  const fromSideData = Array.isArray(video?.side_data_list)
    ? video.side_data_list.find((entry) => entry?.rotation !== undefined)?.rotation
    : undefined;
  const raw = fromSideData ?? video?.tags?.rotate;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  let angle = value % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return Math.round(angle);
}

/** 解析 ffmpeg 的有理数字符串（`"25/1"`、`"30000/1001"`）。 */
function parseRational(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [numerator, denominator] = value.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null;
  const result = top / bottom;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}
