// Official, hosted PhET simulations; only these IDs may open a simulation window.
export const SIMULATIONS = [
  { id: 'forces-and-motion-basics', name: '力与运动：基础', topics: '合力、摩擦力、质量与加速度' },
  { id: 'energy-skate-park-basics', name: '能量滑板公园：基础', topics: '动能、势能与能量守恒' },
  { id: 'masses-and-springs', name: '质量与弹簧', topics: '胡克定律、振动、阻尼与能量' },
  { id: 'pendulum-lab', name: '单摆实验', topics: '摆长、重力、振幅与周期' },
]
export function simulationURL(id) {
  if (!SIMULATIONS.some(simulation => simulation.id === id)) throw new Error('请选择已提供的物理仿真')
  return `https://phet.colorado.edu/sims/html/${id}/latest/${id}_zh_CN.html`
}
