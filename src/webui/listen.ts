/**
 * 面板 `listen` —— 收听:麦克风、识别后端、电平与实时识别文本。
 *
 * 这一屏是**调门槛**的地方。电平条上那道竖线就是 `worlds.asr.segment.thresholdDb`:
 * 说话时条要越过它、安静时不越过——这条判据一句话说得清,而光看数字说不清。
 * 所以电平走 `ctx.stream` 实时推(10Hz),不是轮询回来的一个静止读数。
 *
 * 识别文本用 `ui.log`(只往末尾长的事件流、尾部粘滞),不是 `ui.table`:
 * 一条条来的东西整表重画会刷掉滚动位置。
 */

import type {
  WebUiPanelContext,
  WebUiPanel,
} from 'cortico/web/shared/client-panel.ts';
import {
  errText,
  msgLine,
  type AsrListenState,
  type AsrPanelFrame,
  type AsrServerState,
} from './client.ts';
import { icon } from './icons.ts';
import { mountRuntimeSection } from './runtime.ts';

const DESC =
  '选麦克风、看电平、看识别结果。电平条上那道竖线是"说话门槛":说话时越过它、'
  + '安静时不越过,门槛就调对了。识别后端在这儿启停:FireRed 显卡档适合实时识别、'
  + 'CPU 档不占显存,档位在本 World 配置里切。';

/** 电平条的显示范围:-60 dBFS 以下都当静音 */
const FLOOR_DB = -60;

function pct(db: number): number {
  return Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
}

export const listenPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: '收听', en: 'listen', desc: DESC });
    const s = card.body;
    root.appendChild(card.el);

    const msg = msgLine(ctx, 'grow');
    const btnListen = ui.button('开始收听', { size: 'sm', variant: 'primary' });
    const btnStop = ui.button('停止', { size: 'sm', variant: 'danger' });
    const bar = ui.rowbar();
    bar.append(btnListen, btnStop, msg.el);
    s.append(bar);

    // ---- 麦克风 ----
    const devSel = ui.select();
    const devForm = ui.h('div', 'asr-form');
    devForm.append(ui.field('麦克风', devSel));
    const meter = ui.h('div', 'asr-meter');
    const fill = ui.h('div', 'asr-meterfill');
    const mark = ui.h('div', 'asr-metermark');
    const readout = ui.h('span', 'asr-readout', '—');
    meter.append(fill, mark);
    const meterRow = ui.h('div', 'asr-meterrow');
    meterRow.append(meter, readout);
    const actual = ui.h('div', 'pagedesc');
    s.append(ui.section('麦克风', '选设备与看电平;换设备会重开一次输入流'), devForm, meterRow, actual);

    // ---- 识别后端 ----
    const modelSel = ui.select();
    const btnModelFile = ui.button('', { size: 'sm' });
    btnModelFile.className += ' pathpick';
    btnModelFile.title = '选择权重文件';
    btnModelFile.setAttribute('aria-label', btnModelFile.title);
    btnModelFile.appendChild(icon(btnModelFile.ownerDocument, 'folder-open'));
    const modelDownload = ui.h('a', 'pathdownload');
    modelDownload.href = 'https://huggingface.co/FireRedTeam/FireRedASR2-AED/tree/2304afed56eacfee6256dee5937ed22ffa0b64ec';
    modelDownload.target = '_blank';
    modelDownload.rel = 'noopener noreferrer';
    modelDownload.title = 'FireRedASR2-AED 模型文件';
    modelDownload.append(icon(modelDownload.ownerDocument, 'download'), ui.h('span', null, '下载权重'));
    const modelForm = ui.h('div', 'asr-form');
    const modelRow = ui.rowbar();
    modelRow.append(modelSel, btnModelFile);
    const modelMeta = ui.h('div', 'pathfield-meta', '');
    const modelDirNote = ui.h('span', null, '');
    modelMeta.append(modelDirNote, modelDownload);
    const modelField = ui.h('div', 'pathfield');
    modelField.append(modelRow, modelMeta);
    modelForm.append(ui.field('权重', modelField));
    const srvLine = ui.h('div', 'mountrow');
    const srvDot = ui.h('span', 'navdot');
    const srvState = ui.h('span', 'mstate', '—');
    const srvDetail = ui.h('span', 'mdetail');
    const srvActs = ui.h('span', 'macts');
    const btnSrvStop = ui.button('停止', { size: 'sm', variant: 'danger' });
    const btnSrvStart = ui.button('启动', { size: 'sm', variant: 'primary' });
    srvActs.append(btnSrvStop, btnSrvStart);
    srvLine.append(srvDot, ui.h('span', 'mname', '识别后端'), srvState, srvDetail, srvActs);
    s.append(
      ui.section('识别后端', '权重换完会把后端重起一次;档位(显卡/CPU)在本 World 配置里切'),
      modelForm,
      srvLine,
    );

    // ---- 识别文本 ----
    const stats = ui.statgrid();
    const logView = ui.log({ max: 200 });
    const btnClear = ui.button('清空', { size: 'sm' });
    const logBar = ui.actions();
    logBar.append(ui.h('span', 'grow'), btnClear);
    s.append(ui.section('识别结果', '实时推送;丢掉的那些(太短、疑似幻觉)也标出来'), stats, logView.el, logBar);

    // -----------------------------------------------------------------------

    let cur: AsrListenState | null = null;
    let seenAt = 0;
    /** 上一次铺选项时的设备名单;变了才重铺,免得刷掉用户正在选的那一下 */
    let deviceKey = '';
    /** 同上,权重那一份 */
    let modelKey = '';

    function renderServer(st: AsrServerState): void {
      const configured = cur?.modelFile ?? '';
      const key = `${st.models.join('\0')}\0${configured}`;
      if (key !== modelKey) {
        modelKey = key;
        modelSel.replaceChildren();
        const auto = ui.h('option', null, '自动(按档位挑)');
        auto.value = '';
        modelSel.appendChild(auto);
        for (const m of st.models) {
          const op = ui.h('option', null, m.replace(/[/\\]model\.pth\.tar$/, ''));
          op.value = m;
          modelSel.appendChild(op);
        }
        if (configured && !st.models.includes(configured)) {
          const external = ui.h('option', null, configured);
          external.value = configured;
          modelSel.appendChild(external);
        }
      }
      // 选中的是配置里钉的那份;真正加载的那份写在下面那行(自动挑时两者不同)
      modelSel.value = configured;
      modelSel.disabled = st.models.length === 0 && !configured;
      modelDirNote.textContent = `权重目录：${st.modelsDir}`;
      const up = st.reachable;
      const missing = !st.installed || st.model === null;
      const tone = up ? 'on' : st.phase === 'starting' ? 'warn' : 'off';
      srvDot.className = `navdot${up ? ' on' : st.phase === 'starting' ? ' warn' : ' bad'}`;
      srvState.className = `mstate asr-${tone}`;
      srvState.textContent = up
        ? (st.pid ? '运行中' : '运行中(外部)')
        : missing
          ? '未安装'
          : ({ starting: '启动中', error: '异常', stopped: '未启动' } as Record<string, string>)[st.phase] ?? st.phase;
      const note = missing && !up
        ? st.detail ?? (
          `${st.profile.toUpperCase()} 档缺${!st.installed ? '运行环境' : '权重'}:在下面「运行时与权重」安装`
        )
        : [
          st.pid ? `pid ${st.pid}` : null,
          st.url,
          st.model,
          `${st.profile.toUpperCase()} 档`,
          st.detail,
        ].filter(Boolean).join(' · ');
      srvDetail.textContent = note;
      srvDetail.title = note;
      btnSrvStart.disabled = st.phase === 'starting' || up || missing;
      btnSrvStop.disabled = st.pid === null && st.phase !== 'starting';
    }

    function render(st: AsrListenState | null): void {
      if (ctx.signal.aborted) return;
      cur = st;
      if (!st) {
        msg.say('收听面板不可用', true);
        return;
      }
      // 设备表按**名字**比,不按条数:插拔两支麦克风时条数不变,而选项该换
      const key = st.devices.map((d) => d.name).join('\0');
      if (key !== deviceKey) {
        deviceKey = key;
        devSel.replaceChildren();
        const auto = ui.h('option', null, '系统默认');
        auto.value = '';
        devSel.appendChild(auto);
        for (const d of st.devices) {
          const op = ui.h('option', null, `${d.name}${d.isDefault ? '(默认)' : ''}`);
          op.value = d.name;
          devSel.appendChild(op);
        }
      }
      // 下拉框绑的是配置里钉的那个,'' = 跟随系统默认;真正在用的写在电平条旁边
      devSel.value = st.devices.some((d) => d.name === st.deviceSetting) ? st.deviceSetting : '';
      actual.textContent = st.device ? `实际:${st.device}` : '';
      if (!st.audioAvailable) {
        msg.say('本机没有可用的录音设备(或原生声卡模块没装上)', true);
      }
      mark.style.left = `${pct(st.thresholdDb)}%`;
      setLevel(st.level, st.speaking, st.listening);
      btnListen.disabled = st.listening || !st.audioAvailable;
      btnStop.disabled = !st.listening;
      devSel.disabled = !st.audioAvailable;
      renderServer(st.server);
      stats.replaceChildren(
        ui.stat({ k: '识别句数', v: st.counts.utterances }),
        ui.stat({ k: '已投递', v: st.counts.delivered, accent: true }),
        ui.stat({ k: '丢弃', v: st.counts.dropped }),
        ui.stat({ k: '端点', v: st.endpoint.replace(/^https?:\/\//, '') }),
      );
      // 首次进面板补上已经听到过的那些(实时通道只推此后的)
      for (const r of [...st.recent].reverse()) {
        if (r.at <= seenAt) continue;
        seenAt = r.at;
        logView.append(`${new Date(r.at).toTimeString().slice(0, 8)}  ${r.text}  (${r.ms}ms)`);
      }
      if (st.detail) msg.say(st.detail, st.detail.includes('失败'));
    }

    function setLevel(db: number, speaking: boolean, listening: boolean): void {
      fill.style.width = `${pct(db)}%`;
      fill.classList.toggle('on', speaking);
      readout.textContent = listening ? `${Math.round(db)} dB${speaking ? ' · 正在说' : ''}` : '未收听';
    }

    const refresh = (): Promise<void> =>
      ctx.invoke<AsrListenState>('state').then(render, () => render(null));

    async function act(fn: () => Promise<AsrListenState>, working: string): Promise<void> {
      msg.say(working);
      const lock = ui.disable(btnListen, btnStop);
      let next: AsrListenState | null = null;
      try {
        next = await fn();
      } catch (err) {
        if (!ctx.signal.aborted) msg.say(`操作失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
      }
      if (next) render(next);
    }

    btnListen.addEventListener('click', () => {
      void act(() => ctx.invoke<AsrListenState>('start'), '打开麦克风…');
    }, { signal: ctx.signal });
    btnStop.addEventListener('click', () => {
      void act(() => ctx.invoke<AsrListenState>('stop'), '停止中…');
    }, { signal: ctx.signal });
    btnClear.addEventListener('click', () => {
      logView.clear();
      void act(() => ctx.invoke<AsrListenState>('clear'), '');
    }, { signal: ctx.signal });
    devSel.addEventListener('change', () => {
      void act(() => ctx.invoke<AsrListenState>('setDevice', [devSel.value]), '换设备…');
    }, { signal: ctx.signal });
    modelSel.addEventListener('change', () => {
      void act(() => ctx.invoke<AsrListenState>('setModel', [modelSel.value]), '换权重(要重起后端)…');
    }, { signal: ctx.signal });
    btnModelFile.addEventListener('click', () => {
      void (async () => {
        const lock = ui.disable(btnModelFile, modelSel);
        try {
          const path = await ctx.pickPath({
            kind: 'file',
            title: '选择 FireRedASR2-AED 的 model.pth.tar',
            extensions: ['.tar'],
            ...(cur?.server.modelsDir ? { recommendedDir: cur.server.modelsDir } : {}),
            ...(cur?.modelFile ? { currentPath: cur.modelFile } : {}),
          });
          if (!path || ctx.signal.aborted) return;
          const next = await ctx.invoke<AsrListenState>('setModel', [path]);
          render(next);
          msg.say(`权重路径已保存: ${path}`);
        } catch (err) {
          if (!ctx.signal.aborted) msg.say(`选择权重失败: ${errText(err)}`, true);
        } finally {
          lock.dispose();
        }
      })();
    }, { signal: ctx.signal });

    btnSrvStart.addEventListener('click', () => {
      msg.say('识别后端启动中…(要加载权重)');
      void ctx.invoke<AsrServerState>('server.start').then(
        (st) => { renderServer(st); waitReady(); },
        (err: unknown) => { if (!ctx.signal.aborted) msg.say(`启动失败: ${errText(err)}`, true); },
      );
    }, { signal: ctx.signal });
    btnSrvStop.addEventListener('click', () => {
      void ctx.invoke<AsrServerState>('server.stop').then(
        (st) => { renderServer(st); msg.say('识别后端已停止'); },
        (err: unknown) => { if (!ctx.signal.aborted) msg.say(`停止失败: ${errText(err)}`, true); },
      );
    }, { signal: ctx.signal });

    /** 等后端走完 starting。轮询走 ctx.interval,离开面板即停。 */
    function waitReady(): void {
      let ticks = 0;
      const timer = ctx.interval(() => {
        if (++ticks > 60) {
          timer.dispose();
          msg.say('识别后端启动超时', true);
          return;
        }
        void ctx.invoke<AsrServerState>('server.state').then((st) => {
          renderServer(st);
          if (st.phase === 'starting') return;
          timer.dispose();
          msg.say(st.reachable ? '识别后端就绪' : `识别后端 ${st.detail || st.phase}`, !st.reachable);
        });
      }, 2000);
    }

    // ---- 实时通道:电平与识别文本 ----
    ctx.stream({
      message: (raw) => {
        let frame: AsrPanelFrame;
        try {
          frame = JSON.parse(raw) as AsrPanelFrame;
        } catch {
          return;
        }
        // 只认得这三种;别的(通道自身的错误帧一类)不往识别文本里塞——
        // 那条流里混进一句框架的话,读起来就像有人真说了这句
        if (frame.type === 'level') {
          setLevel(frame.level, frame.speaking, frame.listening);
          if (cur && cur.listening !== frame.listening) void refresh();
          return;
        }
        if (frame.type !== 'text' && frame.type !== 'dropped') return;
        const at = frame.type === 'text' ? frame.at : Date.now();
        seenAt = Math.max(seenAt, at);
        const stamp = new Date(at).toTimeString().slice(0, 8);
        logView.append(frame.type === 'dropped'
          ? `${stamp}  [丢弃] ${frame.text}`
          : `${stamp}  ${frame.text}  (${frame.ms}ms)`);
      },
    });

    void refresh();
    // 计数与后端状态不走实时通道,慢一点无所谓
    ctx.interval(() => { void refresh(); }, 5000);

    mountRuntimeSection(ctx);
  },
};
