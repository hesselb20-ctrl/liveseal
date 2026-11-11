// WebGL2 implementation of the seal embedder. Draws a video frame to a canvas
// and adds the per-cell offsets of all three planes in one fragment shader.
// The formulas mirror `Embedder` in core/src/modem.ts (the CPU twin that the
// simulator and the unit tests use).

import type { ModemLayout } from '../core/src/modem.ts';
import { RGB_CHROMA_GAIN, RGB_LUMA_GAIN } from '../core/src/pixels.ts';

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform sampler2D uField;   // gridW x gridH texels, rgb = offsets for Y, Cb, Cr in 8-bit levels
uniform vec2 uGrid;
uniform float uEdge;
uniform float uSeed;
uniform float uEnabled;
uniform vec2 uGain;         // luma gain, chroma gain
in vec2 vUv;
out vec4 outColor;

float smooth01(float t) {
  t = clamp(t, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// For one axis: the two cells that blend at this position and the weight of the second.
vec3 pick(float u, float cells) {
  float i = min(cells - 1.0, floor(u));
  float f = u - i;
  float h = uEdge * 0.5;
  if (uEdge > 0.0 && f < h && i > 0.0) return vec3(i - 1.0, i, smooth01(f / uEdge + 0.5));
  if (uEdge > 0.0 && f > 1.0 - h && i < cells - 1.0) return vec3(i, i + 1.0, smooth01((f - (1.0 - h)) / uEdge));
  return vec3(i, i, 1.0);
}

vec3 cell(float x, float y) {
  return texelFetch(uField, ivec2(int(x), int(y)), 0).rgb;
}

float hash(vec2 p, float s) {
  return fract(sin(dot(p + s, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 src = texture(uFrame, vUv).rgb;
  vec3 ax = pick(vUv.x * uGrid.x, uGrid.x);
  vec3 ay = pick((1.0 - vUv.y) * uGrid.y, uGrid.y);   // row 0 of the field is the top of the picture
  vec3 top = mix(cell(ax.x, ay.x), cell(ax.y, ay.x), ax.z);
  vec3 bottom = mix(cell(ax.x, ay.y), cell(ax.y, ay.y), ax.z);
  vec3 d = mix(top, bottom, ay.z);
  float dy = d.x * uGain.x;
  float dcb = d.y * uGain.y;
  float dcr = d.z * uGain.y;
  // BT.601: change Y, Cb, Cr without touching the others
  vec3 rgb = vec3(dy + 1.402 * dcr, dy - 0.344136 * dcb - 0.714136 * dcr, dy + 1.772 * dcb) / 255.0;
  // half a level of dither keeps fractional offsets right on average after 8-bit rounding
  vec3 dither = (vec3(hash(gl_FragCoord.xy, uSeed), hash(gl_FragCoord.yx, uSeed + 3.1), hash(gl_FragCoord.xy, uSeed + 7.7)) - 0.5) / 255.0;
  outColor = vec4(src + uEnabled * (rgb + dither), 1.0);
}`;

export type GlCanvas = HTMLCanvasElement | OffscreenCanvas;

export class GlSealer {
  readonly canvas: GlCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly layout: ModemLayout;
  private readonly frameTex: WebGLTexture;
  private readonly fieldTex: WebGLTexture;
  private readonly fieldData: Float32Array;
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};

  constructor(layout: ModemLayout, canvas: GlCanvas) {
    this.layout = layout;
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, desynchronized: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const program = gl.createProgram() as WebGLProgram;
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type) as WebGLShader;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uFrame', 'uField', 'uGrid', 'uEdge', 'uSeed', 'uEnabled', 'uGain']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.frameTex = gl.createTexture() as WebGLTexture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fieldTex = gl.createTexture() as WebGLTexture;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fieldData = new Float32Array(layout.planeCells * 4);
    gl.uniform1i(this.uniforms.uFrame, 0);
    gl.uniform1i(this.uniforms.uField, 1);
    gl.uniform2f(this.uniforms.uGrid, layout.params.gridW, layout.params.gridH);
    gl.uniform1f(this.uniforms.uEdge, layout.params.edge);
    gl.uniform2f(this.uniforms.uGain, RGB_LUMA_GAIN, RGB_CHROMA_GAIN);
  }

  /**
   * Draws `source` at the canvas size with the seal added.
   * `field` holds the per-cell offsets of all planes (SenderSession.field).
   */
  draw(source: TexImageSource, width: number, height: number, field: Float32Array, frameIndex: number, enabled = true): void {
    const { gl, layout } = this;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const pc = layout.planeCells;
    const three = layout.params.planes === 3;
    for (let c = 0; c < pc; c++) {
      this.fieldData[c * 4] = field[c];
      this.fieldData[c * 4 + 1] = three ? field[pc + c] : 0;
      this.fieldData[c * 4 + 2] = three ? field[2 * pc + c] : 0;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, layout.params.gridW, layout.params.gridH, 0, gl.RGBA, gl.FLOAT, this.fieldData);
    gl.uniform1f(this.uniforms.uSeed, (frameIndex % 1024) * 0.37);
    gl.uniform1f(this.uniforms.uEnabled, enabled ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Reads back the canvas (for tests that compare the shader with the CPU twin). */
  readPixels(): Uint8Array {
    const { gl } = this;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
}
