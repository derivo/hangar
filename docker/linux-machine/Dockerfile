# A Linux machine for `pnpm test:linux-setup` (ADR 0041, step 2): Debian with systemd as PID 1,
# OpenSSH and a normal user whose systemd user manager runs (logind). No Node: the app brings
# its own. Run with --privileged (systemd needs its cgroups); only for tests.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session \
      libpam-systemd openssh-server git ca-certificates \
 && rm -r /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash person \
 && mkdir -p /etc/ssh/keys \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowTcpForwarding local\nAuthorizedKeysFile /etc/ssh/keys/%%u\nUsePAM yes\n' >> /etc/ssh/sshd_config \
 && systemctl enable ssh \
 && systemctl mask getty@tty1.service console-getty.service
# The public key of the test, as a build argument: no volume needed.
ARG KEY
RUN printf '%s\n' "$KEY" > /etc/ssh/keys/person && chmod 644 /etc/ssh/keys/person
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
