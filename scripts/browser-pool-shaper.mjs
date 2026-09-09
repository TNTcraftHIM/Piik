import { createSocket } from 'node:dgram';
// Test-only UDP bridge. Both ICE descriptions point at it, so the recorded
// packet counters prove the tested media path crossed the shaping boundary.
export async function createPoolShaper() {
    const left = createSocket('udp4'), right = createSocket('udp4');
    await Promise.all([left, right].map(s => new Promise(r => s.bind(0, '127.0.0.1', r))));
    let targetLeft = 0, targetRight = 0, rate = 0, next = 0, closed = false, timer = null;
    const queue = [];
    const counters = { forwardedBytes: 0, droppedBytes: 0, packets: 0, reverseBytes: 0, maxQueueBytes: 0 };
    let queuedBytes = 0;
    function flush() {
        timer = null;
        if (closed)
            return;
        const now = performance.now();
        while (queue.length && queue[0].at <= now) {
            const packet = queue.shift();
            queuedBytes -= packet.data.length;
            right.send(packet.data, targetRight, '127.0.0.1');
            counters.forwardedBytes += packet.data.length;
            counters.packets++;
        }
        if (queue.length)
            timer = setTimeout(flush, Math.max(1, queue[0].at - performance.now()));
    }
    left.on('message', data => {
        if (!targetRight || closed)
            return;
        if (!rate) {
            right.send(data, targetRight, '127.0.0.1');
            counters.forwardedBytes += data.length;
            counters.packets++;
            return;
        }
        const now = performance.now();
        if (next - now > 250) {
            counters.droppedBytes += data.length;
            return;
        }
        next = Math.max(now, next) + data.length * 8 * 1000 / rate;
        queue.push({ at: next, data });
        queuedBytes += data.length;
        counters.maxQueueBytes = Math.max(counters.maxQueueBytes, queuedBytes);
        if (!timer)
            flush();
    });
    right.on('message', data => { if (targetLeft && !closed) {
        left.send(data, targetLeft, '127.0.0.1');
        counters.reverseBytes += data.length;
    } });
    return {
        ports: { left: left.address().port, right: right.address().port },
        setTargets(a, b) { targetLeft = a; targetRight = b; },
        setRate(value) { rate = value; if (!rate) {
            next = 0;
            for (const item of queue)
                item.at = 0;
            if (timer)
                clearTimeout(timer);
            flush();
        } },
        stats() { return { ...counters, queuedBytes, rate }; },
        async close() { closed = true; if (timer)
            clearTimeout(timer); queue.length = 0; await Promise.all([left, right].map(s => new Promise(r => s.close(r)))); }
    };
}
