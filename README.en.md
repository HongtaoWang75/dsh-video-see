# dsh-video-see

**Give your DeepSeek Harness agent real eyes on video — one tool call, N real images, each labelled with its timestamp.**

[中文](README.md)

---

## The problem

Ask a DSH agent "what happens in this video?" and what it needs is the **picture**.

Today it has two options, and both are bad:

| Option | Cost |
|---|---|
| A vision-bridge plugin (frames go out to some cloud VLM, text comes back) | Another API key, another bill, and the result is **second-hand**: when you follow up with "what does that small text in the top right say?", the frames are no longer in context |
| Let the agent hand-roll ffmpeg | Rebuild the command every time, count timestamps by hand, and try not to sample past the end of the stream into an empty seek |

**This plugin takes a third path: it does not look for you, it hands you the frames.**

No external VLM. No API key. **Not one byte of the picture leaves the machine.** It does four things:

```
probe → decide which moments matter → pull those frames with ffmpeg → return them as real image blocks
```

### Why this works: DeepSeek-V41-Flash already has native vision

In the `dsh-llm-deepseek` catalog, `deepseek-flash` (display name **DeepSeek-V41-Flash**) declares
`inputModalities: ["text", "image"]` — **it can already see**. The text-only entries are
`deepseek-v4-flash` and `deepseek-v4-pro`. So for a model that already reads images, routing them
through a second model is a straight downgrade.

And DSH's image pipeline is generous (from the same package's README and source):

- `maxImagesPerRequest: 600` — six hundred images in a single request
- **384 tokens maximum per image** (the published v4 vision accounting: 14px patch grid, 3:1 downsampling)
- Uploaded through the DeepSeek Files API, with automatic base64 fallback

That means **20 frames ≈ 7,680 tokens**. Don't starve the frame count to save tokens — starve it and
you lose the answer to "when did it change?"

> **Video itself has no channel.** DSH's provider modality enum is literally `["text", "image"]`, and the
> attachment service only accepts `image/*`. So turning a video into frames is not a workaround — it is
> the only native path there is.

## Install

```bash
dsh plugin --profile web add dsh-video-see
```

Then **restart `dsh web`** (the plugin tree is composed at process start).

One prerequisite: **ffmpeg / ffprobe on PATH** (or point at them in the config below).
Zero runtime dependencies, no build step, no network.

## Use

There is nothing to memorise — just ask:

> "What happens in `D:\videos\demo.mp4`?"
> "What does the small text at 14 seconds say?"
> "How many cuts does this clip have?"

The model calls `video_see` on its own. Parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `input` | string (required) | Video path; any container ffmpeg can decode |
| `times` | array | Exact moments — seconds (`12.5`) or clock strings (`"01:30"`). **Highest priority**; overrides `every`/`count` |
| `every` | number | One frame every N seconds |
| `count` | integer | Evenly spaced frames (1–64, default 8) |
| `start` / `end` | number | Sample only inside a window |
| `width` | integer | Max width per frame (default 768); **total pixels are capped separately**, so portrait survives |
| `mode` | string | `frames` (default: one image per frame, full detail) / `sheet` (one tiled contact sheet, smallest context) |

The result is one text block plus N images:

```
<path>D:\videos\demo.mp4</path>
<type>video</type>
<content>
12.4 s, source 1080x1920 px, frames 404x718 px, audio track: present (not transcribed)
</content>
<frames>
  image 1 = 0:00.000
  image 2 = 0:01.771
  ...
</frames>
```

**`frames` or `sheet`?** Depends on the question:

- **Take in the whole clip** → `sheet`: one image, 384 tokens, cheap. Per-cell detail is low, so
  **never read small on-screen text out of a sheet**.
- **Read details** (subtitles, UI text, expressions, motion stages) → `frames`: each is also capped at
  384 tokens, so pulling a dozen is cheap. Still not enough? Ask again with `times` for that one second.

## Configuration

All optional, in your profile's `cordis.patch.yml`:

```yaml
- id: video-see
  name: dsh-video-see
  config:
    # ffmpegPath: D:\ffmpeg\bin\ffmpeg.exe    # also honours DSH_FFMPEG_PATH / FFMPEG_PATH
    # ffprobePath: D:\ffmpeg\bin\ffprobe.exe  # also honours DSH_FFPROBE_PATH / FFPROBE_PATH
    maxFrames: 64         # per-call frame cap (1-64)
    maxWidth: 768         # per-frame width cap
    maxPixels: 640000     # per-frame area cap; matches DSH's default imagePixelBudget
    quality: 3            # JPEG quality (ffmpeg -q:v, 2 best / 31 worst)
    timeoutMs: 120000     # per ffmpeg invocation
    toolTimeoutMs: 600000 # whole tool call
    graceMs: 2000         # termination grace before the hard kill
```

## Rules the code holds itself to

Every one of these has an assertion behind it:

- **Stay off the tail.** Even spacing puts the final frame exactly on `duration`, and **there is no
  frame at the duration boundary**: a 3.000 s clip's last frame sits at 2.96 (25 fps), so `-ss 3.000`
  writes nothing at all. This bites on **every single call**, so the edge is derived from the frame rate.
- **Portrait scales by area.** Capping width alone leaves 2160×4096 at 768×1456 ≈ 1.12M pixels —
  nearly double the budget.
- **No downscale means no touch.** Forcing 101 px to an even 100 px would quietly change the aspect
  ratio, so `resized: false` emits no `-vf` and returns the source dimensions untouched.
- **Honour rotation.** Phone video is often "1920×1080 encoded + 90° rotation": ffmpeg autorotates on
  decode while ffprobe reports the coded size. Planning `scale` from the coded size squashes the picture.
- **Refuse before the expensive part.** A model that does not declare image input is rejected
  **before any decoding happens**.
- **No shell.** argv arrays throughout.
- **Temp frames never touch the disk for long** (removed in `finally`).
- **Failures speak plainly.** ffprobe/ffmpeg errors carry the stderr tail, the offending frame and its timestamp.

## Tests

```bash
npm test                                  # 41 assertions: pure functions + real-ffmpeg end to end
node scripts/verify-host-contract.mjs     # validates schema and return value with the host's own validators
```

The "host" in `npm test` is a stub, but it **validates like the real one**: the attachment stub checks
JPEG magic bytes and reads real pixel dimensions, so "ffmpeg didn't actually produce a frame" blows up
in the test run. Fixtures are generated on the fly (`testsrc2` + a sine track) — no binary video in the repo.

`scripts/verify-host-contract.mjs` is a second layer: it imports
`assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue` straight out of the
host installation and checks the real thing.

> Why it exists: the schema checker inside the unit tests is a **replica** (the plugin has zero
> dependencies, so the test environment cannot reach `@deepseek-ai/dsh-tools`). If the replica is wrong,
> the unit tests are a wall of false green. And an unsupported keyword (`minimum` / `maxItems` /
> `pattern` …) is not "a tool that behaves oddly" — `ctx.tools.register()` throws during `apply()`, which
> means **the plugin fails to install at all**.

## Known limits

- **No ears.** Audio is never transcribed; `hasAudio` only reports whether a track exists.
  **Do not guess dialogue from the picture** — the tool description tells the model the same thing.
- **Not mediated by `ctx.fs`.** `input` is handed straight to ffmpeg, so the agent-side file sandbox
  does not apply to this read (same as `dsh-ffmpeg` and friends). It only ever writes inside its own
  private temp directory.
- **Frames are discrete snapshots.** Motion between frames and fleeting events are missed; use `times`
  to densify a sensitive stretch.
- **Needs ffmpeg.** Without it, nothing runs.

## License

MIT.
