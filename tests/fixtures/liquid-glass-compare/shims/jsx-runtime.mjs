/** 第三方 dist 用的是自动 JSX 运行时；UMD 版没有它，这里用 createElement 顶替。 */
const React = globalThis.React
if (!React) throw new Error('需要先加载 react.production.min.js（UMD）')

export const jsx = (type, props, key) => React.createElement(type, props, key)
export const jsxs = jsx
export const Fragment = React.Fragment
