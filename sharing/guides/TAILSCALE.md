# Tailscale and support

Each household keeps its own account, Pi and DNS. Sharing one device does not require merging
accounts into one tailnet. Your support person does not need the LEÓN Mac app.

## Share only the Pi

1. From the owner's account, share **only the Raspberry Pi** with the support person's account.
   Send the invitation privately and accept it with the intended identity. Never publish
   invitation links or authentication keys on GitHub.
2. Set permissions in both tailnets. In the owner's tailnet, allow the owner's phone to reach
   DNS on TCP/UDP 53 and HTTPS on TCP 443 on this Pi. Allow support only TCP 22 to this Pi.
   In the support tailnet, allow outgoing TCP 22 to the shared Pi.
3. Review existing broad rules. A narrow grant does not override an earlier rule allowing
   `*` to `*`. Test that support cannot reach ports 443/53 or other devices.
4. Use OpenSSH with a dedicated key and a verified host fingerprint. Device sharing does not
   replace SSH authentication. Keep Tailscale SSH disabled and do not reuse another device's keys.

This is **an example grant fragment**, not a complete replacement policy. These identities and
IP address are synthetic. Put the actual installation's values in its private policy and
preserve other legitimate access rules:

```json
{
  "grants": [
    {
      "src": ["owner@example.test"],
      "dst": ["100.64.0.2"],
      "ip": ["tcp:443", "tcp:53", "udp:53"]
    },
    {
      "src": ["support@example.test"],
      "dst": ["100.64.0.2"],
      "ip": ["tcp:22"]
    }
  ]
}
```

Tailscale limits network access; LEÓN separately verifies panel ownership. The independent
edition receives HTTP over a restricted Unix socket. A support SSH user cannot impersonate
the owner by supplying identity headers to an open local HTTP port.

## Prepare support access

Before installation, create a dedicated support key on your own computer. Protect its private
part with a passphrase and your SSH agent. Setup receives only the `.pub` file. For example:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/leon_home_support_ed25519
```

Do not overwrite an existing key or copy the private key to the Pi. When connecting, select
that key with `-i ~/.ssh/leon_home_support_ed25519` and use
`-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`, after pinning the host fingerprint through
a trusted channel. You can save these options in a private SSH alias.

The configured key opens a separate `leon-support` account with a forced command:

```sh
ssh leon-support@PI_FULL_HOSTNAME status
ssh leon-support@PI_FULL_HOSTNAME check-updates
ssh leon-support@PI_FULL_HOSTNAME restart-panel
ssh leon-support@PI_FULL_HOSTNAME restart-updates
```

The account has no interactive shell, SFTP, tunnels or arbitrary command execution. Restarts
are limited to the two LEÓN services above. Check status before restarting and avoid interrupting
an installation. The owner accepts updates from the panel; support cannot send the acceptance
operation to the updater.

Operating system administration and changes to the protected bootstrap require a separate
administrative session authorized by the owner. Keep the owner's local recovery account and
password available.

## Revoke support

Remove the device share and its access rule in Tailscale, then remove the authorized key from
`leon-support` with the local administrator. Owner access to the panel remains independent.

References: [device sharing](https://tailscale.com/kb/1084/sharing),
[separate accounts and invitations](https://tailscale.com/docs/reference/inviting-vs-sharing),
[Tailscale Serve identity](https://tailscale.com/docs/features/tailscale-serve).
