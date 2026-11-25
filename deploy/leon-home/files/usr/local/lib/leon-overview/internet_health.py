"""Internet health history from the overview's 30 s checks: availability, latency and outages.

Each sample is [time, routerOk, routerMs, internetMs, dnsMs, routerLossPercent]. Internet is up when the TCP probe to
1.1.1.1 or 9.9.9.9 answered. When it did not, the router ping decides the likely cause: router
reachable means the provider or modem ("provider"), router unreachable means the home network
("home"). A sampling gap (overview restart) is unknown time, never an outage.
"""

import json
import math
import os

KEEP_SECONDS = 86400
MAX_SAMPLES = 3000  # 24 h at 30 s, plus slack
GAP_SECONDS = 120  # longer silences are gaps, not outages
MIN_OUTAGE_SAMPLES = 2  # a single failed probe is a blip
BUCKET_SECONDS = 900
SERIES_POINTS = 96  # 15-minute buckets over 24 h


def number(value):
    return (
        round(value, 1)
        if isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
        else None
    )


def sample_row(internet, at):
    """One stored row from collector.health() output; None when there was no check."""
    if not isinstance(internet, dict) or not isinstance(at, (int, float)):
        return None
    router = internet.get('router') if isinstance(internet.get('router'), dict) else {}
    loss = router.get('lossPercent')
    return [
        int(at),
        isinstance(loss, (int, float)) and loss < 100,
        number(router.get('averageMs')),
        number(internet.get('internetMs')),
        number(internet.get('dnsMs')),
        number(loss) if isinstance(loss, (int, float)) and 0 <= loss <= 100 else None,
    ]


def state(row):
    return 'up' if row[3] is not None else 'provider' if row[1] else 'home'


def outages(rows):
    """Closed and open outages, oldest first: {start, end (None if ongoing), seconds, cause}."""
    found, run = [], []

    def close(end):
        if len(run) >= MIN_OUTAGE_SAMPLES:
            causes = [state(row) for row in run]
            found.append(
                {
                    'start': run[0][0],
                    'end': end,
                    'seconds': (end or run[-1][0]) - run[0][0],
                    'cause': max(set(causes), key=causes.count),
                }
            )
        run.clear()

    previous = None
    for row in rows:
        if previous is not None and row[0] - previous[0] > GAP_SECONDS:
            close(None if not run else run[-1][0])  # a gap ends what we know
        if state(row) == 'up':
            close(row[0] if run else None)
        else:
            run.append(row)
        previous = row
    if run:
        close(None)
    return found


def summary(rows, now):
    """Bounded view for the page: availability over the window, current state, series, last outages."""
    rows = [row for row in rows if now - row[0] <= KEEP_SECONDS]
    if not rows:
        return {'samples': 0, 'availability': None, 'current': None, 'series': [], 'outages': []}
    up = sum(1 for row in rows if state(row) == 'up')
    buckets = {}
    for row in rows:
        buckets.setdefault(row[0] // BUCKET_SECONDS * BUCKET_SECONDS, []).append(row)
    series = []
    for start in sorted(buckets)[-SERIES_POINTS:]:
        bucket = buckets[start]
        latencies = [row[3] for row in bucket if row[3] is not None]
        series.append(
            [
                start,
                round(sum(latencies) / len(latencies), 1) if latencies else None,
                round(100 * sum(1 for row in bucket if state(row) == 'up') / len(bucket)),
            ]
        )
    latest_bucket = int(now // BUCKET_SECONDS) * BUCKET_SECONDS
    first_bucket = latest_bucket - (SERIES_POINTS - 1) * BUCKET_SECONDS

    def aligned_average(column):
        averages = []
        for start in range(first_bucket, latest_bucket + 1, BUCKET_SECONDS):
            readings = [
                row[column]
                for row in buckets.get(start, ())
                if len(row) > column and row[column] is not None
            ]
            averages.append(round(sum(readings) / len(readings), 1) if readings else None)
        return averages

    last = rows[-1]
    return {
        'samples': len(rows),
        'availability': round(100 * up / len(rows), 2),
        'current': {
            'at': last[0],
            'state': state(last),
            'routerMs': last[2],
            'internetMs': last[3],
            'dnsMs': last[4],
            'routerLossPercent': last[5] if len(last) == 6 else None,
        }
        if now - last[0] <= GAP_SECONDS
        else None,
        'series': series,
        'routerLossSeries': aligned_average(5),
        'internetLatencySeries': aligned_average(3),
        'dnsLatencySeries': aligned_average(4),
        'outages': outages(rows)[-10:],
    }


def load(path, now):
    try:
        with open(path, encoding='utf-8') as handle:
            rows = json.loads(handle.read(2_000_000))
    except (OSError, ValueError):
        return []
    return [
        row
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, list)
        and len(row) in (5, 6)
        and isinstance(row[0], int)
        and 0 < now - row[0] <= KEEP_SECONDS
        and isinstance(row[1], bool)
    ][-MAX_SAMPLES:]


MAX_SPEED_TESTS = 30


def load_speed_tests(path, now):
    """Recent daily results, oldest first: {at, downMbps, upMbps}; null means that part failed."""
    try:
        with open(path, encoding='utf-8') as handle:
            rows = json.loads(handle.read(100_000))
    except (OSError, ValueError):
        return []

    def valid(row):
        return (
            isinstance(row, dict)
            and type(row.get('at')) is int
            and 0 < row['at'] <= now + 30
            and all(
                row.get(key) is None or number(row[key]) is not None
                for key in ('downMbps', 'upMbps')
            )
        )

    return [
        {'at': row['at'], 'downMbps': row.get('downMbps'), 'upMbps': row.get('upMbps')}
        for row in (rows if isinstance(rows, list) else [])
        if valid(row)
    ][-MAX_SPEED_TESTS:]


def load_modem_line(path, now):
    """The router monitor's latest fiber reading, validated; None when there is none."""
    try:
        with open(path, encoding='utf-8') as handle:
            value = json.loads(handle.read(50_000))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or type(value.get('at')) is not int:
        return None
    if not 0 < value['at'] <= now + 30:
        return None

    def reading(item, low, high):
        is_number = isinstance(item, (int, float)) and not isinstance(item, bool)
        return round(item, 2) if is_number and low <= item <= high else None

    history, ports = value.get('history'), value.get('ports')
    return {
        'at': value['at'],
        'isRegistered': value['isRegistered']
        if isinstance(value.get('isRegistered'), bool)
        else None,
        'rxDbm': reading(value.get('rxDbm'), -60, 20),
        'txDbm': reading(value.get('txDbm'), -60, 20),
        'temperatureCelsius': reading(value.get('temperatureCelsius'), -40, 150),
        'cpuPercent': reading(value.get('cpuPercent'), 0, 100),
        'memoryPercent': reading(value.get('memoryPercent'), 0, 100),
        'ports': [
            {
                'port': row['port'],
                'isUp': row.get('isUp') is True,
                'speedMbps': reading(row.get('speedMbps'), 1, 100_000),
            }
            for row in (ports if isinstance(ports, list) else [])[:8]
            if isinstance(row, dict) and type(row.get('port')) is int and 1 <= row['port'] <= 8
        ],
        'rxHistory': [
            reading(row[1], -60, 20)
            for row in (history if isinstance(history, list) else [])[-120:]
            if isinstance(row, list) and len(row) == 2
        ],
    }


def save_closed_outages(path, summary_value):
    """Write finished outages for the alert watcher, only when they change (rare SD-card writes).
    Returns True when the file was replaced."""
    closed = [
        outage for outage in summary_value.get('outages', []) if outage.get('end') is not None
    ]
    text = json.dumps(closed)
    try:
        with open(path, encoding='utf-8') as handle:
            if handle.read(100_000) == text:
                return False
    except OSError:
        pass
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.chmod(temporary, 0o644)  # the alert watcher (another user) reads it
    os.replace(temporary, path)
    return True


def daily_facts(snapshot, now):
    """Names-only facts for the daily push (no MACs, addresses or secrets), from the map snapshot."""
    devices = snapshot.get('devices') or []
    internet = snapshot.get('internet') or {}
    closed = [
        outage
        for outage in internet.get('outages') or []
        if outage.get('end') is not None and now - outage['end'] <= KEEP_SECONDS
    ]
    longest = max(closed, key=lambda outage: outage['seconds'], default=None)

    tests = [test for test in internet.get('speedTests') or [] if now - test['at'] <= KEEP_SECONDS]

    def names(items):
        return [str(device.get('name'))[:40] for device in items][:10]

    weak = sorted(
        (
            device
            for device in devices
            if isinstance((device.get('traffic') or {}).get('signalDbm'), int)
            and device['traffic']['signalDbm'] < -70
        ),
        key=lambda device: device['traffic']['signalDbm'],
    )
    return {
        'at': int(now),
        'availability': internet.get('availability'),
        'samples': internet.get('samples') or 0,
        'outages': len(closed),
        'outageSeconds': sum(outage['seconds'] for outage in closed),
        'longest': {'seconds': longest['seconds'], 'cause': longest['cause']} if longest else None,
        'speedTest': tests[-1] if tests else None,
        'seen': sum(1 for device in devices if device.get('presence') == 'seen'),
        'newDevices': names(device for device in devices if device.get('isNew')),
        'weakWifi': [
            {'name': str(device.get('name'))[:40], 'signalDbm': device['traffic']['signalDbm']}
            for device in weak
        ][:10],
        'paused': names(device for device in devices if device.get('paused')),
        'routerStatus': (snapshot.get('routerTelemetry') or {}).get('status'),
    }


def save_json(path, value):
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False)
    os.chmod(temporary, 0o644)  # the daily summary (another user) reads it
    os.replace(temporary, path)


def save(path, rows):
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(rows, handle)
    os.replace(temporary, path)
