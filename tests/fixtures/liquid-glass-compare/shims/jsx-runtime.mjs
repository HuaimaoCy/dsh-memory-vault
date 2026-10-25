/**
 * 第三方 dist 用的是自动 JSX 运行时；UMD 版 React 没有它，这里用 createElement 顶替。
 *
 * 有一个坑必须写清楚：`React.createElement(type, config, children)` 的第三个参数是
 * **children 而不是 key**，而且只要传了（哪怕是 undefined），就会覆盖 `config.children`。
 * 早期版本无条件传第三个参数，结果第三方组件渲染出来只有外壳、没有内容、也没有滤镜
 * SVG——看起来像「这个库不生效」，实际是垫片吃掉了它的 children。所以只有真正拿到
 * key 时才把 key 放进 config。
 */
const React = globalThis.React
if (!React) throw new Error('需要先加载 react.production.min.js（UMD）')

const element = (type, props, key) => {
  const config = props ?? {}
  if (key === undefined) return React.createElement(type, config)
  return React.createElement(type, { ...config, key })
}

export const jsx = element
export const jsxs = element
export const Fragment = React.Fragment
