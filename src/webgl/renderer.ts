// WebGL2 fragment-shader-based pass renderer.
//
// Owns the OffscreenCanvas + WebGL2 context lifecycle and the texture upload.
// A single `Renderer` instance can render any viz mode by calling `render()`
// with the right shader source and uniforms. Programs are cached by shader
// source string so we don't re-link every frame.
//
// Each source EXR component is uploaded as its own R32F texture. The shader
// reads them as uCh0..uCh3. Putting one component per texture keeps the
// upload logic uniform across passes with 1..4 components.

import { VERT_SHADER } from './shaders';

export interface RendererOptions {
  /** Logical pixel width of the output canvas. */
  width: number;
  /** Logical pixel height of the output canvas. */
  height: number;
}

export interface DrawCall {
  /** Fragment shader source. Vertex shader is fixed. */
  fragSrc: string;
  /** Per-component float arrays, length 1..4. Each array has length width*height. */
  channelData: Float32Array[];
  /** Source EXR width (texture width). */
  srcWidth: number;
  /** Source EXR height (texture height). */
  srcHeight: number;
  /** Scalar uniforms (float). */
  uniformsFloat?: Record<string, number>;
  /** vec2 uniforms (xy pair). */
  uniformsVec2?: Record<string, [number, number]>;
}

export class Renderer {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;

  /** Cache: frag-source -> linked program. */
  private programs = new Map<string, WebGLProgram>();
  /** Cache: program -> { name -> location } for uniform lookups. */
  private uniformLocs = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** Reusable empty VAO so we can issue gl.drawArrays without an attribute array. */
  private vao: WebGLVertexArrayObject;
  /** Compiled, shared vertex shader. */
  private vertShader: WebGLShader;

  constructor(opts: RendererOptions) {
    this.canvas = new OffscreenCanvas(opts.width, opts.height);
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error('WebGL2 not available on this platform');
    }
    this.gl = gl;

    // R32F float-texture support is part of WebGL2 core, but rendering INTO
    // float textures requires EXT_color_buffer_float. We only TEXTURE from
    // R32F (never render TO it), so we don't need that extension. Sampling
    // an R32F via `texture()` is supported without extensions in WebGL2.
    // OES_texture_float_linear gives linear filtering on float textures —
    // we use NEAREST below so we don't depend on it.

    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) throw new Error('createShader(VERTEX_SHADER) failed');
    gl.shaderSource(vs, VERT_SHADER);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs) ?? '<no log>';
      gl.deleteShader(vs);
      throw new Error(`Vertex shader compile failed: ${log}`);
    }
    this.vertShader = vs;

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
  }

  /** Resize the underlying canvas if needed. */
  setSize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** Run a draw call. Side effect: the canvas now holds the rendered image. */
  render(call: DrawCall): void {
    const gl = this.gl;
    const program = this.getProgram(call.fragSrc);
    gl.useProgram(program);

    // Upload each component as its own R32F texture and bind to TEXTURE0..N-1.
    const textures: WebGLTexture[] = [];
    for (let i = 0; i < call.channelData.length; i++) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('createTexture failed');
      textures.push(tex);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        call.srcWidth,
        call.srcHeight,
        0,
        gl.RED,
        gl.FLOAT,
        call.channelData[i],
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const loc = this.uniform(program, `uCh${i}`);
      if (loc) gl.uniform1i(loc, i);
    }

    // Scalar float uniforms.
    if (call.uniformsFloat) {
      for (const [name, value] of Object.entries(call.uniformsFloat)) {
        const loc = this.uniform(program, name);
        if (loc) gl.uniform1f(loc, value);
      }
    }
    // vec2 uniforms.
    if (call.uniformsVec2) {
      for (const [name, value] of Object.entries(call.uniformsVec2)) {
        const loc = this.uniform(program, name);
        if (loc) gl.uniform2f(loc, value[0], value[1]);
      }
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // OpenGL needs an explicit flush before the canvas is read by the host.
    // transferToImageBitmap() does this implicitly, but for direct drawImage
    // consumers we flush here.
    gl.flush();

    // Free textures (one frame, one upload — no caching across renders).
    for (const tex of textures) gl.deleteTexture(tex);
  }

  /** Transfer the canvas contents to an ImageBitmap (transferable). */
  toImageBitmap(): ImageBitmap {
    return this.canvas.transferToImageBitmap();
  }

  /** Look up (and cache) a uniform location on a program. */
  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let cache = this.uniformLocs.get(program);
    if (!cache) {
      cache = new Map();
      this.uniformLocs.set(program, cache);
    }
    if (cache.has(name)) return cache.get(name) ?? null;
    const loc = this.gl.getUniformLocation(program, name);
    cache.set(name, loc);
    return loc;
  }

  /** Compile + link (and cache) a program from a fragment shader source. */
  private getProgram(fragSrc: string): WebGLProgram {
    const cached = this.programs.get(fragSrc);
    if (cached) return cached;

    const gl = this.gl;
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) throw new Error('createShader(FRAGMENT_SHADER) failed');
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs) ?? '<no log>';
      gl.deleteShader(fs);
      throw new Error(`Fragment shader compile failed: ${log}\n\nSource:\n${fragSrc}`);
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(fs);
      throw new Error('createProgram failed');
    }
    gl.attachShader(program, this.vertShader);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(fs); // safe after attach+link

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '<no log>';
      gl.deleteProgram(program);
      throw new Error(`Program link failed: ${log}`);
    }

    this.programs.set(fragSrc, program);
    return program;
  }

  /** Drop all GL resources. Caller's responsibility — there's no GC for these. */
  dispose(): void {
    const gl = this.gl;
    for (const program of this.programs.values()) gl.deleteProgram(program);
    this.programs.clear();
    gl.deleteShader(this.vertShader);
    gl.deleteVertexArray(this.vao);
  }
}
