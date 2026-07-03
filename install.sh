#!/bin/sh
# orch installer — downloads the latest release binary for this platform.
#
#   curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh | sh
#
# Overrides:
#   ORCH_INSTALL_DIR   install directory (default: ~/.local/bin)
#   ORCH_VERSION       release tag such as v0.0.4 (default: latest)
#
# Later upgrades: `orch update`.
set -eu

REPO="yanyaoer/orch-cli"
INSTALL_DIR="${ORCH_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${ORCH_VERSION:-latest}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "install.sh: unsupported OS: $os (build from source: bun install && bun run install:local)" >&2
    exit 1
    ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "install.sh: unsupported architecture: $arch (build from source: bun install && bun run install:local)" >&2
    exit 1
    ;;
esac

asset="orch-${os}-${arch}"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

mkdir -p "$INSTALL_DIR"
# Stage inside the install dir so the final rename is atomic on one filesystem.
staged="$INSTALL_DIR/.orch-download.$$"
trap 'rm -f "$staged"' EXIT INT TERM

echo "downloading $url"
curl -fSL --proto '=https' -o "$staged" "$url"
chmod 755 "$staged"
# The binary must at least print its help before it may claim the name.
"$staged" --help >/dev/null 2>&1 || {
  echo "install.sh: downloaded binary failed to run" >&2
  exit 1
}
mv "$staged" "$INSTALL_DIR/orch"
trap - EXIT INT TERM

# Releases before v0.0.5 print help for --version; keep the first line either way.
installed_version=$("$INSTALL_DIR/orch" --version 2>/dev/null | head -n 1 || true)
[ -n "$installed_version" ] || installed_version="orch ($VERSION)"
echo "installed $installed_version -> $INSTALL_DIR/orch"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: $INSTALL_DIR is not on your PATH; add it, e.g. export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
echo "next: orch --help · upgrade later with: orch update"
