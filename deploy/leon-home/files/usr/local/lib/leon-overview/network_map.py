"""Read-only, bounded presentation contract for the shared network canvas."""

import ipaddress
import math
import time

import router_telemetry

MAX_DEVICES = 64
FRESH_SECONDS = 660


def number(value):
    return (
        value
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        else None
    )


def text(value, limit=100):
    return (
        ''.join(character for character in value[:limit] if character.isprintable())
        if isinstance(value, str)
        else ''
    )


def snapshot(data, now=None):
    """Allowlist fields; the observation date belongs to discovery, not HTTP refresh."""
    now = time.time() if now is None else now
    sampled_at = number(data.get('at'))
    network = (data.get('snapshot') or {}).get('network') or {}
    scan_age = number(network.get('scanAgeSeconds'))
    observed_at = (
        sampled_at - scan_age
        if sampled_at is not None and scan_age is not None and scan_age >= 0
        else None
    )
    if observed_at is not None and not 0 < observed_at <= now + 30:
        observed_at = None
    freshness = (
        'unknown'
        if observed_at is None
        else 'current'
        if now - observed_at <= FRESH_SECONDS
        else 'stale'
    )
    devices, sources = [], []
    seen = set()
    source = data.get('devices')
    for device in (source if isinstance(source, list) else [])[:256]:
        if not isinstance(device, dict):
            continue
        try:
            address = str(ipaddress.IPv4Address(device.get('ip')))
        except (ipaddress.AddressValueError, TypeError):
            continue
        if address in seen:
            continue
        seen.add(address)
        last_seen = number(device.get('lastSeen'))
        if last_seen is not None and not 0 < last_seen <= now + 30:
            last_seen = None
        sources.append(device)
        devices.append(
            {
                'id': address,
                'address': address,
                'name': text(device.get('label')) or text(device.get('name')) or address,
                'kind': text(device.get('kind'), 40),
                'role': text(device.get('role'), 40),
                'presence': 'unknown'
                if freshness != 'current'
                else 'seen'
                if device.get('online') is True
                else 'notSeen',
                'lastSeen': last_seen,
                # First seen in the last 24 h (new-device alert); the MAC itself stays server-side.
                'isNew': device.get('isNew') is True,
                'canRename': device.get('canRename') is True,
            }
        )
        if len(devices) == MAX_DEVICES:
            break
    telemetry = router_telemetry.read(now)
    by_address = {row['address']: row for row in telemetry['devices']}
    wifi_filter = telemetry.get('wifiFilter') or {}
    # Pausing needs a current reading of an enabled blocklist; a paused device can always be resumed.
    filter_ready = (
        telemetry['status'] == 'current'
        and wifi_filter.get('enabled') is True
        and wifi_filter.get('policy') == 'block'
    )
    blocked = set(wifi_filter.get('blockedMacs') or []) if filter_ready else set()
    for device, source_device in zip(devices, sources):
        device['traffic'] = by_address.get(device['address'])
        mac = source_device.get('mac')
        device['paused'] = bool(mac) and mac in blocked
        schedule = source_device.get('pauseSchedule')
        device['pauseSchedule'] = (
            {key: schedule[key] for key in ('days', 'start', 'end')}
            if isinstance(schedule, dict)
            else None
        )
        device['canPause'] = (
            filter_ready
            and bool(mac)
            and (
                device['paused']
                or (
                    (device['traffic'] or {}).get('connection') == 'wifi'
                    and source_device.get('protected') is not True
                )
            )
        )
    return {
        'schemaVersion': 1,
        'routerTelemetry': {
            key: value for key, value in telemetry.items() if key not in ('devices', 'wifiFilter')
        },
        'observedAt': observed_at,
        'freshness': freshness,
        'freshSeconds': FRESH_SECONDS,
        'devices': devices,
        'truncated': isinstance(source, list) and len(source) > MAX_DEVICES,
        'source': 'leon-netmap',
        'physicalTopology': 'unverified',
        'internet': data.get('internetHealth')
        if isinstance(data.get('internetHealth'), dict)
        else None,
        # Router ports report link and negotiated speed, not per-port byte counters.
        'ethernetTelemetry': 'linkStatus',
        'portControl': 'ownerAllowlist',
    }
