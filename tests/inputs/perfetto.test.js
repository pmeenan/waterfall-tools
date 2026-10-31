/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { PerfettoDecoder } from '../../src/inputs/utilities/perfetto/decoder.js';
import { processPerfettoFileNode } from '../../src/inputs/perfetto.js';
import { relationalToHar } from '../../src/core/har-export.js';

// ---- Minimal Protobuf wire-format builders for synthetic Perfetto packets ----

function encodeVarint(val) {
    let v = BigInt.asUintN(64, BigInt(val));
    const out = [];
    while (v >= 0x80n) {
        out.push(Number((v & 0x7Fn) | 0x80n));
        v >>= 7n;
    }
    out.push(Number(v));
    return new Uint8Array(out);
}

function encodeTag(field, wire) {
    return encodeVarint((BigInt(field) << 3n) | BigInt(wire));
}

function concatBytes(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

function fieldVarint(field, val) {
    return concatBytes(encodeTag(field, 0), encodeVarint(val));
}

function fieldBytes(field, payload) {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    return concatBytes(encodeTag(field, 2), encodeVarint(bytes.length), bytes);
}

function fieldDouble(field, val) {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, val, true);
    return concatBytes(encodeTag(field, 1), buf);
}

function wrapTracePacket(...fields) {
    return fieldBytes(1, concatBytes(...fields));
}

async function decodePackets(chunks, options = {}) {
    const decoder = new PerfettoDecoder({ debug: true, ...options });
    const stream = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        }
    });
    const jsonText = await new Response(
        stream.pipeThrough(decoder.stream).pipeThrough(new TextEncoderStream())
    ).text();
    return {
        events: JSON.parse(jsonText).traceEvents,
        decoder
    };
}

function debugAnnotationStr(name, strVal) {
    return fieldBytes(4, concatBytes(fieldBytes(10, name), fieldBytes(6, strVal)));
}

function debugAnnotationInt(name, intVal) {
    return fieldBytes(4, concatBytes(fieldBytes(10, name), fieldVarint(4, intVal)));
}

function debugAnnotationDict(name, entries) {
    return fieldBytes(
        4,
        concatBytes(
            fieldBytes(10, name),
            ...entries.map(([k, v]) => {
                if (typeof v === 'string') {
                    return fieldBytes(11, concatBytes(fieldBytes(10, k), fieldBytes(6, v)));
                }
                if (typeof v === 'boolean') {
                    return fieldBytes(11, concatBytes(fieldBytes(10, k), fieldVarint(2, v ? 1 : 0)));
                }
                return fieldBytes(11, concatBytes(fieldBytes(10, k), fieldDouble(5, v)));
            })
        )
    );
}

describe('PerfettoDecoder', () => {
    it('resolves TracePacketDefaults clock 64, incremental accumulation, ClockSnapshot offsets, and B/E slice durations in µs', async () => {
        // Packet 1: sequence 3 initialization with SEQ_INCREMENTAL_STATE_CLEARED (1),
        // TracePacketDefaults (timestamp_clock_id = 64, default track_uuid = 42),
        // TrackDescriptor for track 42 (pid = 100, tid = 200), and ClockSnapshot
        // mapping clock 64 (base 500_000 ns, incremental, mult 1 ns) to BOOTTIME (6)
        // at 10_000_000_000 ns (10,000,000 µs).
        const defaultsMsg = concatBytes(
            fieldVarint(58, 64),                        // timestamp_clock_id = 64
            fieldBytes(11, fieldVarint(11, 42))         // track_event_defaults.track_uuid = 42
        );
        const trackDescMsg = concatBytes(
            fieldVarint(1, 42),                         // uuid = 42
            fieldBytes(4, concatBytes(                  // thread descriptor
                fieldVarint(1, 100),                    // pid = 100
                fieldVarint(2, 200)                     // tid = 200
            ))
        );
        const clockSnapshotMsg = concatBytes(
            fieldVarint(2, 6),                          // primary_trace_clock = BUILTIN_CLOCK_BOOTTIME (6)
            fieldBytes(1, concatBytes(                  // clock 6 @ 10_000_000_000 ns
                fieldVarint(1, 6),
                fieldVarint(2, 10_000_000_000n)
            )),
            fieldBytes(1, concatBytes(                  // clock 64 @ 500_000 ns, is_incremental = true, unit_multiplier_ns = 1
                fieldVarint(1, 64),
                fieldVarint(2, 500_000n),
                fieldVarint(3, 1),
                fieldVarint(4, 1)
            ))
        );
        const pkt1 = wrapTracePacket(
            fieldVarint(10, 3),                         // trusted_packet_sequence_id = 3 (placed before flags to test order independence)
            fieldVarint(13, 1),                         // sequence_flags = SEQ_INCREMENTAL_STATE_CLEARED
            fieldBytes(59, defaultsMsg),
            fieldBytes(60, trackDescMsg),
            fieldBytes(6, clockSnapshotMsg)
        );

        // Packet 2: TYPE_SLICE_BEGIN (type=1) on seq 3, delta +150_000 ns (+150 µs) -> 10_000_150 µs
        const pkt2 = wrapTracePacket(
            fieldVarint(8, 150_000),                    // timestamp delta on clock 64
            fieldBytes(11, concatBytes(
                fieldVarint(9, 1),                      // TYPE_SLICE_BEGIN
                fieldBytes(22, 'devtools.timeline'),
                fieldBytes(23, 'EvaluateScript')
            )),
            fieldVarint(10, 3)                          // trusted_packet_sequence_id AFTER track_event
        );

        // Packet 3: TYPE_SLICE_END (type=2) on seq 3, delta +2_350_000 ns (+2,350 µs) -> 10_002_500 µs
        // Omits name and categories (Perfetto standard for TYPE_SLICE_END).
        const pkt3 = wrapTracePacket(
            fieldVarint(8, 2_350_000),
            fieldVarint(10, 3),
            fieldBytes(11, fieldVarint(9, 2))           // TYPE_SLICE_END
        );

        // Mode A: default B/E emission
        const { events: beEvents } = await decodePackets([concatBytes(pkt1, pkt2, pkt3)]);
        expect(beEvents).toHaveLength(2);
        expect(beEvents[0]).toMatchObject({
            name: 'EvaluateScript',
            cat: 'devtools.timeline',
            ph: 'B',
            ts: 10_000_150,
            pid: 100,
            tid: 200
        });
        expect(beEvents[1]).toMatchObject({
            name: 'EvaluateScript',
            cat: 'devtools.timeline',
            ph: 'E',
            ts: 10_002_500,
            pid: 100,
            tid: 200
        });

        // Mode B: emitCompleteEvents ('X' phase with calculated dur in µs)
        const { events: xEvents } = await decodePackets([concatBytes(pkt1, pkt2, pkt3)], {
            emitCompleteEvents: true
        });
        expect(xEvents).toHaveLength(1);
        expect(xEvents[0]).toMatchObject({
            name: 'EvaluateScript',
            cat: 'devtools.timeline',
            ph: 'X',
            ts: 10_000_150,
            dur: 2350,
            pid: 100,
            tid: 200
        });
    });

    it('supports legacy timestamp_delta_us and timestamp_absolute_us TrackEvents', async () => {
        // Packet 1: ThreadDescriptor (field 44) seeding reference_timestamp_us = 50_000 µs on seq 7
        const pkt1 = wrapTracePacket(
            fieldVarint(10, 7),
            fieldBytes(44, concatBytes(
                fieldVarint(1, 10),
                fieldVarint(2, 20),
                fieldVarint(6, 50_000)                  // reference_timestamp_us
            ))
        );

        // Packet 2: TrackEvent with legacy timestamp_delta_us (field 1) = +125 µs -> 50_125 µs
        const pkt2 = wrapTracePacket(
            fieldVarint(10, 7),
            fieldBytes(11, concatBytes(
                fieldVarint(1, 125),                    // timestamp_delta_us
                fieldVarint(9, 3),                      // TYPE_INSTANT
                fieldBytes(22, 'blink'),
                fieldBytes(23, 'LegacyDeltaA')
            ))
        );

        // Packet 3: TrackEvent with legacy timestamp_delta_us (field 1) = +75 µs -> 50_200 µs
        const pkt3 = wrapTracePacket(
            fieldVarint(10, 7),
            fieldBytes(11, concatBytes(
                fieldVarint(1, 75),                     // timestamp_delta_us
                fieldVarint(9, 3),
                fieldBytes(22, 'blink'),
                fieldBytes(23, 'LegacyDeltaB')
            ))
        );

        // Packet 4: TrackEvent with legacy timestamp_absolute_us (field 16) = 99_999 µs
        const pkt4 = wrapTracePacket(
            fieldVarint(10, 7),
            fieldBytes(11, concatBytes(
                fieldVarint(16, 99_999),                // timestamp_absolute_us
                fieldVarint(9, 3),
                fieldBytes(22, 'blink'),
                fieldBytes(23, 'LegacyAbsolute')
            ))
        );

        // Packet 5: TrackEvent with legacy timestamp_delta_us (field 1) = +1 µs after absolute -> 100_000 µs
        const pkt5 = wrapTracePacket(
            fieldVarint(10, 7),
            fieldBytes(11, concatBytes(
                fieldVarint(1, 1),
                fieldVarint(9, 3),
                fieldBytes(22, 'blink'),
                fieldBytes(23, 'LegacyDeltaAfterAbs')
            ))
        );

        const { events } = await decodePackets([concatBytes(pkt1, pkt2, pkt3, pkt4, pkt5)]);
        expect(events.map(e => ({ name: e.name, ts: e.ts }))).toEqual([
            { name: 'LegacyDeltaA', ts: 50_125 },
            { name: 'LegacyDeltaB', ts: 50_200 },
            { name: 'LegacyAbsolute', ts: 99_999 },
            { name: 'LegacyDeltaAfterAbs', ts: 100_000 }
        ]);
    });

    it('fails soft on truncated or corrupt inner varints, lengths, and fixed64 fields without throwing', async () => {
        const validBefore = wrapTracePacket(
            fieldVarint(8, 1_000_000),
            fieldVarint(10, 1),
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'cat'),
                fieldBytes(23, 'ValidBefore')
            ))
        );

        // Corrupt Packet A: inner length-delimited field claims 500 bytes inside a 10-byte packet
        const corruptLenPacket = wrapTracePacket(
            fieldVarint(8, 2_000_000),
            fieldVarint(10, 1),
            concatBytes(encodeTag(11, 2), encodeVarint(500), new Uint8Array([1, 2, 3]))
        );

        // Corrupt Packet B: unterminated varint (all continuation bits set to 0x80) at end of packet
        const corruptVarintPacket = wrapTracePacket(
            encodeTag(8, 0),
            new Uint8Array([0x80, 0x80, 0x80])
        );

        // Corrupt Packet C: DebugAnnotation double_value (field 5, wire 1 = 8-byte fixed64) with only 3 bytes remaining
        const truncatedDoubleAnnotation = concatBytes(
            fieldBytes(10, 'badDouble'),
            encodeTag(5, 1),
            new Uint8Array([0x01, 0x02, 0x03]) // only 3 of required 8 bytes
        );
        const corruptDoublePacket = wrapTracePacket(
            fieldVarint(8, 3_000_000),
            fieldVarint(10, 1),
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(23, 'ShouldSkip'),
                fieldBytes(4, truncatedDoubleAnnotation)
            ))
        );

        const validAfter = wrapTracePacket(
            fieldVarint(8, 4_000_000),
            fieldVarint(10, 1),
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'cat'),
                fieldBytes(23, 'ValidAfter')
            ))
        );

        const { events, decoder } = await decodePackets([
            concatBytes(validBefore, corruptLenPacket, corruptVarintPacket, corruptDoublePacket, validAfter)
        ]);

        expect(decoder.malformedPackets).toBe(3);
        expect(events.map(e => ({ name: e.name, ts: e.ts }))).toEqual([
            { name: 'ValidBefore', ts: 1000 },
            { name: 'ValidAfter', ts: 4000 }
        ]);
    });

    it('reassembles a TracePacket spanning many small stream chunks without data loss', async () => {
        const longPayload = 'x'.repeat(2048);
        const pkt1 = wrapTracePacket(
            fieldVarint(8, 12_345_000),
            fieldVarint(10, 2),
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'chunk.test'),
                fieldBytes(23, 'SpanningEvent'),
                debugAnnotationStr('payload', longPayload),
                debugAnnotationInt('count', 42)
            ))
        );
        const pkt2 = wrapTracePacket(
            fieldVarint(8, 67_890_000),
            fieldVarint(10, 2),
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'chunk.test'),
                fieldBytes(23, 'SecondEvent')
            ))
        );

        const combined = concatBytes(pkt1, pkt2);
        // Slice into tiny 7-byte chunks so headers and payloads split across dozens of chunks
        const tinyChunks = [];
        for (let i = 0; i < combined.length; i += 7) {
            tinyChunks.push(combined.subarray(i, i + 7));
        }

        const { events } = await decodePackets(tinyChunks);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            name: 'SpanningEvent',
            cat: 'chunk.test',
            ts: 12_345,
            args: { payload: longPayload, count: 42 }
        });
        expect(events[1]).toMatchObject({
            name: 'SecondEvent',
            cat: 'chunk.test',
            ts: 67_890
        });
    });

    it('pipes decoded Perfetto trace through processPerfettoFileNode to produce Extended HAR', async () => {
        // Build a minimal synthetic Perfetto trace with clock 64, CrRendererMain thread,
        // navigationStart, ResourceSendRequest/ReceiveResponse/ReceivedData/Finish, and a main-thread slice.
        const seqId = 5;
        const trackUuid = 101;
        const baseNs = 1_000_000_000n; // 1,000,000 µs

        const initPacket = wrapTracePacket(
            fieldVarint(10, seqId),
            fieldVarint(13, 1),
            fieldBytes(59, concatBytes(
                fieldVarint(58, 64),
                fieldBytes(11, fieldVarint(11, trackUuid))
            )),
            fieldBytes(60, concatBytes(
                fieldVarint(1, trackUuid),
                fieldBytes(2, 'CrRendererMain'),
                fieldBytes(4, concatBytes(fieldVarint(1, 1000), fieldVarint(2, 2000)))
            )),
            fieldBytes(6, concatBytes(
                fieldVarint(2, 6),
                fieldBytes(1, concatBytes(fieldVarint(1, 6), fieldVarint(2, baseNs))),
                fieldBytes(1, concatBytes(fieldVarint(1, 64), fieldVarint(2, baseNs), fieldVarint(3, 1), fieldVarint(4, 1)))
            ))
        );

        const navStartPacket = wrapTracePacket(
            fieldVarint(10, seqId),
            fieldVarint(8, 0),
            fieldBytes(11, concatBytes(
                fieldBytes(22, 'blink.user_timing'),
                fieldBytes(23, 'navigationStart'),
                fieldBytes(6, fieldVarint(2, 'R'.charCodeAt(0))),
                debugAnnotationDict('data', [
                    ['documentLoaderURL', 'https://example.com/'],
                    ['isLoadingMainFrame', true]
                ]),
                debugAnnotationStr('frame', 'FRAME_1')
            ))
        );

        const sendReqPacket = wrapTracePacket(
            fieldVarint(10, seqId),
            fieldVarint(8, 10_000_000), // +10 ms
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'devtools.timeline'),
                fieldBytes(23, 'ResourceSendRequest'),
                debugAnnotationDict('data', [
                    ['requestId', 'REQ_1'],
                    ['url', 'https://example.com/'],
                    ['requestMethod', 'GET'],
                    ['priority', 'VeryHigh'],
                    ['frame', 'FRAME_1']
                ])
            ))
        );

        const recvRespPacket = wrapTracePacket(
            fieldVarint(10, seqId),
            fieldVarint(8, 40_000_000), // +40 ms (t = 50 ms)
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'devtools.timeline'),
                fieldBytes(23, 'ResourceReceiveResponse'),
                debugAnnotationDict('data', [
                    ['requestId', 'REQ_1'],
                    ['statusCode', 200],
                    ['mimeType', 'text/html'],
                    ['protocol', 'h2'],
                    ['fromCache', false],
                    ['fromServiceWorker', false]
                ])
            ))
        );

        const recvDataPacket = wrapTracePacket(
            fieldVarint(10, seqId),
            fieldVarint(8, 10_000_000), // +10 ms (t = 60 ms)
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'devtools.timeline'),
                fieldBytes(23, 'ResourceReceivedData'),
                debugAnnotationDict('data', [
                    ['requestId', 'REQ_1'],
                    ['encodedDataLength', 4096]
                ])
            ))
        );

        const finishPacket = wrapTracePacket(
            fieldVarint(10, seqId),
            fieldVarint(8, 15_000_000), // +15 ms (t = 75 ms)
            fieldBytes(11, concatBytes(
                fieldVarint(9, 3),
                fieldBytes(22, 'devtools.timeline'),
                fieldBytes(23, 'ResourceFinish'),
                debugAnnotationDict('data', [
                    ['requestId', 'REQ_1'],
                    ['encodedDataLength', 4096],
                    ['decodedBodyLength', 8192],
                    ['didFail', false]
                ])
            ))
        );

        const bytes = concatBytes(
            initPacket,
            navStartPacket,
            sendReqPacket,
            recvRespPacket,
            recvDataPacket,
            finishPacket
        );

        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            }
        });

        const data = await processPerfettoFileNode(stream, { debug: true });
        const har = relationalToHar(data);
        expect(har.log.entries).toHaveLength(1);
        expect(har.log.entries[0].request.url).toBe('https://example.com/');
        expect(har.log.entries[0].response.status).toBe(200);
        expect(har.log.entries[0].time).toBeGreaterThanOrEqual(60);
    });
});
