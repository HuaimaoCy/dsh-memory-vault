// Original line icons use the same stroke weight throughout the interface.
const paths = {
  vault: [],
  layers: ['M5 5h11a2 2 0 0 1 2 2v12H7a2 2 0 0 1-2-2V5Z', 'M8 2h11a2 2 0 0 1 2 2v12', 'M8 9h7M8 13h5'],
  library: ['M3 3h5v18H3zM8 3h5v18H8zM15 4l4-1 4 17-4 1-4-17Z'],
  book: ['M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z', 'M12 5v15'],
  // Capital E, optically centred inside the same 20 px icon frame as its peers.
  dictionary: ['M17 4H7v16h10M7 12h8'],
  conversation: ['M4 4h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6 4V5a1 1 0 0 1 1-1Z', 'M7 8h10M7 12h7'],
  hidden: ['M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8', 'M9.9 5.2A11 11 0 0 1 12 5c5.5 0 9 7 9 7a19 19 0 0 1-3.3 4.1M6.3 6.4A22 22 0 0 0 3 12s3.5 7 9 7a10 10 0 0 0 4-.8'],
  folder: ['M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z'],
  plus: ['M12 3v18M3 12h18'],
  minus: ['M4 12h16'],
  check: ['M4 12l5 5L20 6'],
  undo: ['M9 4 4 9l5 5','M4 9h10a6 6 0 0 1 0 12'],
  redo: ['m15 4 5 5-5 5','M20 9H10a6 6 0 0 0 0 12'],
  attachment: ['M8 12l7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3','M6 14l9-9a2 2 0 0 1 3 3L9 17a2 2 0 0 1-3-3Z'],
  search: ['M21 21l-5-5', 'M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z'],
  refresh: ['M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M21 21v-5h-5'],
  settings: ['M10 3h4l.6 2.2 1.4.8 2.2-.6 2 3.4-1.6 1.6v1.6l1.6 1.6-2 3.4-2.2-.6-1.4.8L14 21h-4l-.6-2.2-1.4-.8-2.2.6-2-3.4 1.6-1.6v-1.6L3.8 10.4l2-3.4 2.2.6 1.4-.8L10 3Z','M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  'chevron-right': ['M9 6l6 6-6 6'], 'chevron-down': ['M6 9l6 6 6-6'], close: ['M6 6l12 12M6 18 18 6'],
  sparkles: ['M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4'],
  appearance: ['M12 3a9 9 0 1 0 0 18m0-18a9 9 0 0 1 0 18m0-18v18M12 6l3-2.4M12 10l6-4.8M12 14l8-6.4M12 18l9-7.2M15 20.5l5.1-4.1'],
  layout: ['M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Zm4 0v15'],
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  maximize: ['M9 3H3v6M15 3h6v6M15 21h6v-6M9 21H3v-6'],
  minimize: ['M3 9h6V3M21 9h-6V3M21 15h-6v6M3 15h6v6'],
  list: ['M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01'], sort: ['M8 4v16M4 16l4 4 4-4M14 5h7M14 10h5M14 15h3'],
  shield: ['M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z', 'M8 12l3 3 5-6'],
  note: ['M6 3h9l4 4v14H6V3Z', 'M14 3v5h5M9 12h7M9 16h5'],
  'board-text': ['M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5ZM1.7 9H4m-2.3 6H4m16-6h2.3M20 15h2.3', 'M11.5 7.2l.8 1.2M8.3 10.6V9h7.4v1.6m-6.4.7h5L12 13.1v3c0 .7-.6.9-1.5.7m-1.9-2.5h6.8'],
  'board-connect': ['m8 8 8 8', 'M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  'board-shapes': ['M8.5 15.5a6 6 0 1 1 6.7-6.6', 'M11 9.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z'],
  'board-note': ['M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM3 8h18M6.8 11.7h10.4m-10.4 3.7h7.2'],
  'board-share': ['M12 15V2.5M8.8 5.7 12 2.5l3.2 3.2M7.7 8.5H5.8A1.8 1.8 0 0 0 4 10.3v9.4a1.8 1.8 0 0 0 1.8 1.8h12.4a1.8 1.8 0 0 0 1.8-1.8v-9.4a1.8 1.8 0 0 0-1.8-1.8h-1.9'],
  'board-compose': ['M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M20.6 3.4a1.5 1.5 0 0 1 0 2.1l-7.7 7.7-3 .9.9-3 7.7-7.7a1.5 1.5 0 0 1 2.1 0Z'],
  'board-trash': ['M3.5 6.5h17M9 6.5V4.2c0-.4.4-.7.8-.7h4.4c.4 0 .8.3.8.7v2.3M6 6.5l.8 13c.1.6.5 1 1.1 1h8.2c.6 0 1-.4 1.1-1l.8-13M10 10v7m4-7v7'],
  'shape-arrow': ['M4 20 20 4M11 4h9v9'],
  'shape-line': ['M4 20 20 4'],
  'shape-circle': ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
  'shape-square': ['M4 4h16v16H4z'],
  'board-paper': ['M6 3h9l3 3v15H6V3ZM14 3v4h4', 'm8.5 16 2-5 2 5m-3.4-1.5h2.8M15.5 11l-1.5 3.2h2.5m-.5-2V16'],
  'board-image': ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M3.5 17l5-5 3.5 3.5 3.5-4 5 5.5', 'M17.5 8.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z'],
  eye: ['M2 12s3.7-6 10-6 10 6 10 6-3.7 6-10 6-10-6-10-6Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0Z'],
  external: ['M13 4h7v7M20 4l-9 9M10 5H5v14h14v-5'],
  move: ['M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3'],
  pen: ['M17 3.5a2.4 2.4 0 0 1 3.4 3.4L8 19.3 3.5 20.5 4.7 16 17 3.5Z', 'M14.5 6l3.5 3.5'],
  fact: ['M12 3l9 5v8l-9 5-9-5V8l9-5Z', 'M8 12l3 3 5-6'],
  decision: ['M6 4v10a3 3 0 0 0 3 3h10M6 4l-3 3M6 4l3 3M19 17l-3-3M19 17l-3 3', 'M12 7h7M16 4l3 3-3 3'],
  preference: ['M12 20 3.5 12a5 5 0 0 1 7-7L12 6.5 13.5 5a5 5 0 0 1 7 7L12 20Z'],
  summary: ['M5 3h14v18H5V3ZM8 7h8M8 11h8M8 15h5'], task: ['M3 5l2 2 4-4M11 5h10M3 12l2 2 4-4M11 12h10M3 19l2 2 4-4M11 19h10'],
  database: ['M21 5c0 2-4 3-9 3S3 7 3 5s4-3 9-3 9 1 9 3Z', 'M3 5v14c0 2 4 3 9 3s9-1 9-3V5M3 12c0 2 4 3 9 3s9-1 9-3'], code: ['M8 5l-6 7 6 7M16 5l6 7-6 7M14 3l-4 18'],
}
export function icon(name, className = '') {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg')
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `icon ${className}` })) svg.setAttribute(key, value)
  if (name === 'board-ink') {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', 'M12 2.2a9.8 9.8 0 1 1 0 19.6 9.8 9.8 0 0 1 0-19.6Zm0 1.6a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Zm0 1.3a6.9 6.9 0 1 1 0 13.8 6.9 6.9 0 0 1 0-13.8ZM8.6 16.2h1.6l.6-1.7h2.4l.6 1.7h1.6L12 7.6l-3.4 8.6Zm2.7-3.1.7-2 .7 2h-1.4Z')
    path.setAttribute('fill', 'currentColor')
    path.setAttribute('stroke', 'none')
    path.setAttribute('fill-rule', 'evenodd')
    svg.append(path)
    return svg
  }
  if (name === 'vault') {
    const shapes = [
      ['M4 13.6 12 20 20 13.6 18.2 12.3 12 17.3 5.8 12.3Z', 'currentColor', '.42'],
      ['M12 4 20 10.4 12 16.8 4 10.4Z', 'currentColor', '1'],
      ['M7.7 10.5 11.9 7.1 13.2 8.2 9 11.6ZM10 12.4 14.2 9 15.6 10 11.3 13.4Z', 'var(--vault-cutout, #f7f8fa)', '1'],
    ]
    for (const [d, fill, opacity] of shapes) { const path = document.createElementNS(ns, 'path'); for (const [key, value] of Object.entries({ d, fill, opacity, stroke: 'none' })) path.setAttribute(key, value); svg.append(path) }
    return svg
  }
  for (const d of paths[name] ?? paths.note) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path) }
  return svg
}
export function installIcons() { document.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon))) }
