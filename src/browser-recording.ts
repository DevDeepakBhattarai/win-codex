import { spawn } from "node:child_process";
import { once } from "node:events";
import { rename, writeFile } from "node:fs/promises";

/** One current JPEG plus a bounded encoder pipe, regardless of recording length. */
export async function startVideo(filePath: string, firstFrame: string, onFinished: () => void) {
  const temporaryPath = `${filePath}.partial.webm`;
  const encoder = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", "10",
    "-vcodec", "mjpeg", "-i", "pipe:0", "-an", "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1200k", temporaryPath,
  ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let error = "";
  let stderr = "";
  let latestFrame = Buffer.from(firstFrame, "base64");
  let frames = 0;
  let stopped: Promise<VideoResult> | undefined;
  const startedAt = new Date().toISOString();
  const closed = new Promise<number | null>((resolve) => encoder.once("close", resolve));
  encoder.on("error", (cause) => { error = cause.message; });
  encoder.stdin.on("error", (cause) => { error ||= cause.message; });
  encoder.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try { await once(encoder, "spawn"); }
  catch { throw new Error(`Video recording requires FFmpeg. Install it or set FFMPEG_PATH. ${error}`); }

  const writeFrame = () => {
    if (encoder.stdin.destroyed || encoder.stdin.writableNeedDrain || encoder.exitCode !== null) return;
    encoder.stdin.write(latestFrame);
    frames++;
  };
  writeFrame();
  const timer = setInterval(writeFrame, 100);
  timer.unref();
  const stop = () => {
    stopped ??= (async () => {
      clearInterval(timer);
      clearTimeout(limit);
      encoder.stdin.end();
      const timeout = setTimeout(() => { error ||= "Video encoder did not finish within 10 seconds."; encoder.kill(); }, 10_000);
      const code = await closed;
      clearTimeout(timeout);
      if (code !== 0) error ||= stderr || `Video encoder exited with code ${code}.`;
      if (!error) await rename(temporaryPath, filePath);
      const result: VideoResult = { path: error ? temporaryPath : filePath, startedAt,
        stoppedAt: new Date().toISOString(), frames, status: error ? "failed" : "saved", ...(error ? { error } : {}) };
      await writeFile(`${filePath}.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      onFinished();
      return result;
    })();
    return stopped;
  };
  const limit = setTimeout(() => void stop().catch(console.error), 30 * 60_000);
  limit.unref();
  encoder.once("close", () => { void stop().catch(console.error); });
  return {
    update(data: string) { if (!stopped) latestFrame = Buffer.from(data, "base64"); },
    status() { return { path: filePath, startedAt, frames, status: stopped ? "stopped" : "recording", ...(error ? { error } : {}) }; },
    stop,
  };
}

type VideoResult = { path: string; startedAt: string; stoppedAt: string; frames: number; status: "saved" | "failed"; error?: string };
