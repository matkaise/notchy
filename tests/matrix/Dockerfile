# One GNOME Shell release in a container, for scripts/test-matrix.sh and CI.
# Ubuntu ships each GNOME release with gnome-shell-test-tool:
#   24.10 → GNOME 47, 25.04 → 48, 25.10 → 49, 26.04 → 50, 26.10 → 51.
# Releases past their end of life live on old-releases.ubuntu.com.
ARG UBUNTU=26.04
FROM ubuntu:${UBUNTU}
ENV DEBIAN_FRONTEND=noninteractive
RUN set -e; \
    sources=/etc/apt/sources.list.d/ubuntu.sources; \
    if ! apt-get update; then \
        sed -i -E 's#http://(archive|security)\.ubuntu\.com#http://old-releases.ubuntu.com#g' "$sources"; \
        apt-get update; \
    fi; \
    apt-get install -y --no-install-recommends \
        gnome-shell gnome-shell-common gjs xwayland dbus dbus-user-session libglib2.0-bin \
        python3 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gstreamer-1.0 gir1.2-gdkpixbuf-2.0 gir1.2-graphene-1.0 \
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good libgl1-mesa-dri mesa-vulkan-drivers \
        at-spi2-core adwaita-icon-theme fonts-cantarell fonts-dejavu-core ubuntu-wallpapers locales language-pack-gnome-de-base gnome-text-editor zip unzip nodejs ca-certificates; \
    # LocalSearch's settings schema (the indexed folders); the test talks to a
    # stand-in index. GNOME 47's Ubuntu still names the package tracker-miner-fs.
    apt-get install -y --no-install-recommends localsearch || apt-get install -y --no-install-recommends tracker-miner-fs; \
    sed -i 's/^# *de_DE.UTF-8/de_DE.UTF-8/' /etc/locale.gen; locale-gen; \
    rm -rf /var/lib/apt/lists/*; \
    # Xwayland's socket directory, as a desktop has it (Mutter 47 insists).
    mkdir -p -m 1777 /tmp/.X11-unix; \
    test -x /usr/bin/gnome-shell-test-tool
# gnome-text-editor is one of Ubuntu's favourite apps: without any installed
# favourite the dash starts empty, and GNOME 51.0's dash then fails on the
# first running app it has not styled yet (dash.js _adjustIconSize).
# German for the Shell itself: GLib's g_dgettext() turns translations off for
# the whole process when the Shell's own domain has no catalog for the
# locale, which would leave Notchy's German catalog unused as well.
# The tests run as an ordinary user, as on a desktop.
RUN (getent passwd 1000 >/dev/null && userdel -r "$(getent passwd 1000 | cut -d: -f1)" 2>/dev/null || true); \
    useradd -m -u 1000 tester
USER tester
ENV LANG=de_DE.UTF-8 XDG_RUNTIME_DIR=/tmp/runtime-tester
WORKDIR /home/tester
