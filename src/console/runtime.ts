/**
 * 「运行时与权重」:接在「收听」面板下面的第二张卡。运行时是 FireRedASR2S 的 Python 环境,
 * 权重是 FireRedASR2-AED 的四个文件;两样都装到部署根下,安装与下载各一颗键。
 */
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { errText, type AsrRuntimeState } from './client.ts';

const DESC =
  '运行时是 FireRedASR2S 的 Python 环境(git 取代码、uv 建环境并装 PyTorch),装到部署根的 runtimes/firered-asr/ 下;'
  + '权重是 FireRedASR2-AED 的四个文件,下到 models/asr/FireRedASR2-AED/。'
  + '配置里填了「运行时目录(自备)」或「权重文件(自备)」的那一样就不再装。安装要本机有 git 与 uv。';

function gb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${bytes} B`;
}

function progressText(done: number, total: number | null): string {
  return total ? `${gb(done)} / ${gb(total)}(${Math.round((done / total) * 100)}%)` : gb(done);
}

export function mountRuntimeSection(ctx: ConsolePanelContext): void {
  const { ui } = ctx;
  const card = ui.sheet({ title: '运行时与权重', en: 'runtime', desc: DESC });

  const msg = ui.msgline('');
  const chip = ui.chip('—');
  const btnInstall = ui.button('安装运行时', { size: 'sm', onClick: () => void install() });
  const head = ui.rowbar();
  head.append(ui.pill('运行时', 'plain'), chip, msg, ui.h('span', 'grow'), btnInstall);
  const dirLine = ui.h('div', 'pagedesc');
  const stepLine = ui.h('div', 'pagedesc');

  const modelsMsg = ui.msgline('');
  const modelsChip = ui.chip('—');
  const btnDownload = ui.button('下载权重', { size: 'sm', onClick: () => void download() });
  const modelsHead = ui.rowbar();
  modelsHead.append(ui.pill('权重', 'plain'), modelsChip, modelsMsg, ui.h('span', 'grow'), btnDownload);
  const modelsDirLine = ui.h('div', 'pagedesc');
  const rows = ui.h('div');

  card.body.append(head, dirLine, stepLine, ui.section('权重', 'FireRedASR2-AED,四个文件缺一不可'), modelsHead, modelsDirLine, rows);
  ctx.root.appendChild(card.el);

  const say = (el: HTMLElement, text: string, bad = false): void => {
    el.textContent = text;
    el.classList.toggle('bad', bad);
  };

  /** 有活在跑就提高轮询频率,静止时一次就够 */
  let busy = false;

  async function refresh(): Promise<void> {
    let st: AsrRuntimeState;
    try {
      st = await ctx.invoke<AsrRuntimeState>('runtime');
    } catch (error) {
      if (!ctx.signal.aborted) say(msg, errText(error), true);
      return;
    }
    if (ctx.signal.aborted) return;
    const phase = st.install.phase;
    const downloading = st.models.some((m) => m.phase === 'downloading');
    busy = phase === 'installing' || downloading;

    chip.textContent = st.own
      ? '自备目录'
      : !st.supported
        ? '本平台无托管方案'
        : phase === 'installed'
          ? st.revision.slice(0, 7)
          : phase === 'installing'
            ? `安装中 · ${st.install.step ?? ''}`
            : phase === 'error'
              ? '装失败'
              : '未安装';
    dirLine.textContent = st.dir || '(还没有目录)';
    stepLine.textContent = phase === 'installing' ? (st.install.line ?? '') : '';
    btnInstall.disabled = busy || st.own || !st.supported;
    btnInstall.textContent = phase === 'installed' ? '重装运行时' : '安装运行时';
    if (st.install.detail) say(msg, st.install.detail, true);

    modelsChip.textContent = st.modelsComplete ? '齐了' : downloading ? '下载中' : '缺文件';
    modelsDirLine.textContent = `${st.modelsDir} · 来源 ${st.modelsSource}`;
    btnDownload.disabled = busy || st.modelsComplete;
    rows.replaceChildren();
    for (const m of st.models) {
      const row = ui.rowbar();
      const state = m.phase === 'present'
        ? gb(m.bytes)
        : m.phase === 'downloading'
          ? progressText(m.done, m.total)
          : m.phase === 'error'
            ? (m.detail ?? '下载失败')
            : '未下载';
      row.append(ui.chip(m.file), ui.h('span', m.phase === 'error' ? 'bad' : '', state));
      rows.appendChild(row);
    }
  }

  async function install(): Promise<void> {
    say(msg, '开始安装:取代码、建环境、装 PyTorch(几 GB),别关页面');
    void poll();
    try {
      await ctx.invoke('installRuntime');
      say(msg, '运行时装好了');
    } catch (error) {
      if (!ctx.signal.aborted) say(msg, errText(error), true);
    }
    void refresh();
  }

  async function download(): Promise<void> {
    say(modelsMsg, '开始下载,model.pth.tar 有 4.7 GB');
    void poll();
    try {
      await ctx.invoke('downloadModels');
      say(modelsMsg, '权重齐了');
    } catch (error) {
      if (!ctx.signal.aborted) say(modelsMsg, errText(error), true);
    }
    void refresh();
  }

  /** 安装与下载的 invoke 要等到结束才返回,进度靠这里按秒刷 */
  async function poll(): Promise<void> {
    await refresh();
    if (busy && !ctx.signal.aborted) ctx.timeout(() => void poll(), 1000);
  }

  void refresh();
}
