# Disposable installation test environment. No application or home credentials are present.
FROM leon-netmap-dev
RUN apt-get update && apt-get install --no-install-recommends -y openssl nftables unbound openssh-server sudo systemd dns-root-data age \
    && rm -rf /var/lib/apt/lists/*

# Debian normally copies this anchor in unbound's service pre-start hook.
RUN install -d /var/lib/unbound /run/sshd && cp /usr/share/dns/root.key /var/lib/unbound/root.key && ssh-keygen -A
