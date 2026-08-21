# Security policy

## Supported version

Security fixes are applied to the current default branch. Older snapshots and
unofficial binary bundles are not supported.

## Deployment boundary

Castracker is a single-user local application. It listens only on `127.0.0.1`,
has no LAN or public-server mode, and must not be placed behind a public reverse
proxy. Mounted network storage is supported as a library target; network clients
are not.

The process can read and write user-selected library paths, make outbound
network requests, and run Deno, FFmpeg, PowerShell on Windows, and optional
yt-dlp. It uses Deno's combined `--allow-all` grant because Windows UNC paths
cannot be used with separate read/write grants. Treat the project directory and
all discovered executables as trusted code. Do not install unverified
replacements in `.tools` or earlier on `PATH`.

## Reporting a vulnerability

Use GitHub's private **Security > Report a vulnerability** flow when it is
available for the repository. Include the affected version, operating system,
reproduction steps, impact, and any suggested mitigation.

If private vulnerability reporting is unavailable, open a public issue titled
`Security contact requested` without exploit details, secrets, personal data, or
sensitive paths. A maintainer can then arrange a private channel.

Please do not test against systems or media accounts that you do not own or have
permission to use. Do not include downloaded media, authentication material, or
private library data in a report.
