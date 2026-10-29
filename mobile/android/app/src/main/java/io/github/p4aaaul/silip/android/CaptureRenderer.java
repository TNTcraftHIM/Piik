package io.github.p4aaaul.silip.android;

import android.graphics.SurfaceTexture;
import android.opengl.*;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.nio.*;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

// One Projection retains its latest GPU image. Encoder callbacks never wait for GL swaps.
final class CaptureRenderer {
  static final class Target {
    final Surface surface;
    final int width, height, sourceWidth, sourceHeight;
    final Consumer<RuntimeException> failed;
    final AtomicBoolean refreshQueued = new AtomicBoolean();
    volatile boolean retired;
    volatile boolean enabled = true;
    Target owner;
    Consumer<Long> inputFrame;
    EGLSurface window = EGL14.EGL_NO_SURFACE;
    long timestamp, inputTimestamp;
    int bitrate, framerate;
    boolean recovery = true;
    FrameDropper dropper;

    Target(Surface surface, int width, int height, int sourceWidth, int sourceHeight,
        Consumer<RuntimeException> failed) {
      this.surface = surface;
      this.width = width;
      this.height = height;
      this.sourceWidth = sourceWidth;
      this.sourceHeight = sourceHeight;
      this.failed = failed;
    }
  }

  final Handler callbacks;
  final Consumer<RuntimeException> failedInitialization;
  final HandlerThread thread = new HandlerThread("Silip capture GL");
  final Handler gl;
  final Set<Target> targets = new HashSet<>();
  final float[] transform = new float[16];
  final FloatBuffer vertices =
      ByteBuffer.allocateDirect(16 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
  volatile boolean closing;
  EGLDisplay display = EGL14.EGL_NO_DISPLAY;
  EGLContext context = EGL14.EGL_NO_CONTEXT;
  EGLSurface parking = EGL14.EGL_NO_SURFACE;
  EGLConfig config;
  SurfaceTexture texture;
  Surface input;
  Target current;
  int textureID, program, position, coordinates, matrix;
  boolean hasFrame;
  long frameTimestamp;
  int sourceWidth, sourceHeight;

  CaptureRenderer(Handler callbacks, Consumer<RuntimeException> failedInitialization) {
    this.callbacks = callbacks;
    this.failedInitialization = failedInitialization;
    vertices.put(new float[] {-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1});
    thread.start();
    gl = new Handler(thread.getLooper());
  }

  void select(Target target, Consumer<Surface> bound) {
    gl.post(
        () -> {
          if (closing || target.retired) return;
          if (texture == null) {
            try {
              initialize();
            } catch (RuntimeException error) {
              callbacks.post(() -> { if (!closing) failedInitialization.accept(error); });
              return;
            }
          }
          try {
            if (target.window == EGL14.EGL_NO_SURFACE) {
              target.window =
                  EGL14.eglCreateWindowSurface(
                      display, config, target.surface, new int[] {EGL14.EGL_NONE}, 0);
              require(target.window != EGL14.EGL_NO_SURFACE, "create encoder surface");
              targets.add(target);
              target.dropper = new FrameDropper(target.bitrate, target.framerate);
            }
            // A rotated source must supply its new image before it proves a new format.
            if (sourceWidth != target.sourceWidth || sourceHeight != target.sourceHeight)
              hasFrame = false;
            sourceWidth = target.sourceWidth;
            sourceHeight = target.sourceHeight;
            texture.setDefaultBufferSize(target.width, target.height);
            current = target;
            if (hasFrame) captureFrame();
            callbacks.post(() -> { if (!closing && !target.retired) bound.accept(input); });
            draw(target);
          } catch (RuntimeException error) {
            failed(target, error);
          }
        });
  }

  // Additional renditions sample the same retained texture and keep the original capture size.
  void attach(Target target, Target owner) {
    target.owner = owner;
    gl.post(() -> {
      if (closing || target.retired || owner.retired) return;
      try {
        target.window = EGL14.eglCreateWindowSurface(display, config, target.surface,
            new int[] {EGL14.EGL_NONE}, 0);
        require(target.window != EGL14.EGL_NO_SURFACE, "create derived encoder surface");
        targets.add(target);
        target.dropper = new FrameDropper(target.bitrate, target.framerate);
        draw(target);
      } catch (RuntimeException error) { failed(target, error); }
    });
  }

  void refresh(Target target) {
    if (target == null || closing || target.retired
        || !target.refreshQueued.compareAndSet(false, true)) return;
    gl.post(
        () -> {
          target.refreshQueued.set(false);
          target.recovery = true;
          try {
            if (hasFrame && (target == current || target.owner == current)) captureFrame();
            draw(target);
          } catch (RuntimeException error) {
            failed(target, error);
          }
        });
  }

  void encoded(Target target, int bytes, boolean keyframe) {
    gl.post(() -> {
      if (!closing && !target.retired && target.dropper != null)
        target.dropper.encoded(bytes, keyframe);
    });
  }

  void bitrate(Target target, int bitrate) {
    gl.post(() -> {
      if (!closing && !target.retired && target.dropper != null) target.dropper.bitrate(bitrate);
    });
  }

  void release(Target target, Runnable released) {
    target.retired = true;
    gl.post(
        () -> {
          if (current == target) current = null;
          destroyTarget(target);
          callbacks.post(released);
        });
  }

  void close(Runnable closed) {
    closing = true;
    gl.post(
        () -> {
          current = null;
          if (texture != null) {
            texture.setOnFrameAvailableListener(null);
            texture.release();
          }
          if (input != null) input.release();
          for (Target target : new HashSet<>(targets)) destroyTarget(target);
          if (display != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(display, parking, parking, context);
            if (program != 0) GLES20.glDeleteProgram(program);
            if (textureID != 0) GLES20.glDeleteTextures(1, new int[] {textureID}, 0);
            EGL14.eglMakeCurrent(
                display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (parking != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, parking);
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context);
            EGL14.eglReleaseThread();
            EGL14.eglTerminate(display);
          }
          callbacks.post(closed);
          thread.quitSafely();
        });
  }

  void initialize() {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    require(display != EGL14.EGL_NO_DISPLAY, "get EGL display");
    int[] versions = new int[2];
    require(EGL14.eglInitialize(display, versions, 0, versions, 1), "initialize EGL");
    EGLConfig[] configs = new EGLConfig[1];
    int[] count = new int[1];
    require(
        EGL14.eglChooseConfig(
            display,
            new int[] {
              EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
              EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT | EGL14.EGL_PBUFFER_BIT,
              EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
              0x3142, 1, // EGL_RECORDABLE_ANDROID
              EGL14.EGL_NONE
            },
            0, configs, 0, 1, count, 0) && count[0] > 0,
        "choose recordable EGL config");
    config = configs[0];
    context =
        EGL14.eglCreateContext(
            display, config, EGL14.EGL_NO_CONTEXT,
            new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE}, 0);
    require(context != EGL14.EGL_NO_CONTEXT, "create GL context");
    parking =
        EGL14.eglCreatePbufferSurface(
            display, config,
            new int[] {EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE}, 0);
    require(parking != EGL14.EGL_NO_SURFACE, "create GL parking surface");
    makeCurrent(parking);
    program = GLES20.glCreateProgram();
    int vertex = shader(GLES20.GL_VERTEX_SHADER,
        "attribute vec4 position; attribute vec4 coordinates; uniform mat4 transform;"
            + "varying vec2 uv; void main(){gl_Position=position;uv=(transform*coordinates).xy;}");
    int fragment = shader(GLES20.GL_FRAGMENT_SHADER,
        "#extension GL_OES_EGL_image_external : require\nprecision mediump float;"
            + "uniform samplerExternalOES image; varying vec2 uv;"
            + "void main(){gl_FragColor=texture2D(image,uv);}");
    GLES20.glAttachShader(program, vertex);
    GLES20.glAttachShader(program, fragment);
    GLES20.glLinkProgram(program);
    GLES20.glDeleteShader(vertex);
    GLES20.glDeleteShader(fragment);
    int[] linked = new int[1];
    GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0);
    require(linked[0] != 0, "link texture program");
    position = GLES20.glGetAttribLocation(program, "position");
    coordinates = GLES20.glGetAttribLocation(program, "coordinates");
    matrix = GLES20.glGetUniformLocation(program, "transform");
    int[] names = new int[1];
    GLES20.glGenTextures(1, names, 0);
    textureID = names[0];
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureID);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
    texture = new SurfaceTexture(textureID);
    input = new Surface(texture);
    texture.setOnFrameAvailableListener(
        ignored -> {
          if (closing) return;
          Target target = current;
          try {
            makeCurrent(parking);
            texture.updateTexImage();
            texture.getTransformMatrix(transform);
            hasFrame = true;
            captureFrame();
            for (Target output : new HashSet<>(targets)) {
              try { draw(output); } catch (RuntimeException error) { failed(output, error); }
            }
          } catch (RuntimeException error) {
            if (target != null) failed(target, error);
          }
        }, gl);
  }

  void captureFrame() {
    frameTimestamp = Math.max(System.nanoTime(), frameTimestamp + 1000);
    Target owner = current;
    if (owner != null && owner.inputFrame != null) {
      long timestamp = frameTimestamp / 1000;
      callbacks.post(() -> { if (!closing && !owner.retired) owner.inputFrame.accept(timestamp); });
    }
  }

  void draw(Target target) {
    if (closing || target == null || (current != target && current != target.owner) || target.retired || !target.enabled || !hasFrame) return;
    if (frameTimestamp <= target.inputTimestamp) return;
    target.inputTimestamp = frameTimestamp;
    if (!target.dropper.shouldEncode(frameTimestamp, target.recovery)) return;
    makeCurrent(target.window);
    GLES20.glViewport(0, 0, target.width, target.height);
    GLES20.glUseProgram(program);
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureID);
    vertices.position(0);
    GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 16, vertices);
    vertices.position(2);
    GLES20.glVertexAttribPointer(coordinates, 2, GLES20.GL_FLOAT, false, 16, vertices);
    GLES20.glEnableVertexAttribArray(position);
    GLES20.glEnableVertexAttribArray(coordinates);
    GLES20.glUniformMatrix4fv(matrix, 1, false, transform, 0);
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
    target.timestamp = frameTimestamp;
    require(EGLExt.eglPresentationTimeANDROID(display, target.window, target.timestamp), "set presentation time");
    // This can wait for codec input space. Its output callbacks run on another thread.
    require(EGL14.eglSwapBuffers(display, target.window), "submit encoder image");
    target.recovery = false;
    require(GLES20.glGetError() == GLES20.GL_NO_ERROR, "render captured image");
  }

  void destroyTarget(Target target) {
    if (target.dropper != null) {
      target.dropper.close();
      target.dropper = null;
    }
    if (target.window == EGL14.EGL_NO_SURFACE) return;
    // Teardown still attempts every owned release after an EGL failure.
    EGL14.eglMakeCurrent(display, parking, parking, context);
    EGL14.eglDestroySurface(display, target.window);
    target.window = EGL14.EGL_NO_SURFACE;
    targets.remove(target);
  }

  void makeCurrent(EGLSurface surface) {
    require(EGL14.eglMakeCurrent(display, surface, surface, context), "make GL context current");
  }

  void failed(Target target, RuntimeException error) {
    callbacks.post(() -> { if (!closing && !target.retired) target.failed.accept(error); });
  }

  static int shader(int type, String source) {
    int shader = GLES20.glCreateShader(type);
    GLES20.glShaderSource(shader, source);
    GLES20.glCompileShader(shader);
    int[] compiled = new int[1];
    GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0);
    if (compiled[0] == 0) {
      String error = GLES20.glGetShaderInfoLog(shader);
      GLES20.glDeleteShader(shader);
      throw new IllegalStateException("Capture shader failed: " + error);
    }
    return shader;
  }

  static void require(boolean passed, String operation) {
    if (!passed) throw new IllegalStateException("Could not " + operation);
  }
}
