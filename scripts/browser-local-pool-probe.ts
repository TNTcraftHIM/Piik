import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CdpConnection, cleanupRun, createPage, evaluate, launchChrome, reservePort, waitForSample, waitForVersion } from './browser-gate-harness';
import { createPoolShaper } from './browser-pool-shaper.mjs';
const mode = process.argv[2] || 'quiet';
if (!['ordinary', 'quiet', 'live', 'carrier'].includes(mode))
    throw Error('Expected ordinary|quiet|live|carrier');
const weak = process.argv.includes('--weak');
const codec = process.argv.includes('--h264') ? 'H264' : 'VP8';
const network = process.argv.includes('--network');
const split = process.argv.includes('--split');
const noLocalDecode = process.argv.includes('--no-local-decode');
const derive = process.argv.includes('--derive');
const feedback = process.argv.includes('--feedback');
const late = process.argv.includes('--late');
const automatic = process.argv.includes('--auto');
const high = process.argv.includes('--1080');
const noLocalPli = process.argv.includes('--no-local-pli');
const root = resolve(import.meta.dirname, '..');
const body = await readFile(join(root, 'scripts/browser-local-pool-page.js'));
let cdp: CdpConnection | null = null;
const shaper = network ? await createPoolShaper() : null;
const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname === '/process' && cdp) {
        void cdp.call<{
            processInfo: Array<{
                cpuTime: number;
            }>;
        }>('SystemInfo.getProcessInfo', {}, undefined, Date.now() + 3000).then(info => response.end(JSON.stringify({ cpuSeconds: info.processInfo.reduce((sum, p) => sum + p.cpuTime, 0) })), () => response.end('{}'));
        return;
    }
    if (url.pathname === '/shaper' && shaper) {
        if (url.searchParams.has('left'))
            shaper.setTargets(Number(url.searchParams.get('left')), Number(url.searchParams.get('right')));
        if (url.searchParams.has('rate'))
            shaper.setRate(Number(url.searchParams.get('rate')));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ports: shaper.ports, stats: shaper.stats() }));
        return;
    }
    response.setHeader('Content-Type', request.url === '/probe.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/probe.js' ? body : '<!doctype html><meta charset=utf-8><title>Browser local pool</title><script type=module src=/probe.js></script>');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as {
    port: number;
}).port, debugPort = await reservePort();
const profile = await mkdtemp(join(tmpdir(), 'screener-client-media-'));
const chrome = launchChrome(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', debugPort, profile, ['--headless=new', '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
chrome.stdout.resume();
chrome.stderr.resume();
let result: Record<string, unknown> = { mode, codec };
try {
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 5000);
    const page = await createPage(cdp, `http://127.0.0.1:${port}/?mode=${mode}&codec=${codec}&weak=${weak || network ? 1 : 0}&network=${network ? 1 : 0}&split=${split ? 1 : 0}&noLocalDecode=${noLocalDecode ? 1 : 0}&derive=${derive ? 1 : 0}&feedback=${feedback ? 1 : 0}&late=${late ? 1 : 0}&automatic=${automatic ? 1 : 0}&high=${high ? 1 : 0}&noLocalPli=${noLocalPli ? 1 : 0}`);
    await waitForSample(() => evaluate<boolean>(cdp!, page, 'window.probeDone===true', Date.now() + 2000), Boolean, feedback || automatic ? 110000 : weak || network ? 60000 : 25000);
    result = await evaluate<Record<string, unknown>>(cdp, page, 'window.probeResult', Date.now() + 3000);
}
catch (error) {
    result.error = String(error);
}
finally {
    const clean = await cleanupRun({ cdp, native: null, chrome, server: { close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }, profile, ports: [port, debugPort] });
    if (shaper) {
        result.shaper = shaper.stats();
        await shaper.close();
    }
    result.probeSha256 = createHash('sha256').update(body).digest('hex');
    result.cleanup = clean;
    await mkdir(join(root, 'build/browser-local-pool'), { recursive: true });
    const output = join(root, `build/browser-local-pool/${mode}-${codec.toLowerCase()}${network ? '-network' : weak ? '-weak' : ''}${split ? '-split' : ''}${noLocalDecode ? '-no-local-decode' : ''}${derive ? '-derive' : ''}${feedback ? '-feedback' : ''}${late ? '-late' : ''}${automatic ? '-auto' : ''}${high ? '-1080' : ''}${noLocalPli ? '-no-local-pli' : ''}-${Date.now()}.json`);
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ mode, codec, weak, error: result.error ?? null, counts: result.counts, output, cleanup: clean }));
    if (result.error || (result.errors as string[] | undefined)?.length || Object.values(clean).some(v => !v))
        process.exitCode = 1;
}
