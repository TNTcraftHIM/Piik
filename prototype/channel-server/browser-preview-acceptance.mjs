// Capture only this test's own window; no desktop or unrelated application image.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function nativePreviews({ room, browser, action, view, evaluate, until, playing, progressing, hook, output, directory }) {
  assert.equal(process.platform, "win32", "This fixture needs an interactive Windows desktop");
  const title = `Piik preview fixture ${randomUUID()}`;
  const script = join(directory, "preview-window.ps1");
  await writeFile(script, `param([string]$Title)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.ClientSize = New-Object System.Drawing.Size(640,360)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80,80)
$form.ShowInTaskbar = $false
$font = New-Object System.Drawing.Font('Segoe UI',28)
$form.add_Paint({ param($sender,$paint)
  $paint.Graphics.DrawString('Piik native preview',$font,[System.Drawing.Brushes]::White,45,130)
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.add_Tick({
  $tick = [DateTime]::UtcNow.Millisecond
  $form.BackColor = [System.Drawing.Color]::FromArgb(30,80 + [int]($tick / 10),120)
})
try { $timer.Start(); [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $font.Dispose(); $form.Dispose() }
`);
  const fixture = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, title],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  fixture.stderr.on("data", chunk => { errors += chunk; });
  try {
    const target = await until("owned preview window is selectable", async () => {
      if (fixture.exitCode !== null) throw new Error(errors);
      const sources = await action(1, "nativeSources()");
      return sources.sources.find(source => source.title === title);
    }, Boolean);
    const source = JSON.stringify(target);
    const first = await evaluate(1, `(async () => {
      const started = performance.now();
      const data = await ${hook}.session.nativePreview(${source});
      if (!data) throw new Error('Owned window produced no preview');
      const image = new Image(); image.src = data; await image.decode();
      return {data,width:image.naturalWidth,height:image.naturalHeight,elapsed:performance.now()-started};
    })()`);
    assert(first.width > 0 && first.width <= 320 && first.height > 0 && first.height <= 180);
    assert(first.data.length <= 87407);
    await writeFile(join(output, "native-preview.jpg"), Buffer.from(first.data.split(",")[1], "base64"));

    await action(1, `startNativeScreen(${JSON.stringify(room)}, ${source}, false)`);
    const shared = await until("Native source is published", () => view(0), value => value.state.publications.some(publication => publication.roomId === room));
    const publication = shared.state.publications.find(publication => publication.roomId === room).id;
    await action(0, `browse(${JSON.stringify(room)})`);
    await action(0, `watch(${JSON.stringify(publication)})`);
    await playing(0, publication);

    const during = await evaluate(1, `(async () => {
      const before = ${hook}.snapshot().state.publications.map(source => source.id);
      const abort = new AbortController();
      const cancelled = ${hook}.session.nativePreview(${source}, abort.signal);
      await new Promise(resolve => setTimeout(resolve,25)); abort.abort();
      const cancelledImage = await cancelled;
      const data = await ${hook}.session.nativePreview(${source});
      const invalid = await ${hook}.session.nativePreview({...${source},sourceId:'0'});
      return {before,after:${hook}.snapshot().state.publications.map(source => source.id),cancelled:cancelledImage===null,resumed:!!data,invalid};
    })()`);
    assert.deepEqual(during.after, during.before, "previews do not replace or retire publications");
    assert(during.cancelled && during.resumed && during.invalid === null);
    await progressing(0, publication);

    // Keep this real picker acceptance confined to the fixture's own window.
    await evaluate(1, `(() => {
      const session = ${hook}.session, sources = session.nativeSources, preview = session.nativePreview;
      window.__previewPicker = {requests:[],restore:()=>{session.nativeSources=sources;session.nativePreview=preview;session.clearError();}};
      session.nativeSources = async () => ({...await sources(),sources:[${source}]});
      session.nativePreview = (target,signal) => {
        const request = {signal}; window.__previewPicker.requests.push(request);
        request.done = preview(target,signal); return request.done;
      };
      session.clearError(); return true;
    })()`);
    await browser(1, "click", '.c3-room-link[aria-label="Preview room"]');
    const pickerCancelled = await evaluate(1, `(async () => {
      document.querySelector('.c3-share-control button').click();
      const deadline = performance.now()+5000;
      while (!window.__previewPicker.requests.length && performance.now()<deadline)
        await new Promise(resolve=>requestAnimationFrame(resolve));
      const request = window.__previewPicker.requests[0];
      if (!request) throw new Error('Picker did not request its visible source');
      document.querySelector('.c3-share-picker button[aria-label="Cancel"]').click();
      const image = await request.done;
      return request.signal.aborted && image===null;
    })()`);
    assert(pickerCancelled, "closing the normal picker cancels its in-flight thumbnail");
    await browser(1, "click", ".c3-share-control button");
    await until("normal picker displays its Native thumbnail", () => evaluate(1,
      "!!document.querySelector('.c3-share-picker [data-native-source] img')?.naturalWidth"), Boolean);
    await browser(1, "screenshot", join(output,"native-preview-picker.png"));
    await browser(1, "press", "Escape");
    await evaluate(1, "(() => { window.__previewPicker.restore(); delete window.__previewPicker; return true; })()");
    await progressing(0, publication);
    await action(1, `stopScreen(${JSON.stringify(publication)})`);
    await until("explicit stop retires the Native publication", () => view(0), value => !value.state.publications.some(source => source.id === publication));
    await evaluate(1, `(async () => {
      const pending = ${hook}.session.nativePreview(${source});
      await new Promise(resolve => setTimeout(resolve,25)); ${hook}.session.close();
      await pending; return true;
    })()`);
    await browser(1, "reload");
    await until("page reopens the same App after preview cancellation", () => evaluate(1, `${hook}?.snapshot().appConnected ?? false`), Boolean);
    assert(await action(1, `nativePreview(${source})`));
    await writeFile(join(output, "native-preview-result.json"), JSON.stringify({ passed:true,
      width:first.width,height:first.height,dataUrlBytes:first.data.length,firstFrameMs:Math.round(first.elapsed),
      cancelled:true,pickerCancelled,invalidSource:true,activePublicationRetained:true,pageCloseAndReopen:true },null,2));
  } finally {
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture,"exit"); fixture.kill(); await exited;
    }
  }
}
