#!/usr/bin/env python3
"""Replay the request sequence from a HAR over HTTP/3 with qlog capture.

Groups requests by host (one QUIC connection per authority), connects each
host's connection at the offset of its first request, and issues every
request at its original HAR start offset so the qlogs reproduce the same
serial/parallel stream mix as the original page load.

Usage: replay_har_qlog.py <har[.gz]> <qlog-output-dir>
"""
import asyncio
import gzip
import json
import sys
import time
from collections import defaultdict
from datetime import datetime
from urllib.parse import urlparse

from aioquic.asyncio.client import connect
from aioquic.h3.connection import H3_ALPN
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.logger import QuicFileLogger

from http3_client import HttpClient, HttpRequest, URL

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/144.0.0.0 Safari/537.36 waterfall-tools-qlog-replay"
)


def load_requests(har_path):
    opener = gzip.open if har_path.endswith(".gz") else open
    with opener(har_path, "rt") as f:
        har = json.load(f)
    entries = har["log"]["entries"]

    def epoch_ms(e):
        return datetime.fromisoformat(
            e["startedDateTime"].replace("Z", "+00:00")
        ).timestamp() * 1000.0

    t0 = min(epoch_ms(e) for e in entries)
    reqs = []
    for e in entries:
        reqs.append({
            "offset_ms": epoch_ms(e) - t0,
            "method": e["request"]["method"],
            "url": e["request"]["url"],
        })
    reqs.sort(key=lambda r: r["offset_ms"])
    return reqs


async def sleep_until(loop_t0, offset_ms):
    delay = loop_t0 + offset_ms / 1000.0 - time.monotonic()
    if delay > 0:
        await asyncio.sleep(delay)


async def do_request(client, loop_t0, req, results):
    await sleep_until(loop_t0, req["offset_ms"])
    started = time.monotonic() - loop_t0
    try:
        events = await asyncio.wait_for(
            client._request(
                HttpRequest(
                    method=req["method"],
                    url=URL(req["url"]),
                    headers={"user-agent": USER_AGENT},
                )
            ),
            timeout=15,
        )
        status = None
        size = 0
        for ev in events:
            if hasattr(ev, "headers"):
                for name, value in ev.headers:
                    if name == b":status":
                        status = value.decode()
            elif hasattr(ev, "data"):
                size += len(ev.data)
        results.append((started * 1000, req["method"], req["url"], status, size))
        print(f"{started*1000:8.0f}ms  {req['method']:7s} {status}  {size:>8}B  {req['url'][:90]}", file=sys.stderr)
    except Exception as ex:
        results.append((started * 1000, req["method"], req["url"], f"ERROR {ex!r}", 0))
        print(f"{started*1000:8.0f}ms  {req['method']:7s} FAILED {ex!r}  {req['url'][:80]}", file=sys.stderr)


async def run_host(host, reqs, loop_t0, qlog_dir, results):
    # Connect at the first request's offset — the handshake delay then shifts
    # this host's first response slightly later, just like a real page load.
    await sleep_until(loop_t0, reqs[0]["offset_ms"])
    config = QuicConfiguration(
        is_client=True,
        alpn_protocols=H3_ALPN,
        quic_logger=QuicFileLogger(qlog_dir),
    )
    print(f"{(time.monotonic()-loop_t0)*1000:8.0f}ms  CONNECT {host} ({len(reqs)} requests)", file=sys.stderr)
    try:
        async with connect(host, 443, configuration=config, create_protocol=HttpClient) as client:
            await asyncio.gather(*[
                do_request(client, loop_t0, r, results) for r in reqs
            ])
            client._quic.close(error_code=0x100)
    except Exception as ex:
        print(f"CONNECTION FAILED {host}: {ex!r}", file=sys.stderr)


async def main():
    har_path, qlog_dir = sys.argv[1], sys.argv[2]
    reqs = load_requests(har_path)
    by_host = defaultdict(list)
    for r in reqs:
        by_host[urlparse(r["url"]).netloc].append(r)
    print(f"{len(reqs)} requests across {len(by_host)} hosts", file=sys.stderr)

    results = []
    loop_t0 = time.monotonic()
    await asyncio.gather(*[
        run_host(host, host_reqs, loop_t0, qlog_dir, results)
        for host, host_reqs in by_host.items()
    ])

    results.sort()
    ok = sum(1 for r in results if r[3] and not str(r[3]).startswith("ERROR"))
    print(f"\ndone: {ok}/{len(results)} requests succeeded", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
