const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches

/** Lift, travel raised, then land; interruptions retain presentation and velocity. */
export function createSelectionMotion(lens,{horizontal=false}={}) {
  const s={x:0,y:0,vx:0,vy:0,lift:0,vl:0,toX:0,toY:0,phase:'idle',pressed:false,optical:false,frame:0,last:0}
  const paint=()=>{
    lens.style.transform=`translate3d(${s.x}px,${s.y}px,0) scale(${1+s.lift*(horizontal ? .14 : .045)},${1+s.lift*(horizontal ? .32 : .16)})`
    lens.dataset.motionState=s.phase
  }
  const optical=value=>{
    if(s.optical===value)return
    s.optical=value;lens.dataset.lensPressed=String(value)
    lens.dispatchEvent(new CustomEvent('glass:lens-press',{bubbles:true,detail:{pressed:value}}))
  }
  const stop=()=>{cancelAnimationFrame(s.frame);s.frame=0;s.last=0}
  const finish=()=>{stop();s.x=s.toX;s.y=s.toY;s.lift=0;s.vx=s.vy=s.vl=0;s.phase='idle';s.pressed=false;optical(false);paint()}
  const integrate=(key,velocity,target,dt,response)=>{
    const omega=2*Math.PI/response
    s[velocity]+=(-omega*omega*(s[key]-target)-2*omega*s[velocity])*dt
    s[key]+=s[velocity]*dt
  }
  const step=now=>{
    s.frame=0
    const elapsed=s.last?Math.min(32,now-s.last):16;s.last=now
    const travelling=s.phase==='moving'||s.phase==='settling',slices=Math.ceil(elapsed)
    for(let i=0;i<slices;i++){
      const dt=elapsed/1000/slices
      integrate('lift','vl',s.phase==='settling'?0:1,dt,.22)
      if(travelling){integrate('x','vx',s.toX,dt,.3);integrate('y','vy',s.toY,dt,.3)}
    }
    const distance=Math.hypot(s.toX-s.x,s.toY-s.y)
    if(s.phase==='lifting'&&s.lift>=.72)s.phase=distance>.25?'moving':s.pressed?'held':'settling'
    if(s.phase==='moving'&&distance<.8&&Math.hypot(s.vx,s.vy)<32)s.phase=s.pressed?'held':'settling'
    if(s.phase==='settling'&&distance<.08&&Math.abs(s.lift)<.002&&Math.abs(s.vl)<.05){finish();return}
    paint()
    if(s.phase!=='idle'&&s.phase!=='tracking'&&!(s.phase==='held'&&Math.abs(s.lift-1)<.002&&Math.abs(s.vl)<.05))s.frame=requestAnimationFrame(step)
  }
  const run=()=>{if(!s.frame){s.last=0;s.frame=requestAnimationFrame(step)}}
  return {
    state:s,
    move(x,y,animate){
      const changed=Math.abs(s.toX-x)>.1||Math.abs(s.toY-y)>.1
      s.toX=x;s.toY=y
      if(!animate||reduced()){finish();return}
      if(!changed&&s.phase!=='tracking')return
      s.phase=s.lift<.72?'lifting':'moving';optical(true);run()
    },
    press(value){
      if(reduced())return
      s.pressed=Boolean(value)
      if(value){optical(true);if(s.phase==='idle'||s.phase==='settling')s.phase='lifting'}
      else if(s.phase==='held'||s.phase==='tracking')s.phase=Math.hypot(s.toX-s.x,s.toY-s.y)>.25?'moving':'settling'
      if(s.phase!=='idle')run()
    },
    track(x,y){stop();s.x=x;s.y=y;s.vx=s.vy=0;s.lift=reduced()?0:Math.max(.85,s.lift);s.vl=0;s.phase='tracking';paint()},
    finish,destroy:stop,
  }
}
