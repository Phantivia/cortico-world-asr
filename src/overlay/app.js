/**
 * 识别字幕 overlay:订阅同源 /stream(SSE),把识别出来的话铺在画面下沿。
 *
 * 三种帧:`speech`(有人开口了,亮"正在说"的点)、`text`(一句识别结果,成行)、
 * `overlay.config`(样式热改)。样式与保留条数来自服务端配置,控制台改动实时生效。
 * URL 参数按订阅方覆盖:?lines=3 只留三行,?partial=0 不显示"正在说",
 * ?bg=dim 给预览加暗背景(正式合成不带,保持透明)。
 */
(() => {
  const stageEl = document.getElementById('stage');
  const linesEl = document.getElementById('lines');
  const partialEl = document.getElementById('partial');

  const params = new URLSearchParams(location.search);
  if (params.get('bg') === 'dim') document.body.classList.add('bg-dim');
  const linesOverride = Number(params.get('lines'));
  const partialOff = params.get('partial') === '0' || params.get('partial') === 'false';

  let cfg = {
    maxLines: 2,
    holdMs: 6000,
    showPartial: true,
    subtitle: { scale: 1, weight: 500, color: '#fffef8', strokeColor: '#000000', strokeW: 1.5, plate: 0.35, fontFamily: '' },
  };

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    cfg = { ...cfg, ...next, subtitle: { ...cfg.subtitle, ...(next.subtitle || {}) } };
    const s = stageEl.style;
    const sub = cfg.subtitle;
    s.setProperty('--sub-scale', String(sub.scale));
    s.setProperty('--sub-weight', String(sub.weight));
    s.setProperty('--sub-color', sub.color);
    s.setProperty('--sub-stroke-color', sub.strokeColor);
    s.setProperty('--sub-stroke-w', String(sub.strokeW));
    s.setProperty('--sub-plate', String(sub.plate));
    if (sub.fontFamily) s.setProperty('--sub-font', sub.fontFamily + ", 'Microsoft YaHei', 'PingFang SC', sans-serif");
    else s.removeProperty('--sub-font');
    trim();
  }

  function maxLines() {
    return Number.isFinite(linesOverride) && linesOverride > 0 ? linesOverride : Math.max(1, cfg.maxLines);
  }

  function trim() {
    while (linesEl.children.length > maxLines()) linesEl.removeChild(linesEl.firstChild);
  }

  function addLine(text) {
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'line';
    el.textContent = text;
    linesEl.appendChild(el);
    trim();
    // 到点先淡出再摘,免得画面上出现"整块字瞬间消失"
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 500);
    }, Math.max(500, cfg.holdMs));
  }

  function setPartial(on, text) {
    if (partialOff || !cfg.showPartial) {
      partialEl.classList.remove('on');
      return;
    }
    partialEl.textContent = text || '正在说…';
    partialEl.classList.toggle('on', Boolean(on));
  }

  function onFrame(msg) {
    switch (msg.type) {
      case 'snapshot':
        applyConfig(msg.overlay);
        for (const line of msg.recent || []) addLine(line);
        break;
      case 'overlay.config':
        applyConfig(msg.config);
        break;
      case 'speech':
        setPartial(msg.active, msg.text);
        break;
      case 'text':
        setPartial(false, '');
        addLine(msg.text);
        break;
      default:
        break; // 不认识的帧忽略:事件表只加不改
    }
  }

  const es = new EventSource('/stream');
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onFrame(msg);
  };
})();
