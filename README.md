# dsh-video-see

**让你的 DSH agent 用自己的眼睛看视频 —— 一次调用，拿到若干帧真图，每张带时间戳。**

[English](README.en.md)

---

## 它解决什么问题

你在 DSH 里问「这条视频讲了什么」，agent 需要的是**画面**。

现在能拿到的方案基本只有两类：

| 方案 | 代价 |
|---|---|
| 视觉桥插件（把帧发给另一个云端 VLM，只把文字结论还回来） | 多一个 API key、多一笔钱，而且**结论是二手的**：追问「右上角那行小字写的什么」时，帧已经不在上下文里了 |
| 让 agent 自己敲 ffmpeg | 每次都要重新拼命令、自己数时间戳、自己保证别抽到时长边界外的空帧 |

**这个插件走第三条路：不替你看，只把帧交到你手里。**

它不调用任何外部 VLM、不需要任何 API key、**画面一个字节都不出本机**。它只做四件事：

```
探测 → 算该看哪几帧 → 用 ffmpeg 抽出来 → 作为真正的 image 内容块交回模型
```

### 为什么这行得通：DeepSeek-V41-Flash 原生带视觉

`dsh-llm-deepseek` 的模型目录里，`deepseek-flash`（显示名 **DeepSeek-V41-Flash**）声明的是
`inputModalities: ["text", "image"]`——**它本来就看得见图**，纯文本的是 `deepseek-v4-flash`
和 `deepseek-v4-pro`。所以对一个已经能读图的模型，"再找个模型替它读"是净亏。

而且 DSH 的图片管线相当宽（同一个包的 README 与源码）：

- `maxImagesPerRequest: 600` —— 单次请求可以带 600 张图
- **单图 token 上限 384**（官方 v4 视觉计量：14px patch 网格、3:1 降采样）
- 走 DeepSeek Files API 上传，失败自动回落 base64

也就是说 **20 帧 ≈ 7,680 token**。别为了省帧数牺牲掉"到底发生了什么时候变了"。

> **视频本身没有通道。** DSH 的 provider 模态枚举写死 `["text", "image"]`，
> 附件服务也只认 `image/*`。所以「拆成帧」不是退而求其次，而是当前唯一的原生路径。

## 装

```bash
dsh plugin --profile web add dsh-video-see
```

装完**重启 `dsh web`**（插件树在进程启动时组合）。

前置条件只有一个：**ffmpeg / ffprobe 在 PATH 上**（或按下面的配置指定绝对路径）。
插件**零运行时依赖**，没有构建步骤，也不联网。

## 用

装上之后不需要记命令，直接问：

> 「`D:\videos\demo.mp4` 里发生了什么？」
> 「第 14 秒画面上那行小字写的是什么？」
> 「这条片子剪了几个镜头？」

模型会自己调 `video_see`。参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `input` | string（必填） | 视频路径，ffmpeg 能解的容器都行 |
| `times` | array | 定点抽取，秒数（`12.5`）或时钟串（`"01:30"`）都收。**优先级最高**，给了它就忽略 `every`/`count` |
| `every` | number | 每 N 秒一帧 |
| `count` | integer | 等分抽几帧（1–64，默认 8） |
| `start` / `end` | number | 只采样一个时间窗 |
| `width` | integer | 单帧宽度上限（默认 768）；**面积另有上限**，竖屏也守得住 |
| `mode` | string | `frames`（默认，一帧一张图，细节最全）/ `sheet`（拼成一张图版，最省上下文） |

返回值是一段文本 + N 张图：

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

**`frames` 还是 `sheet`？** 看你要干什么：

- **先摸清全片结构** → `sheet`：一张图，每格一帧，384 token 封顶，便宜。
  代价是每格分辨率低，**别在图版里认小字**。
- **要看细节**（字幕、UI 文字、人物表情、动作阶段） → `frames`：每张也才 384 token，
  直接抽十几张，一点不贵。看不清就再加一档 `times` 单独看那一秒。

## 配置

全部可选，写在你 profile 的 `cordis.patch.yml` 里：

```yaml
- id: video-see
  name: dsh-video-see
  config:
    # ffmpegPath: D:\ffmpeg\bin\ffmpeg.exe    # 不在 PATH 时指定；也认 DSH_FFMPEG_PATH / FFMPEG_PATH
    # ffprobePath: D:\ffmpeg\bin\ffprobe.exe  # 也认 DSH_FFPROBE_PATH / FFPROBE_PATH
    maxFrames: 64        # 单次抽帧上限（1-64）
    maxWidth: 768        # 单帧宽度上限
    maxPixels: 640000    # 单帧面积上限，默认与 DSH 的 imagePixelBudget 默认值一致
    quality: 3           # JPEG 质量（ffmpeg -q:v，2 最好 / 31 最差）
    timeoutMs: 120000    # 单次 ffmpeg 调用超时
    toolTimeoutMs: 600000 # 整次工具调用超时
    graceMs: 2000        # 终止宽限期（SIGTERM 之后多久强杀）
```

## 它内部守住的几条规矩

代码里的注释写了「为什么」，这里只列「是什么」——每一条都有对应的断言：

- **末尾避让**。等分采样会把最后一帧正好落在 `duration` 上，而**时长边界上没有帧**：
  3.000 秒的视频最后一帧在 2.96（25fps），`-ss 3.000` 一个包都写不出来。
  这个坑**每次调用都会踩**，所以按帧率算出避让量（`endEdge`）。
- **竖屏按面积缩**。只卡宽度的话 2160×4096 缩到 768 宽仍有 1.12M 像素，超预算近一倍。
- **不缩放就完全不碰尺寸**。对 101px 高的图强行取偶成 100px 会悄悄改掉宽高比，
  所以 `resized: false` 时不传 `-vf`，宽高原样返回。
- **旋转要认**。手机竖拍常是「编码 1920×1080 + 旋转 90°」，ffmpeg 解码时自动转正，
  而 ffprobe 报的是编码尺寸——拿编码尺寸去算 `scale` 会把画面拉扁。
- **先挡再算最后干重活**。模型不声明收图时**在跑 ffmpeg 之前**就拒绝，不做无用解码。
- **无 shell**。全程 argv 数组。
- **临时帧绝不留在盘上**（`finally` 里删）。
- **失败要说人话**。ffprobe/ffmpeg 的报错带 stderr 尾部，且带上是哪一帧、哪个时刻。

## 测试

```bash
npm test                                  # 41 项：纯函数 + 真实 ffmpeg 端到端
node scripts/verify-host-contract.mjs     # 用宿主自己的校验器验 schema 与返回值
```

`npm test` 里的"宿主"是桩件，但它**按契约校验**：附件桩会检查 JPEG 魔数、
读出真实像素尺寸，所以"ffmpeg 其实没抽出图"在测试里就会炸。
素材是现造的（`testsrc2` + 正弦音轨），仓库里不躺任何二进制视频。

`scripts/verify-host-contract.mjs` 是另一层：它直接 import 宿主安装里的
`assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue`，
用**真货**验一遍。

> 为什么需要它：单测里的 schema 校验器是**复刻版**（插件零依赖，测试环境拿不到
> `@deepseek-ai/dsh-tools`）。复刻版万一复刻错了，单测就是一片假绿灯。
> 而 schema 用了不支持的关键字（`minimum` / `maxItems` / `pattern` …）不是"工具不好用"，
> 是 `ctx.tools.register()` 在 `apply()` 期间抛错 —— **插件整个装不上**。

## 已知边界

- **没有耳朵。** 不转写音频，`hasAudio` 只如实报告有没有音轨。
  **不要根据画面猜台词**——工具描述里也向模型写明了这一点。
- **不经过 `ctx.fs`。** `input` 是直接交给 ffmpeg 的路径，所以 agent 侧的文件沙箱
  对这个**读**不生效（与 `dsh-ffmpeg` 等同类插件一致）。它只会往自己的私有临时目录里写。
- **帧是离散快照。** 帧间运动与一闪而过的事件会漏；敏感场景请自己用 `times` 加密。
- **要 ffmpeg。** 没装就是跑不了。

## 许可

MIT。
