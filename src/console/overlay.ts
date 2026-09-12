/**
 * 面板 `overlay` —— 字幕层:推流链接、样式与试显。
 *
 * 预览用 iframe 嵌**同一个** overlay 页(带 `?bg=dim` 给个暗底),不另写一份
 * 渲染:两份渲染意味着"预览里好看、OBS 里不对"这类问题永远查不清。
 *
 * 样式改动即时生效——服务端钳完值经 SSE 热推给所有订阅者,OBS 里那份不用重开。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import {
  errText,
  msgLine,
  type AsrOverlayConfig,
  type AsrOverlayState,
} from './client.ts';

const DESC =
  'OBS 里加一个浏览器源,地址填下面这条,尺寸按画布来。字幕样式改完即时生效,'
  + 'OBS 那份不用重开。字体填 OBS 那台机器上装了的字体名。';

export const overlayPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: 'Overlay 字幕', en: 'subtitle overlay', desc: DESC });
    const s = card.body;
    root.appendChild(card.el);

    const msg = msgLine(ctx, 'grow');
    const linkBox = ui.h('div');
    s.append(ui.section('推流链接'), linkBox);

    // ---- 样式 ----
    const scale = ui.input({ type: 'number', value: '1' });
    const weight = ui.select({ options: ['300', '400', '500', '600', '700', '800'] });
    const maxLines = ui.input({ type: 'number', value: '2' });
    const holdSec = ui.input({ type: 'number', value: '6' });
    const color = ui.input({ value: '#fffef8', cls: 'mono' });
    const strokeColor = ui.input({ value: '#000000', cls: 'mono' });
    const strokeW = ui.input({ type: 'number', value: '1.5' });
    const plate = ui.input({ type: 'number', value: '0.35' });
    const font = ui.input({ placeholder: '留空 = 页面默认' });
    const partialIn = ui.checkbox('显示"正在说…"', { checked: true });
    const form = ui.h('div', 'asr-form');
    form.append(
      ui.field('字号倍率', scale),
      ui.field('字重', weight),
      ui.field('保留行数', maxLines),
      ui.field('停留(秒)', holdSec),
      ui.field('字色', color),
      ui.field('描边色', strokeColor),
      ui.field('描边宽(px)', strokeW),
      ui.field('底板不透明度', plate),
      ui.field('字体', font),
    );
    const btnApply = ui.button('应用', { size: 'sm', variant: 'primary' });
    const testText = ui.input({ placeholder: '试显一条字幕' });
    const btnTest = ui.button('试显', { size: 'sm' });
    const acts = ui.actions();
    acts.append(partialIn.el, ui.h('span', 'grow'), testText, btnTest, btnApply);
    s.append(ui.section('字幕样式'), form, acts, msg.el);

    // ---- 预览 ----
    const frame = ui.h('iframe', 'asr-preview');
    frame.setAttribute('title', '字幕预览');
    s.append(ui.section('预览', '与 OBS 里那份是同一个页面,只是加了暗底'), frame);

    // -----------------------------------------------------------------------

    function render(st: AsrOverlayState | null): void {
      if (ctx.signal.aborted) return;
      if (!st) {
        msg.say('字幕面板不可用', true);
        linkBox.replaceChildren(ui.placeholder('识别流没起来'));
        return;
      }
      linkBox.replaceChildren(ui.kv([
        { k: '字幕页', v: st.url ?? '(未启动)' },
        { k: '订阅者', v: `${st.subscribers} 个(OBS 浏览器源 / 预览各算一个)` },
        { k: '复制', v: st.url ? ui.copyButton(st.url, { label: '复制链接' }) : '—' },
      ]));
      const c = st.config;
      scale.value = String(c.subtitle.scale);
      weight.value = String(c.subtitle.weight);
      maxLines.value = String(c.maxLines);
      holdSec.value = String(Math.round(c.holdMs / 1000));
      color.value = c.subtitle.color;
      strokeColor.value = c.subtitle.strokeColor;
      strokeW.value = String(c.subtitle.strokeW);
      plate.value = String(c.subtitle.plate);
      font.value = c.subtitle.fontFamily;
      partialIn.setChecked(c.showPartial);
      const want = st.url ? `${st.url}?bg=dim` : '';
      if (want && frame.getAttribute('src') !== want) frame.setAttribute('src', want);
    }

    const patch = (): Partial<AsrOverlayConfig> => ({
      maxLines: Number(maxLines.value),
      holdMs: Math.round(Number(holdSec.value) * 1000),
      showPartial: partialIn.checked,
      subtitle: {
        scale: Number(scale.value),
        weight: Number(weight.value),
        color: color.value.trim(),
        strokeColor: strokeColor.value.trim(),
        strokeW: Number(strokeW.value),
        plate: Number(plate.value),
        fontFamily: font.value.trim(),
      },
    });

    const refresh = (): Promise<void> =>
      ctx.invoke<AsrOverlayState>('state').then(render, () => render(null));

    btnApply.addEventListener('click', () => {
      msg.say('应用中…');
      void ctx.invoke<AsrOverlayState>('setConfig', [patch()]).then(
        (st) => { render(st); msg.say('已生效并落盘;订阅中的页面已热更新'); },
        (err: unknown) => { if (!ctx.signal.aborted) msg.say(`应用失败: ${errText(err)}`, true); },
      );
    }, { signal: ctx.signal });

    btnTest.addEventListener('click', () => {
      void ctx.invoke<AsrOverlayState>('test', [testText.value]).then(
        (st) => { render(st); msg.say('已投一条到字幕流'); },
        (err: unknown) => { if (!ctx.signal.aborted) msg.say(`试显失败: ${errText(err)}`, true); },
      );
    }, { signal: ctx.signal });

    void refresh();
  },
};
