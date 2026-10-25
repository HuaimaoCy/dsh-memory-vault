/**
 * 把 UMD 版 React 18 暴露成 ESM 名字，供第三方 `@xiaojiaenen/liquid-glass` 的
 * dist ESM 直接加载（它的 dist 里是裸说明符 `from "react"`）。
 *
 * 这样做是为了「用原版、不改一行源码」地跑对照：不 bundler、不转译、不把它的
 * 组件重写成 vanilla。重写等于我自己做的材质层，就失去了对照组的意义。
 */
const React = globalThis.React
if (!React) throw new Error('需要先加载 react.production.min.js（UMD）')

const pick = name => {
  const value = React[name]
  if (typeof value !== 'function') throw new Error(`React UMD 里没有 ${name}`)
  return value
}

export const useCallback = pick('useCallback')
export const useContext = pick('useContext')
export const useEffect = pick('useEffect')
export const useId = pick('useId')
export const useLayoutEffect = pick('useLayoutEffect')
export const useMemo = pick('useMemo')
export const useRef = pick('useRef')
export const useState = pick('useState')
export const createContext = pick('createContext')
export const forwardRef = pick('forwardRef')
export const memo = pick('memo')
export const Fragment = React.Fragment
export default React
