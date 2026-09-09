import { readFile } from 'node:fs/promises';
for (const filename of process.argv.slice(2)) {
    const result = JSON.parse(await readFile(filename, 'utf8'));
    if (!result.snapshots) {
        console.log(JSON.stringify({ filename, error: result.error }));
        continue;
    }
    const phases = [];
    for (let i = 1; i < result.snapshots.length; i++) {
        const prev = result.snapshots[i - 1], next = result.snapshots[i], seconds = (next.at - prev.at) / 1000;
        const row = { phase: next.phase, seconds, browserCpuSeconds: next.process && prev.process ? next.process.cpuSeconds - prev.process.cpuSeconds : null, edges: {}, viewers: {} };
        for (const role of Object.keys(next.stats)) {
            const before = prev.stats[role], after = next.stats[role];
            const outbound = s => s?.send.find(r => r.type === 'outbound-rtp' && r.kind === 'video') || {};
            const inbound = s => s?.receive.find(r => r.type === 'inbound-rtp' && r.kind === 'video') || {};
            const a = outbound(before), b = outbound(after), c = inbound(before), d = inbound(after);
            row.edges[role] = { encoded: (b.framesEncoded || 0) - (a.framesEncoded || 0), encodeMs: 1000 * ((b.totalEncodeTime || 0) - (a.totalEncodeTime || 0)),
                decoded: (d.framesDecoded || 0) - (c.framesDecoded || 0), decodeMs: 1000 * ((d.totalDecodeTime || 0) - (c.totalDecodeTime || 0)),
                sentFrames: (b.framesSent || 0) - (a.framesSent || 0), kbps: 8 * ((b.bytesSent || 0) - (a.bytesSent || 0)) / seconds / 1000,
                output: [b.frameWidth, b.frameHeight], receive: [d.frameWidth, d.frameHeight], reason: b.qualityLimitationReason, target: b.targetBitrate,
                senderReports: after.receive.filter(r => r.type === 'remote-outbound-rtp').reduce((s, r) => s + (r.reportsSent || 0), 0) - (before?.receive || []).filter(r => r.type === 'remote-outbound-rtp').reduce((s, r) => s + (r.reportsSent || 0), 0), pli: (d.pliCount || 0) - (c.pliCount || 0) };
        }
        for (const monitor of result.monitors) {
            const samples = monitor.samples.filter(s => s.phase === next.phase), ages = samples.filter(s => s.age !== null).map(s => s.age).sort((a, b) => a - b);
            let backwards = 0, duplicates = 0, maxGapMs = samples[0] ? samples[0].at - prev.at : seconds * 1000;
            for (let j = 1; j < samples.length; j++) {
                maxGapMs = Math.max(maxGapMs, samples[j].at - samples[j - 1].at);
                if (samples[j].id < samples[j - 1].id)
                    backwards++;
                if (samples[j].id === samples[j - 1].id)
                    duplicates++;
            }
            row.viewers[monitor.role] = { rendered: samples.length, fresh: samples.filter(s => s.age !== null && s.age < 1000).length, backwards, duplicates, maxGapMs,
                ageP50: ages[Math.floor(ages.length * .5)] ?? null, ageP95: ages[Math.floor(ages.length * .95)] ?? null };
        }
        phases.push(row);
    }
    console.log(JSON.stringify({ file: filename, probeSha256: result.probeSha256 ?? null,
        mode: result.mode, codec: result.codec, high: result.high ?? false, network: result.network ?? false,
        counts: result.counts, errors: result.errors, phases, groupChanges: result.groupChanges ?? [],
        shaper: result.shaper ?? null, cleanup: result.cleanup }));
}
