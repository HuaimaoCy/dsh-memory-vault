// 光学核心（GLSL ES 3.00）—— 与 webgl.js 里的字符串保持同步。
// 单 pass 画整屏：参数化环境背景 + 任意数量玻璃形状的折射 / Fresnel / 描边。
//
// 约定：坐标以 CSS px 传入，gl_FragCoord 在 WebGL 里 y 向上，所以这里统一用
// uRes.y - gl_FragCoord.y 翻成 DOM 的 y 向下，避免在别处再翻一次。

#version 300 es
precision highp float;

uniform vec2 uRes;
uniform int uCount;
uniform vec4 uShapes[8];   // x, y, w, h（左上角原点，y 向下）
uniform float uRadii[8];
uniform float uBezel;
uniform float uThickness;
uniform float uIOR;
uniform float uDispersion;

out vec4 fragColor;

float sdRoundRect(vec2 p, vec2 halfSize, float radius) {
  float r = min(radius, min(halfSize.x, halfSize.y));
  vec2 q = abs(p) - (halfSize - vec2(r));
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// 环境背景：与 replica.css 的 --ambient-* 同一套三段渐变 + 两团极淡径向色
vec3 ambient(vec2 uv) {
  vec3 a = vec3(0.906, 0.945, 0.929); // #e7f1ed
  vec3 b = vec3(0.961, 0.965, 0.953); // #f5f6f3
  vec3 c = vec3(0.929, 0.945, 0.980); // #edf1fa
  float t = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
  vec3 base = mix(mix(a, b, smoothstep(0.0, 0.52, t)), c, smoothstep(0.52, 1.0, t));
  float warm = smoothstep(0.62, 0.0, length(uv - vec2(0.06, 0.04)));
  float cool = smoothstep(0.62, 0.0, length(uv - vec2(0.96, 0.96)));
  return base + vec3(1.0, 0.965, 0.925) * warm * 0.10 + vec3(0.910, 0.941, 1.0) * cool * 0.08;
}

// 高度场：smoothstep 剖面，中心平坦、边缘连续过渡
float heightAt(float d) {
  float t = clamp(-d / max(uBezel, 0.001), 0.0, 1.0);
  return uThickness * smoothstep(0.0, 1.0, t);
}

// 对某个形状求「该像素应采样的背景坐标」。返回 vec3(px, py, 是否在玻璃内)
vec3 lens(vec2 fragPx, vec4 shape, float radius) {
  vec2 center = shape.xy + shape.zw * 0.5;
  vec2 halfSize = shape.zw * 0.5;
  float d = sdRoundRect(fragPx - center, halfSize, radius);
  if (d > 0.0) return vec3(fragPx, 0.0);
  // 法线 = 高度场梯度：解析 SDF 梯度 + 链式法则（与 surface.js 的 CPU 版对齐）
  float e = 1.0;
  float hC = heightAt(d);
  float hX = heightAt(sdRoundRect(fragPx + vec2(e, 0.0) - center, halfSize, radius));
  float hY = heightAt(sdRoundRect(fragPx + vec2(0.0, e) - center, halfSize, radius));
  vec3 N = normalize(vec3(-(hX - hC) / e, -(hY - hC) / e, 1.0));
  vec3 I = vec3(0.0, 0.0, -1.0);
  vec3 T = refract(I, N, 1.0 / max(uIOR, 1.0001));
  vec2 delta = T.xy * hC / max(-T.z, 0.01);
  return vec3(fragPx + delta, 1.0);
}

void main() {
  vec2 fragPx = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = fragPx / uRes;
  vec3 color = ambient(uv);
  float inGlass = 0.0;
  float edge = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec4 shape = uShapes[i];
    float radius = uRadii[i];
    vec3 lensed = lens(fragPx, shape, radius);
    if (lensed.z > 0.5) {
      // 折射：在位移后的坐标重新取环境色（可控背景 → 可以任意坐标求值，不需要纹理）
      vec3 refracted = ambient(clamp(lensed.xy / uRes, 0.0, 1.0));
      // Fresnel 边缘增亮
      vec2 center = shape.xy + shape.zw * 0.5;
      float d = sdRoundRect(fragPx - center, shape.zw * 0.5, radius);
      float t = clamp(-d / max(uBezel, 0.001), 0.0, 1.0);
      float slope = 6.0 * t * (1.0 - t);
      float fresnel = 0.04 + 0.96 * pow(1.0 - clamp(slope, 0.0, 1.0), 5.0);
      color = mix(color, refracted, 0.86);
      color = mix(color, vec3(1.0), fresnel * 0.45);
      inGlass = 1.0;
      edge = max(edge, smoothstep(0.02, 0.0, abs(d) / 3.0));
    }
  }
  // 玻璃边缘的亮白描边（对应 CSS 里的 1.5px 白边）
  color = mix(color, vec3(1.0), edge * 0.55);
  fragColor = vec4(color, 1.0);
}
