# winget

Manifests for `winget install CoresoftHQ.PiDaemon`, submitted to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) under
`manifests/c/CoresoftHQ/PiDaemon/<version>/`. The installer is the portable zip the release
workflow builds (`pi-daemon-<version>-win-x64.zip`: `node.exe`, the package, and
`pi-daemon.cmd`), so nothing else needs to be installed first.

Per release: copy the three files below into a new version directory, set `PackageVersion`,
the `InstallerUrl`, and the `InstallerSha256` printed by the release workflow, then

```powershell
winget validate --manifest .\manifests\c\CoresoftHQ\PiDaemon\1.0.0
wingetcreate submit .\manifests\c\CoresoftHQ\PiDaemon\1.0.0   # opens the PR
```

The first submission is reviewed by hand; later ones are mostly automated. The zip is not code
signed, so the first run shows a SmartScreen prompt; signing is a separate decision.
