package tv.piik.android;

import android.media.AudioRecord;

// One admitted PCM input owns its recorder and reader until close joins it.
final class CapturedAudio {
  final long id;
  final tv.piik.androidbridge.Runtime runtime;

  CapturedAudio(long id, tv.piik.androidbridge.Runtime runtime) {
    this.id = id;
    this.runtime = runtime;
  }

  AudioRecord recorder;
  volatile boolean stopped;
  Thread reader;

  void start(int channels) {
    CapturedAudio input = this;
    input.reader =
        new Thread(
            () -> {
              byte[] bytes = new byte[960 * channels * 2];
              byte[] stereo = channels == 2 ? bytes : new byte[3840];
              try {
                while (!input.stopped) {
                  int offset = 0;
                  while (offset < bytes.length && !input.stopped) {
                    int count =
                        input.recorder.read(
                            bytes, offset, bytes.length - offset, AudioRecord.READ_BLOCKING);
                    if (count <= 0) throw new IllegalStateException("AudioRecord stopped");
                    offset += count;
                  }
                  if (!input.stopped) {
                    if (channels == 1)
                      for (int sample = 0; sample < 960; sample++) {
                        stereo[sample * 4] = stereo[sample * 4 + 2] = bytes[sample * 2];
                        stereo[sample * 4 + 1] = stereo[sample * 4 + 3] = bytes[sample * 2 + 1];
                      }
                    input.runtime.audio(input.id, stereo);
                  }
                }
              } catch (Exception error) {
                if (!input.stopped) input.runtime.captureEnded(input.id);
              }
            },
            "Piik captured audio");
    input.reader.start();
    input.runtime.audioReady(input.id);
    AppRuntimeService.prepared(input.runtime, input.id);
  }

  static void close(CapturedAudio value) {
    if (value == null || value.stopped) return;
    value.stopped = true;
    // A full Go frame queue can block the JNI producer independently of AudioRecord.
    value.runtime.captureEnded(value.id);
    AppRuntimeService.failed(value.runtime, value.id);
    if (value.recorder != null) {
      try {
        value.recorder.stop();
      } catch (Exception ignored) {
      }
    }
    if (value.reader != null) {
      try {
        value.reader.join(1000);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
      }
    }
    if (value.recorder != null) {
      try {
        value.recorder.release();
      } catch (Exception ignored) {
      }
    }
  }
}
