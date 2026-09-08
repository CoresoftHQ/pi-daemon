#!/bin/sh
# Installs the pi-daemon CLI on Linux or macOS:
#   curl -fsSL https://raw.githubusercontent.com/CoresoftHQ/pi-daemon/main/install.sh | sh
# Installs only. Afterwards, `pi-daemon setup` registers the service.
#
# What it does: finds or installs Node (>= 22.19, into ~/.local/share/pi-daemon/node if the
# system has none), then installs the release tarball. Environment overrides:
#   PI_DAEMON_VERSION=1.0.0     a specific release (default: latest)
#   PI_DAEMON_TGZ=<path|url>    install this tarball instead of a GitHub release asset
#   PI_DAEMON_PREFIX=<dir>      npm prefix to install into (default: a private one under ~/.local)
set -eu

REPO="CoresoftHQ/pi-daemon"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19
NODE_MAJOR=22
HOME_DIR="${HOME:?}"
BASE="${XDG_DATA_HOME:-$HOME_DIR/.local/share}/pi-daemon"
PREFIX="${PI_DAEMON_PREFIX:-$BASE/cli}"
BIN_DIR="$HOME_DIR/.local/bin"

say() { printf '%s\n' "$*" >&2; }
die() { say "install.sh: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need curl
need tar

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) node_os=linux ;;
  Darwin) node_os=darwin ;;
  *) die "unsupported OS $os (use install.ps1 on Windows)" ;;
esac
case "$arch" in
  x86_64|amd64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) die "unsupported CPU $arch" ;;
esac

node_ok() {
  v=$("$1" --version 2>/dev/null | sed 's/^v//') || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt "$MIN_NODE_MAJOR" ] || { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }
}

NODE=""
if command -v node >/dev/null 2>&1 && node_ok node; then
  NODE=$(command -v node)
  say "using $(node --version) at $NODE"
elif [ -x "$BASE/node/bin/node" ] && node_ok "$BASE/node/bin/node"; then
  NODE="$BASE/node/bin/node"
  say "using $($NODE --version) at $NODE"
else
  say "Node >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR not found; installing Node $NODE_MAJOR under $BASE/node"
  ver=$(curl -fsSL https://nodejs.org/dist/index.json | tr ',' '\n' | grep -o "\"version\":\"v$NODE_MAJOR\.[0-9.]*\"" | head -1 | sed 's/.*"v\([0-9.]*\)"/\1/')
  [ -n "$ver" ] || die "could not determine the latest Node $NODE_MAJOR"
  name="node-v$ver-$node_os-$node_arch"
  mkdir -p "$BASE"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$ver/$name.tar.gz" -o "$tmp/node.tar.gz"
  rm -rf "$BASE/node"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  mv "$tmp/$name" "$BASE/node"
  rm -rf "$tmp"
  NODE="$BASE/node/bin/node"
  say "installed $($NODE --version)"
fi
NODE_BIN=$(dirname "$NODE")
export PATH="$NODE_BIN:$PATH"
NPM="$NODE_BIN/npm"
[ -x "$NPM" ] || NPM=$(command -v npm) || die "npm not found next to $NODE"

# the tarball
if [ -n "${PI_DAEMON_TGZ:-}" ]; then
  TGZ="$PI_DAEMON_TGZ"
else
  if [ -n "${PI_DAEMON_VERSION:-}" ]; then
    tag="v$PI_DAEMON_VERSION"
  else
    tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v[^"]*\)"/\1/')
    [ -n "$tag" ] || die "could not find the latest release of $REPO"
  fi
  TGZ="https://github.com/$REPO/releases/download/$tag/pi-daemon-${tag#v}.tgz"
fi
say "installing $TGZ into $PREFIX"
mkdir -p "$PREFIX" "$BIN_DIR"
"$NPM" install -g --prefix "$PREFIX" --no-audit --no-fund --loglevel=error "$TGZ"

# on PATH: a launcher that carries the Node we chose, so the service unit needs no PATH luck
cat > "$BIN_DIR/pi-daemon" <<EOF
#!/bin/sh
export PATH="$NODE_BIN:\$PATH"
exec "$NODE" "$PREFIX/lib/node_modules/pi-daemon/dist/cli/main.js" "\$@"
EOF
chmod +x "$BIN_DIR/pi-daemon"

say ""
say "installed pi-daemon $("$BIN_DIR/pi-daemon" --version)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "add $BIN_DIR to your PATH (e.g. in ~/.profile): export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "next:  pi-daemon doctor      # checks pi, providers, port, service"
say "       pi-daemon setup       # registers the service and starts it"
