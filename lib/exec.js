/**
 * 进程执行层：把 DSH 官方 `ctx.subprocess` 服务包装成 Promise 式 runner。
 *
 * 三条纪律：
 *   1. **全程 argv 数组、无 shell** —— 任何用户输入都不可能变成命令注入。
 *   2. **超时永远存在** —— AbortSignal 交给宿主，由宿主做树级终止
 *      （SIGTERM → graceMs → 强杀；Windows 走 taskkill /T），不留下孤儿 ffmpeg。
 *   3. **截断必须点名** —— collect 上限被击穿时宿主保尾丢头，
 *      而 ffprobe 的 JSON 丢头必然残缺；解析前先检查 lossy/truncated，别把残缺 JSON
 *      当成"这个视频有问题"。
 *
 * @module dsh-video-see/exec
 */

import { basename } from 'node:path';

/** 单条流最多收这么多字节；ffprobe 的 JSON 与 ffmpeg 的 stderr 都远小于它。 */
const COLLECT_BYTES = 2 * 1024 * 1024;

/**
 * 构造一个 runner。
 *
 * @param spawn - `ctx.subprocess.spawn`。
 * @param options - 默认值。
 * @param options.graceMs - 终止宽限期。
 * @param options.timeoutMs - 单次调用默认超时。
 * @returns `run(argv, options)`。
 */
export function createRunner(spawn, options) {
  const defaultTimeoutMs = options?.timeoutMs ?? 120000;
  const graceMs = options?.graceMs ?? 2000;

  return async function run(argv, runOptions) {
    const timeoutMs = runOptions?.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`${programName(argv)} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const signal =
      runOptions?.signal === undefined
        ? controller.signal
        : AbortSignal.any([runOptions.signal, controller.signal]);

    try {
      const handle = spawn({
        argv,
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: COLLECT_BYTES },
          stderr: { maxBytes: COLLECT_BYTES },
        },
        graceMs,
        signal,
      });
      const outcome = await handle.done;
      // done 可能因竞态在取消之后才 resolve —— 以 signal 状态为准，不能当成功返回。
      if (signal.aborted) throw signal.reason;
      const stdout = handle.collected.stdout?.readFrom(0);
      const stderr = handle.collected.stderr?.readFrom(0);
      if (stdout?.lossy === true || stdout?.truncated === true) {
        throw new Error(`${programName(argv)} produced more than ${COLLECT_BYTES} bytes of output; it was truncated and cannot be parsed`);
      }
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal ?? null,
        stdout: stdout?.text ?? '',
        stderr: stderr?.text ?? '',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 取 argv[0] 的程序名，用于错误信息（去掉路径与 .exe）。 */
function programName(argv) {
  return basename(String(argv?.[0] ?? 'command')).replace(/\.exe$/i, '') || 'command';
}

/**
 * 解析某个可执行文件的路径：显式配置 > 环境变量 > PATH。
 *
 * 顺序刻意如此：配置文件是这台机器的事实，环境变量是进程级覆盖，
 * PATH 只是兜底——把 PATH 放前面会让"我明明配了路径"变成一句空话。
 *
 * @param configured - 配置里的值。
 * @param envNames - 依次尝试的环境变量名。
 * @param fallback - 最终兜底的可执行文件名。
 * @returns 供 argv[0] 使用的路径或名字。
 */
export function resolveExecutable(configured, envNames, fallback) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  for (const name of envNames) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return fallback;
}

/**
 * 跑一条命令并要求退出码为 0；失败时抛出**带 stderr 尾部**的错误。
 *
 * stderr 只留尾部：ffmpeg 的报错是"最后几行才说人话"，前面几十行是版本与流信息。
 *
 * @param run - {@link createRunner} 返回的 runner。
 * @param argv - 完整 argv（含程序名）。
 * @param options - `label` 用于错误前缀；其余透传给 runner。
 * @returns 成功时的 `{ stdout, stderr }`。
 */
export async function runChecked(run, argv, options) {
  const result = await run(argv, options);
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-6).join('\n').trim();
    throw new Error(
      `${options?.label ?? programName(argv)} failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''})` +
        (tail === '' ? '' : `:\n${tail}`),
    );
  }
  return result;
}
