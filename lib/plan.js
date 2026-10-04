/**
 * 抽帧计划——**纯函数，无 IO、无副作用**，全部边界都在这里，因此可离线断言。
 *
 * 这一层刻意不碰 ffmpeg：采样时刻与缩放尺寸是插件里唯一"算错了但不报错、
 * 只会安静给出错图"的地方（抽到 0 帧、抽到越界帧、把竖屏算出超预算的像素数、
 * 把 101px 高强行取偶成 100px 从而改了宽高比），所以它们必须能被单测钉死。
 *
 * @module dsh-video-see/plan
 */

/** 单次调用允许抽取的最大帧数——再多只会烧 token，不会多看出信息。 */
export const MAX_FRAMES = 64;
/** 显式 `times` 允许的条目上限，防止超大 JSON 参数把内存吃光。 */
export const MAX_EXPLICIT_TIMES = 4096;
/** 默认帧数：够看清一段短片的结构，又不至于让上下文变成相册。 */
export const DEFAULT_COUNT = 8;
/** 单帧宽度上限（像素）。 */
export const DEFAULT_MAX_WIDTH = 768;
/**
 * 单帧像素预算，默认与 DSH 的 `imagePixelBudget` 默认值一致（640,000）。
 * 对齐它的意义：插件缩放一次到目标，适配器就不必再缩放第二次。
 */
export const DEFAULT_MAX_PIXELS = 640000;
/** 允许的最小/最大宽度，防止 `scale` 被喂进 0 或荒唐值。 */
export const MIN_WIDTH = 32;
export const MAX_WIDTH = 4096;

/**
 * 离末尾留多远才抽得到帧。
 *
 * 这不是保守，是必须：**时长边界上没有帧**。一帧的呈现时刻是它的 PTS，
 * 3.000 秒的视频最后一帧在 2.96（25fps），`-ss 3.000` 会 seek 到流末尾之后，
 * ffmpeg 于是"一个包都没写"直接失败——而那个报错长得完全不像时间戳的问题。
 * 等分采样天然会把最后一帧落在正好的 duration 上，所以这条**每次调用都会踩**。
 *
 * @param fps - 帧率；未知时按 0.1 秒保守处理。
 * @returns 建议的末尾避让秒数。
 */
export function endEdge(fps) {
  if (Number.isFinite(fps) && fps > 0) return Math.max(1.5 / fps, 0.05);
  return 0.1;
}

/**
 * 把 `12` / `"12.5"` / `"01:30"` / `"00:01:30"` 解析成秒。
 * 认不出来一律返回 `null`（调用方决定是报错还是忽略），绝不猜。
 *
 * @param value - 待解析的值。
 * @returns 秒数，或 `null`。
 */
export function parseSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part.trim())) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

/**
 * 把秒数格式化成 `M:SS.mmm`（给模型的文本清单用，人也要读）。
 *
 * @param seconds - 秒数（负数按 0 处理）。
 * @returns 形如 `1:05.500` 的字符串。
 */
export function formatSeconds(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest);
  const millis = Math.round((rest - whole) * 1000);
  return `${minutes}:${String(whole).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * 算出**要抽哪几秒**。
 *
 * 优先级：`times`（显式点名）> `every`（等间隔）> `count`（等分，默认 {@link DEFAULT_COUNT}）。
 * 五条硬规矩：
 *   1. 每个时刻先夹进 `[start, end]`，再夹进 `[0, duration - edge]`——**越界时刻必然抽不到帧**，
 *      而 ffmpeg 那时的报错完全不像时间戳的问题。`edge` 由调用方按帧率给出（见 {@link endEdge}），
 *      默认 0（夹到 duration 为止，纯数学、不带隐藏策略）。
 *   2. 结果**排序去重**（相差 <1ms 视为同一帧）。
 *   3. 帧数封顶，且**超限时按覆盖范围抽稀、保住首尾**，而不是砍掉尾巴。
 *   4. 生成循环本身有界：`every` 取 1ms 也不会先造出千万级数组再截断。
 *   5. 时长非法（0 / NaN / 负）时返回空数组——由调用方报错，不在这里编造时间点。
 *
 * @param options - 计划参数。
 * @param options.duration - 视频时长（秒）。
 * @param options.times - 显式时刻（秒或时间串）。
 * @param options.every - 等间隔秒数。
 * @param options.count - 等分帧数。
 * @param options.start - 窗口起点（秒）。
 * @param options.end - 窗口终点（秒）。
 * @param options.edge - 末尾避让秒数，通常传 {@link endEdge} 的结果。
 * @param options.max - 帧数上限，默认 {@link MAX_FRAMES}。
 * @returns 升序、去重、已夹紧的时刻数组（秒）。
 */
export function planTimes(options) {
  const duration = options?.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return [];
  const max = normalizeMax(options.max);
  const edge = Number.isFinite(options.edge) && options.edge > 0 ? options.edge : 0;
  // 这就是"最后一个还抽得到帧的时刻"。视频极短时退化成 0（只取一帧），不返回空。
  const limit = Math.max(0, duration - edge);

  let start = clamp(finiteOr(options.start, 0), 0, limit);
  let end = clamp(finiteOr(options.end, duration), 0, limit);
  if (end < start) [start, end] = [end, start];
  const span = end - start;

  const explicit = normalizeTimes(options.times);
  if (explicit.length > 0) {
    return finalize(explicit.map((time) => clamp(time, 0, limit)), max);
  }

  const every = options.every;
  if (typeof every === 'number' && Number.isFinite(every) && every > 0) {
    const steps = Math.floor(span / every) + 1;
    // 先算个数再决定要不要展开：steps 可能是 1e12，展开了就 OOM。
    if (!Number.isFinite(steps) || steps > max) return finalize(uniform(start, end, max), max);
    const times = [];
    for (let index = 0; index < steps; index += 1) times.push(start + index * every);
    return finalize(times, max);
  }

  const count = normalizeCount(options.count);
  if (count === 1) return finalize([start + span / 2], max);
  return finalize(uniform(start, end, count), max);
}

/**
 * 算出**每帧缩放到多大**。
 *
 * 宽度与**面积**两个约束同时满足：只卡宽度的话，2160×4096 的竖屏缩到 768 宽
 * 仍有 768×1456 ≈ 1.1M 像素，超预算近一倍——竖屏视频正是在这里翻车的。
 *
 * 不需要缩小时返回 `resized: false` 且宽高**原样返回**（连取偶都不做）：
 * 对 101px 高的图强行取偶会悄悄改掉宽高比，而调用方据此决定要不要传 `-vf`。
 *
 * @param sourceWidth - 源宽。
 * @param sourceHeight - 源高。
 * @param options - 约束。
 * @param options.maxWidth - 宽度上限。
 * @param options.maxPixels - 面积上限。
 * @returns `{ width, height, resized }`。
 */
export function planFrameSize(sourceWidth, sourceHeight, options) {
  const width = toPositiveInt(sourceWidth);
  const height = toPositiveInt(sourceHeight);
  if (width === null || height === null) return { width: 1, height: 1, resized: false };

  const maxWidth = clamp(normalizeMaxWidth(options?.maxWidth), MIN_WIDTH, MAX_WIDTH);
  const maxPixels = clamp(
    Number.isFinite(options?.maxPixels) && options.maxPixels > 0
      ? Math.floor(options.maxPixels)
      : DEFAULT_MAX_PIXELS,
    1,
    MAX_WIDTH * MAX_WIDTH,
  );

  const scale = Math.min(1, maxWidth / width, Math.sqrt(maxPixels / (width * height)));
  if (scale >= 1) return { width, height, resized: false };

  // 直接拿**取偶后的最终尺寸**比对预算：不存在估算误差，所以不需要留余量。
  let outWidth = toEven(Math.max(1, Math.floor(width * scale)));
  let outHeight = toEven(Math.max(1, Math.round((outWidth * height) / width)));
  // 取偶只可能把尺寸变大，所以这一步收缩是必需的，不能省。
  while (outWidth * outHeight > maxPixels && outWidth > 2) {
    outWidth = toEven(outWidth - 2);
    outHeight = toEven(Math.max(1, Math.round((outWidth * height) / width)));
  }
  return { width: outWidth, height: outHeight, resized: true };
}

/**
 * 把 `count` 张图排成网格（contact sheet 用）。
 * 取最接近正方的一对因数，多出来的格子留空（ffmpeg `tile` 默认补黑）。
 *
 * @param count - 帧数。
 * @returns `{ cols, rows }`。
 */
export function planGrid(count) {
  const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  let cols = Math.ceil(Math.sqrt(total));
  while (cols > 1 && Math.ceil(total / cols) * (cols - 1) >= total) cols -= 1;
  const rows = Math.ceil(total / cols);
  return { cols, rows };
}

/** 窗口内等分 n 个时刻（n=1 时取中点）。 */
function uniform(start, end, n) {
  if (n <= 1) return [start + (end - start) / 2];
  const out = [];
  for (let index = 0; index < n; index += 1) {
    out.push(start + ((end - start) * index) / (n - 1));
  }
  return out;
}

/** 排序 → 去重（1ms 内算同一帧）→ 超限抽稀（保首尾）。 */
function finalize(times, max) {
  const sorted = [...times].sort((a, b) => a - b);
  const out = [];
  for (const time of sorted) {
    if (out.length > 0 && Math.abs(time - out[out.length - 1]) < 0.001) continue;
    out.push(time);
  }
  if (out.length <= max) return out;
  if (max <= 1) return [out[0]];
  const thinned = [];
  for (let index = 0; index < max; index += 1) {
    thinned.push(out[Math.round((index * (out.length - 1)) / (max - 1))]);
  }
  return [...new Set(thinned)];
}

function normalizeMax(value) {
  if (!Number.isFinite(value) || value <= 0) return MAX_FRAMES;
  return clamp(Math.floor(value), 1, MAX_FRAMES);
}

function normalizeCount(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_COUNT;
  return clamp(Math.floor(value), 1, MAX_FRAMES);
}

function normalizeMaxWidth(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_WIDTH;
  return Math.floor(value);
}

/** 解析显式时刻列表：丢掉认不出来的项，并限制总条数。 */
function normalizeTimes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_EXPLICIT_TIMES) break;
    const seconds = parseSeconds(item);
    if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) out.push(seconds);
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function toPositiveInt(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
}

/** 取偶；1 和 2 原样返回，避免退化成 0。 */
function toEven(value) {
  const rounded = Math.max(1, Math.round(value));
  return rounded <= 2 ? rounded : rounded - (rounded % 2);
}
