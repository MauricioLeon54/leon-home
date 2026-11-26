#!/usr/bin/env python3
"""One memory-only router login and two HostInfo reads; never change configuration."""

import hashlib
import hmac
import http.cookiejar
import ipaddress
import json
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

MAX_BYTES = 262144


class ProbeError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Tokens(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == 'meta' and fields.get('name') in ('csrf_param', 'csrf_token'):
            value = fields.get('content', '')
            if not 1 <= len(value) <= 256:
                raise ProbeError('invalidSession')
            self.values[fields['name']] = value


def proof(password, salt_hex, iterations, first_nonce, server_nonce):
    """Huawei's published SCRAMJS reverses HMAC arguments relative to standard SCRAM."""
    if (
        type(iterations) is not int
        or not 1 <= iterations <= 200000
        or not isinstance(salt_hex, str)
        or not re.fullmatch(r'[0-9a-fA-F]{16,128}', salt_hex)
        or len(salt_hex) % 2
        or not isinstance(server_nonce, str)
        or not first_nonce
        or not server_nonce.startswith(first_nonce)
        or not len(first_nonce) < len(server_nonce) <= 256
    ):
        raise ProbeError('invalidChallenge')
    salted = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt_hex), iterations)
    client_key = hmac.digest(b'Client Key', salted, 'sha256')
    server_key = hmac.digest(b'Server Key', salted, 'sha256')
    auth_message = f'{first_nonce},{server_nonce},{server_nonce}'.encode()
    signature = hmac.digest(auth_message, hashlib.sha256(client_key).digest(), 'sha256')
    client_proof = bytes(left ^ right for left, right in zip(client_key, signature)).hex()
    server_proof = hmac.digest(auth_message, server_key, 'sha256').hex()
    return client_proof, server_proof, server_key


class Router:
    # A closed diagnostic: only the login POSTs and known read paths. Subclasses may widen it.
    READS = frozenset({'/html/index.html', '/api/system/HostInfo'})
    WRITES = frozenset({'/api/system/user_login_nonce', '/api/system/user_login_proof'})

    def __init__(self, origin):
        from urllib.parse import urlsplit

        parts = urlsplit(origin)
        try:
            address = ipaddress.IPv4Address(parts.hostname)
            port = parts.port
        except (ValueError, TypeError) as error:
            raise ProbeError('invalidOrigin') from error
        private = any(
            address in ipaddress.ip_network(value)
            for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
        )
        if (
            not private
            or parts.scheme not in ('http', 'https')
            or parts.username is not None
            or parts.password is not None
            or parts.path not in ('', '/')
            or parts.query
            or parts.fragment
            or (port is not None and not 1 <= port <= 65535)
        ):
            raise ProbeError('invalidOrigin')
        self.origin = origin.rstrip('/')
        self.csrf = {}
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            NoRedirect(),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def request(self, path, data=None, timeout=6):
        if path not in (self.WRITES if data is not None else self.READS):
            raise ProbeError('unsupportedOperation')
        body = json.dumps({'csrf': self.csrf, 'data': data}).encode() if data is not None else None
        # Validated HTTP(S) origin and fixed route allowlist; redirects and proxies disabled.
        request = urllib.request.Request(  # noqa: S310
            self.origin + path,
            data=body,
            headers={
                'Content-Type': 'application/json; charset=utf-8',
                '_ResponseFormat': 'JSON',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': self.origin + '/html/index.html',
            },
        )
        with self.opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ProbeError('responseTooLarge')
        if path.endswith('.html'):
            return raw.decode('utf-8')
        result = json.loads(raw)
        if isinstance(result, dict) and 'csrf_param' in result and 'csrf_token' in result:
            self.csrf = {key: result[key] for key in ('csrf_param', 'csrf_token')}
        return result

    def refresh_csrf(self):
        """The page embeds the session's current token pair; writes rotate it in their reply."""
        tokens = Tokens()
        tokens.feed(self.request('/html/index.html'))
        if set(tokens.values) != {'csrf_param', 'csrf_token'}:
            raise ProbeError('invalidSession')
        self.csrf = tokens.values

    def login(self, username, password):
        self.refresh_csrf()
        nonce = secrets.token_hex(32)
        challenge = self.request(
            '/api/system/user_login_nonce', {'username': username, 'firstnonce': nonce}
        )
        if not isinstance(challenge, dict) or challenge.get('err') != 0:
            # Refused before any password proof was sent (busy, another login, lockout).
            raise ProbeError('loginUnavailable')
        client, expected, server_key = proof(
            password,
            challenge.get('salt'),
            challenge.get('iterations'),
            nonce,
            challenge.get('servernonce'),
        )
        result = self.request(
            '/api/system/user_login_proof',
            {'clientproof': client, 'finalnonce': challenge['servernonce']},
        )
        if (
            not isinstance(result, dict)
            or result.get('err') != 0
            or not isinstance(result.get('serversignature'), str)
            or not hmac.compare_digest(result['serversignature'], expected)
        ):
            raise ProbeError('authenticationRejected')
        rsa_n = result.get('rsan')
        if (
            not isinstance(rsa_n, str)
            or not re.fullmatch(r'[0-9a-fA-F]{128,2048}', rsa_n)
            or len(rsa_n) % 2
        ):
            raise ProbeError('invalidServerProof')
        expected_rsa = hmac.digest(server_key, bytes.fromhex(rsa_n), 'sha256').hex()
        if not isinstance(result.get('rsapubkeysignature'), str) or not hmac.compare_digest(
            result['rsapubkeysignature'], expected_rsa
        ):
            raise ProbeError('invalidServerProof')


def describe(value):
    """Export field names and types only, never response values, sessions or credentials."""
    if isinstance(value, list):
        rows = value[:256]
    elif isinstance(value, dict) and isinstance(value.get('HostInfo'), list):
        rows = value['HostInfo'][:256]
    else:
        return {
            'shape': type(value).__name__,
            'fields': sorted(str(key)[:64] for key in value)[:64]
            if isinstance(value, dict)
            else [],
            'records': None,
        }
    fields = {}
    for row in rows:
        if isinstance(row, dict):
            for key, item in list(row.items())[:64]:
                if isinstance(key, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', key):
                    fields[key] = type(item).__name__
    return {'shape': 'records', 'fields': dict(sorted(fields.items())[:64]), 'records': len(rows)}


def probe(device):
    router = Router(device['origin'])
    # The inspected BE3 Pro password-only login sets activeUser to admin.
    router.login(device['username'] or 'admin', device['password'])
    readings = []
    for index in range(2):
        if index:
            time.sleep(2)
        readings.append(
            {'observedAt': time.time(), **describe(router.request('/api/system/HostInfo'))}
        )
    return {
        'schemaVersion': 1,
        'router': {'state': 'authenticatedRead', 'samples': readings},
        'modem': {'state': 'notProbed'},
        'configurationWritesPerformed': False,
    }


def main():
    failure = None
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise ProbeError('invalidInput')
        report = probe(json.loads(raw))
    except ProbeError as error:
        failure = str(error)
    except urllib.error.HTTPError as error:
        failure = 'http' + str(error.code)
        error.close()
    except (OSError, ValueError, TypeError, KeyError):
        failure = 'transportOrProtocolFailure'
    if failure is not None:
        # Categories only: HTTP bodies, URLs and exception messages stay private.
        report = {
            'schemaVersion': 1,
            'router': {'state': 'probeFailed', 'reason': failure},
            'modem': {'state': 'notProbed'},
            'configurationWritesPerformed': False,
        }
    print(json.dumps(report, allow_nan=False))


if __name__ == '__main__':
    main()
