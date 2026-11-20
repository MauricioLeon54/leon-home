"""Conservative system maintenance policy, included in the signed base identity."""

APT_CLEANUP_PATH = '/etc/apt/apt.conf.d/80-leon-home-cleanup'
APT_CLEANUP = """// Use existing APT timers; remove only obsolete downloaded package archives.
// No installed packages, DNS caches or household data are removed.
APT::Periodic::AutocleanInterval "7";
"""
