/** UMD 版 ReactDOM 的 createRoot 转成 ESM。 */
const ReactDOM = globalThis.ReactDOM
if (!ReactDOM) throw new Error('需要先加载 react-dom.production.min.js（UMD）')

export const createRoot = container => ReactDOM.createRoot(container)
export const createPortal = (...args) => ReactDOM.createPortal(...args)
export const flushSync = (...args) => ReactDOM.flushSync(...args)
export default ReactDOM
