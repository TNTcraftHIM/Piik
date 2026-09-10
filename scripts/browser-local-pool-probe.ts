import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CdpConnection, cleanupRun, createPage, evaluate, launchChrome, reservePort, waitForSample, waitForVersion } from './browser-gate-harness';
import { createPoolShaper } from './browser-pool-shaper.mjs';

const mode = process.argv[2] || 'carrier', args = process.argv.slice(3);
const flags = new Set(['--product', '--1080', '--h264', '--single', '--av', '--late', '--background',
    '--native-source', '--lifecycle', '--network', '--auto', '--relay', '--debug']);
if (!['ordinary', 'carrier'].includes(mode)) throw Error('Expected ordinary|carrier');
for (const arg of args) if (!flags.has(arg) && !arg.startsWith('--rate=') && !arg.startsWith('--preference='))
    throw Error('Unsupported option: ' + arg);
const codec = args.includes('--h264') ? 'H264' : 'VP8', network = args.includes('--network');
const automatic = args.includes('--auto'), high = args.includes('--1080'), av = args.includes('--av');
const single = args.includes('--single'), late = args.includes('--late'), background = args.includes('--background');
const nativeSource = background || args.includes('--native-source'), lifecycle = args.includes('--lifecycle');
const relay = args.includes('--relay');
const rate = Number(args.find(arg => arg.startsWith('--rate='))?.split('=')[1] || 120000);
const preference = args.find(arg => arg.startsWith('--preference='))?.split('=')[1] || (high ? 'maintain-resolution' : 'balanced');
if (!['balanced', 'maintain-resolution', 'maintain-framerate'].includes(preference)) throw Error('Unsupported degradation preference');
if (!Number.isInteger(rate) || rate <= 0) throw Error('Rate must be a positive integer in bps');
if (lifecycle && (nativeSource || network || relay)) throw Error('Lifecycle uses direct canvas capture without network shaping');
if (single && late) throw Error('Single-viewer control cannot also late-join B');
const root = resolve(import.meta.dirname, '..');
const bundle = await build({ entryPoints: [join(root, 'scripts/browser-local-pool-page.js')],
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'error' });
const body = Buffer.from(bundle.outputFiles[0].contents);
let cdp: CdpConnection | null = null;
let page: Awaited<ReturnType<typeof createPage>> | undefined;
let originalTarget: string | undefined, backgroundTarget: string | undefined;
const shaper = network ? await createPoolShaper() : null;
const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname === '/visibility' && cdp && page) {
        void (async () => {
            originalTarget ??= (await cdp!.call<{ targetInfo: { targetId: string } }>(
                'Target.getTargetInfo', {}, page!.sessionId, Date.now() + 3000)).targetInfo.targetId;
            backgroundTarget ??= (await cdp!.call<{ targetId: string }>(
                'Target.createTarget', { url: 'about:blank', background: true }, undefined, Date.now() + 3000)).targetId;
            await cdp!.call('Target.activateTarget', { targetId: url.searchParams.get('hidden') === '1' ? backgroundTarget : originalTarget },
                undefined, Date.now() + 3000);
            response.end('{}');
        })().catch(() => { response.statusCode = 500; response.end('{}'); });
        return;
    }
    if (url.pathname === '/process' && cdp) {
        void cdp.call<{ processInfo: Array<{ cpuTime: number }> }>('SystemInfo.getProcessInfo', {}, undefined, Date.now() + 3000)
            .then(info => response.end(JSON.stringify({ cpuSeconds: info.processInfo.reduce((sum, p) => sum + p.cpuTime, 0) })),
                () => response.end('{}'));
        return;
    }
    if (url.pathname === '/shaper' && shaper) {
        if (url.searchParams.has('left')) shaper.setTargets(Number(url.searchParams.get('left')), Number(url.searchParams.get('right')));
        if (url.searchParams.has('rate')) shaper.setRate(Number(url.searchParams.get('rate')));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ports: shaper.ports, stats: shaper.stats() }));
        return;
    }
    response.setHeader('Content-Type', url.pathname === '/probe.js' ? 'text/javascript' : 'text/html');
    response.end(url.pathname === '/probe.js' ? body :
        '<!doctype html><meta charset=utf-8><title>Browser local pool</title><script type=module src=/probe.js></script>');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port, debugPort = await reservePort();
const profile = await mkdtemp(join(tmpdir(), 'piik-client-media-'));
const chrome = launchChrome(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', debugPort, profile,
    ['--headless=new', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
        ...(background ? [] : ['--disable-background-timer-throttling', '--disable-renderer-backgrounding']),
        ...(nativeSource ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [])]);
chrome.stdout.resume(); chrome.stderr.resume();
let result: Record<string, unknown> = { mode, codec, product: true, network, automatic, high, av, single, late,
    background, nativeSource, lifecycle, relay, shapedRate: rate, preference };
try {
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 5000);
    page = await createPage(cdp, 'about:blank');
    const query = new URLSearchParams({ mode, codec, rate: String(rate), preference });
    if (process.argv.includes('--debug')) query.set('debug', '1');
    for (const [key, value] of Object.entries({ network, automatic, high, av, single, late, background, nativeSource, lifecycle, relay }))
        query.set(key, value ? '1' : '0');
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + port + '/?' + query }, page.sessionId, Date.now() + 5000);
    await waitForSample(() => evaluate<boolean>(cdp!, page!, 'window.probeDone===true', Date.now() + 2000),
        Boolean, automatic || lifecycle ? 110000 : network || background ? 60000 : 25000);
    result = await evaluate<Record<string, unknown>>(cdp, page, 'window.probeResult', Date.now() + 3000);
} catch (error) {
    result.error = String(error);
    if (cdp && page) result.partial = await evaluate(cdp, page, 'window.probeResult || window.probeProgress?.()', Date.now() + 3000).catch(() => null);
} finally {
    const clean = await cleanupRun({ cdp, native: null, chrome,
        server: { close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) },
        profile, ports: [port, debugPort] });
    if (shaper) { result.shaper = shaper.stats(); await shaper.close(); }
    result.probeSha256 = createHash('sha256').update(body).digest('hex');
    result.cleanup = clean;
    await mkdir(join(root, 'build/browser-local-pool'), { recursive: true });
    const name = [mode, codec.toLowerCase(), network && 'network', automatic && 'auto', high && '1080',
        single && 'single', late && 'late', background && 'background', lifecycle && 'lifecycle', relay && 'relay', Date.now()].filter(Boolean).join('-');
    const output = join(root, 'build/browser-local-pool', name + '.json');
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ mode, codec, network, error: result.error ?? null, output, cleanup: clean }));
    if (result.error || (result.errors as string[] | undefined)?.length || Object.values(clean).some(v => !v)) process.exitCode = 1;
}
