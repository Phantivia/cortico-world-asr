# cortico-world-asr

[Cortico](https://github.com/Phantivia/Cortico) 的语音识别 World,以独立 npm 包发布。

麦克风里的话经切分、识别、打包,作为外部事件进入上下文。World **没有工具**:听是纯入站的事,
表达通道是嘴(cortico-world-vtuber)或文字,不在这儿。

## 与 Cortico 的关系

这是一个扩展包。它按 Cortico 的扩展契约声明自己:

```jsonc
"cortico": { "kind": "world", "api": 3, "consoleClient": "dist/console.js", "consoleStyle": "dist/console.css" }
```

运行时它以 `cortico/<框架 src 下的路径>` import 框架(`cortico/world.ts`、`cortico/core/types.ts` …),
由框架 `src/extensions/runtime.ts` 注册的模块钩子解析到框架源码本身。开发期 `tsconfig.json` 与
`vitest.config.ts` 把同一前缀指到同级的框架 checkout(`../BOT/src/`)。浏览器侧(`src/console/**`)
对 `cortico/*` 只 `import type`。

## 安装

先在本目录构建面板产物(`dist/` 不进版本库):

```bash
corepack pnpm install
corepack pnpm build
```

然后二选一:控制台「扩展」页手动安装,填本目录的绝对路径;或在 `<Cortico>/extensions/` 下
`corepack pnpm add --ignore-workspace <本目录绝对路径>`。装完整进程重启 Cortico。

识别后端(FireRedASR2-AED 的 Python 环境与权重)另装,见下面「后端」。

## 结构

```
capture.ts     声卡:RtAudio 输入,16k 单声道,20ms 一帧
segmenter.ts   切分(能量门限状态机)+ 打包(相邻句子并成一条投递)——纯逻辑
asr-client.ts  转写端点客户端(OpenAI 兼容 /audio/transcriptions)+ WAV 封装 + 幻觉过滤
asr-server.ts  FireRedASR2-AED 的进程管理(gpu / cpu 两档)
stream.ts      /overlay 字幕页 + SSE /stream(自有端口)
overlay/       字幕页三件套(OBS 浏览器源与控制台预览是同一份)
console/       控制台扩展:收听 / Overlay 字幕 两个面板
module.ts      装配:配置、面板、事件投递
```

一条链四段,每段都能单独换掉:

```
声卡 → 切分 → 识别端点 → 打包投递
```

模组跑在主进程里,不像 cortico-world-vtuber 那样开子进程:这条链上唯一的常驻计算是每帧一次
均方根(20ms 一帧、320 个样本),识别本身在另一个进程/另一台机器上。没有 60Hz 的
同步工作要隔离,子进程只会多一层 IPC。

## 后端：FireRedASR2-AED

客户端使用 `POST /v1/audio/transcriptions`：multipart 字段 `file` 是 16 kHz、单声道、PCM16 WAV，响应为 `{ "text": "..." }`。`firered-server.py` 将该接口接到 FireRedASR2-AED。麦克风采集、切分、简体转换、纠错、字幕和事件投递共用原有链路。

运行环境与权重按现有资源边界分开部署，均不入 Git：

```
runtime/firered-server/
  .venv/                  Python 3.12 + PyTorch CUDA 12.8
  FireRedASR2S/           固定版本的上游推理代码
../Cortico-Resources/models/asr/FireRedASR2-AED/
  model.pth.tar
  cmvn.ark
  dict.txt
  train_bpe1000.model
```

Windows 安装：`pwsh -File scripts/setup-firered-asr.ps1`，需要 Git 与 uv。脚本安装 Python 环境并获取固定版本的代码与模型；已有完整模型目录时复用文件。模型版本为 `2304afed56eacfee6256dee5937ed22ffa0b64ec`，代码版本为 `4e7d9aaf4482a47cec1724807026b9b151926eb5`。来源：[FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S)、[FireRedASR2-AED](https://huggingface.co/FireRedTeam/FireRedASR2-AED)。

`worlds.asr.backend.modelFile` 指向仓库外 `model.pth.tar` 的绝对路径；同目录的配套文件必须齐全。空值可从运行目录的 `models/<模型名>/` 查找完整模型。文件名或配套文件不对时启动前就报出，不会自动选取另一份模型。

`worlds.asr.backend.model` 默认为 `FireRedASR2-AED`，本地服务实际加载的模型由 `modelFile` 决定。`baseUrl` 仍为 `http://127.0.0.1:8793/v1`。显卡档使用 CUDA，CPU 档使用相同权重；`threads=0` 使用 4 线程。AED 按自身能力识别中英文，没有强制语言参数；接口接受 `language` 以兼容现有客户端，但该提示不改变 AED 解码。

推理参数为 FP32、beam=3、softmax_smoothing=1.25、aed_length_penalty=0.6、eos_penalty=1，无时间戳和外部语言模型。请求独立，不携带前一句文本。输入直接在内存中解码，不写入临时录音文件；单段最长 60 秒，与切分配置上限一致。

管理器沿用 `state/start/stop` 和 `autoStart`。模型加载与预热结束后才开放 HTTP，因此成功探活表示可识别。Windows 停止托管后端会结束 Python 子进程树。已由外部启动的兼容端点仍可复用，管理器只停止自己启动的进程。

协议测试：`python -m unittest discover -s tests/asr -p 'test_firered_server.py'`。进程管理和现有识别链路由 `pnpm test` 覆盖；真实模型验证应使用独立端口回放本地 WAV，避免启动 bot 或投递测试语音事件。


## 切分:哪一段值得送去识别

声卡给的是每 20ms 一帧,而识别的输入单位是"一句"。中间这层是能量门限状态机:

- `thresholdDb` 判为"有人在说"的门槛。安静房间底噪常在 -60 上下,人声峰值在 -20 上下。
- `minSpeechMs` 连续超过门槛多久才算开口——咳嗽、键盘、鼠标点击挡在这一关。
- `dispatchSilenceMs` 停这么久就把手上这段**送去转写**(短门限,默认 250)。
- `silenceMs` 停这么久才算**一句说完**(长门限,默认 500)——发不发车看它。
- `preRollMs` 触发点往前多带一段:**人开口的第一个字总在能量越线之前**。
- `maxUtteranceMs` 一直说不停时到点强切,切完接着收——她不该等一个人讲完五分钟
  才听见第一个字。
- `minUtteranceMs` 短于它的碎片直接丢。

门槛调得对不对,「收听」面板上那条带刻度的电平条一眼就能看出来:说话时越过刻度、
安静时不越过。这是这个面板存在的主要理由,数字本身说不清这件事。

短门限让识别与剩余的收尾静音重叠。转写结果返回且收尾静音结束后才投递；
若识别耗时超过剩余静音，继续等待识别完成。

短门限不会把句子切碎,因为**它切的是音频、不是发车**:长门限没到之前
`settleRemainingMs` 一直报"还没说完",打包层照旧按着;人在窗口里接着说,后半段自然接上,
两半在打包层并回一条。给到 `dispatchSilenceMs >= silenceMs` 就退回原来的单级行为。

## 打包:几句话算一次开口

识别结果**不逐句投递**。人说话是一串短句,逐句唤醒等于把一段话拆成五次打断——但
"几句算一次开口"这件事已经由切分层的 `silenceMs` 定住了:停顿短于收尾静音的两句根本
不会变成两批。所以这一层只剩三个数:

- `joinGapMs` 转写落地后**额外**再空等多久(默认 0)。给多少就直接加多少响应延迟;
  收尾静音之外真正需要它的场合已经没有了,后到的句子由总线的 preempt 覆盖。
- `maxHoldMs` 一条最多攒这么久。只在 `joinGapMs > 0` 时才有机会当判据。
- `minChars` 少于这么多字的结果丢掉:噪声与语气词识别出来常是一两个字。

打包发车不用 100ms 轮询。每次转写落地都会立即检查一次并按精确 deadline 下钟。持有的
判据有三条:麦克风正在收音、有音频待转写或转写在途、收尾静音还没到点。前两条各自会在
自己完事时再叫一次;第三条有确定的到点时刻,所以由 `flushPackedIfDue` 自己下钟——短门限
早就把音频交出去了,那一段最后一个帧回调可能已经过去了。

## 出口纠错表

`worlds.asr.corrections` 每条为 `错=对`，用换行或分号分隔；在简体化与幻觉过滤之后、投递之前作整段替换。适用于人名或专有词的固定误识别，左侧匹配文本较长的规则先执行。

## 幻觉过滤

whisper 系模型在纯噪声上会稳定地吐出训练集里的高频片段("谢谢观看"、字幕组落款、
`[音乐]` 这类标注)。它们与真话在文本上无从分辨,只能按名单挡
(`asr-client.ts` 的 `looksHallucinated`)。漏一条的代价是她收到一句没人说过的话,
并且会当真去回应——所以这道过滤宁可误杀。被挡下的在面板上标成 `[丢弃]`,不静默。

## 事件面

| 事件 | 触发 | 说明 |
| --- | --- | --- |
| `asr.speech` | `preempt`(`worlds.asr.wake` 关掉则 `debounce`) | `[语音] <说话人>:<话>` |

识别分不出是谁在说,`worlds.asr.speaker` 就是事件里那个"谁"。

`preempt` 保持事件 FIFO，整批立即发车。主模型仍在 thinking/prefill、尚未开出任何
演出或工具时会取消该轮并用合并后的新批重发；已经外化的轮不自动取消，已排队音频也不受影响。

## Overlay 字幕

`stream.ts` 起一个自己的 HTTP 口(`worlds.asr.streamPort`,被占顺延):
`/overlay` 是字幕页,`/stream` 是它的 SSE 数据面。OBS 加一个浏览器源指到 `/overlay`,
控制台的预览用 iframe 嵌**同一个页面**(带 `?bg=dim` 给个暗底)——两份渲染意味着
"预览里好看、OBS 里不对"这类问题永远查不清。

URL 参数按订阅方覆盖:`?lines=3` 只留三行、`?partial=0` 不显示"正在说…"。
样式(字号、字重、颜色、描边、底板、字体、保留行数、停留时长)在面板上改,
服务端钳完值经 SSE 热推给所有订阅者,OBS 那份不用重开;同时经装配层写回 config.json。

## 控制台面板

- **收听(listen)**:麦克风选择、带门槛刻度的电平条、识别后端启停、实时识别文本。
  电平与文本走 `ctx.stream`(模组的 `ModuleConsoleDecl.stream`)实时推,计数与后端
  状态五秒轮一次——能推的别轮询。
- **Overlay 字幕(overlay)**:链接、样式、试显、预览。

## 挂载

```ts
if (cfg.worlds.asr.enabled) {
  worlds.push(new AsrModule({
    cfg: cfg.worlds.asr,
    timezone: cfg.timezone,
    onDevice: (device) => { /* 写回 config.json */ },
    onOverlayConfig: (overlay) => { /* 同上 */ },
  }));
}
```

麦克风与字幕样式是在面板上调的,调完要留住:模组只管当场生效,落盘经装配层
(与 cortico-world-vtuber 的 overlay/TTS 档案同一套办法)。
