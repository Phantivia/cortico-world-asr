/**
 * 面板用到的两枚图标。包内自带而不从 `cortico/web/client/ui/icons.ts` 取:浏览器侧对
 * 框架只允许 `import type`,面板 bundle 不打进框架的前端代码。形状与框架那份相同。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

type Shape = readonly [tag: 'path' | 'circle' | 'rect' | 'line', attrs: Readonly<Record<string, string>>];

const SHAPES = {
  'folder-open': [
    ['path', { d: 'M3 6h6l2 2h10' }],
    ['path', { d: 'M3 6v13h15l3-8H6l-3 8' }],
  ],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'm7 10 5 5 5-5' }],
    ['path', { d: 'M5 21h14' }],
  ],
} as const satisfies Readonly<Record<string, readonly Shape[]>>;

export type AsrIconName = keyof typeof SHAPES;

export function icon(doc: Document, name: AsrIconName, cls = 'icon'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add(cls);
  for (const [tag, attrs] of SHAPES[name]) {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    svg.appendChild(child);
  }
  return svg;
}
