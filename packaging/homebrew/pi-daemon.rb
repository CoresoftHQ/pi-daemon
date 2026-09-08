# Homebrew formula for the tap `CoresoftHQ/homebrew-tap` (Formula/pi-daemon.rb), so that
#   brew install coresofthq/tap/pi-daemon
# installs the CLI with Node as a dependency. The release workflow prints the sha256 for the
# tarball; update `url` and `sha256` per release.
class PiDaemon < Formula
  desc "Runs Pi Coding Agent sessions, workspaces, and terminals for remote clients"
  homepage "https://github.com/CoresoftHQ/pi-daemon"
  url "https://github.com/CoresoftHQ/pi-daemon/releases/download/v1.0.0/pi-daemon-1.0.0.tgz"
  sha256 "REPLACE_WITH_SHA256_FROM_RELEASE"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  # `brew services start pi-daemon` is an alternative to `pi-daemon setup`; both run `serve`.
  service do
    run [opt_bin/"pi-daemon", "serve"]
    keep_alive true
    working_dir var
    log_path var/"log/pi-daemon.log"
    error_log_path var/"log/pi-daemon.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pi-daemon --version")
  end
end
