# 第三方声明

这个包自己不带推理代码、Python 环境,也不带模型权重。下面是它在运行时会去取、或者要求操作者
自己装好的东西,以及各自的许可。

## 识别运行时

FireRedASR2S 的推理代码,钉在一个 commit 上,由「收听」面板取到
`<运行时根>/firered-asr/<commit>/cu128/FireRedASR2S/`,并在同目录 `.venv/` 里建 Python 环境。

- 上游:[FireRedTeam/FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S),Apache-2.0
- Python 3.12 由 uv 取用;PyTorch、torchaudio、torchvision 取自 PyTorch 官方 cu128 wheel 源,BSD-3-Clause;
  其余依赖见 `src/firered-requirements.txt`,各随其上游许可
- `git` 与 `uv` 由操作者自己装好放进 PATH;本项目不修改本机的驱动、运行库与应用控制策略

## 模型权重

放在 `<模型根>/asr/FireRedASR2-AED/`,由面板按固定 revision 从 HuggingFace 下载。

| 文件 | 来源 | 许可 |
|---|---|---|
| `model.pth.tar`、`cmvn.ark`、`dict.txt`、`train_bpe1000.model` | [FireRedTeam/FireRedASR2-AED](https://huggingface.co/FireRedTeam/FireRedASR2-AED) @ `2304afe` | Apache-2.0(模型卡所载) |

## 其他运行时依赖

- **声卡**:`audify`(RtAudio 的 Node 绑定)随包安装,MIT
- **简繁转换**:`opencc-js`,MIT AND Apache-2.0

## 本包的许可

MIT,见 `LICENSE`。框架 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 也是 MIT,两者经扩展契约相连,
许可各归各。
