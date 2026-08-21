# Third-party notices

Last reviewed: 2026-08-20

This document identifies software that Castracker can invoke or interoperate
with. The Castracker source distribution does **not** include these third-party
binaries. Portable tools belong in the ignored `.tools` directory and must not
be added to a source commit or release by default.

Castracker's `GPL-3.0-or-later` license applies to Castracker itself. It does not
replace, narrow, or expand a third party's license. A person who redistributes a
binary bundle is responsible for reviewing the exact versions and build
configurations included in that bundle and satisfying all corresponding source,
license-text, notice, and attribution requirements.

## Deno

- Project: <https://github.com/denoland/deno>
- Purpose: runtime for Castracker and an optional JavaScript runtime for yt-dlp
- Upstream license: MIT
- License text: <https://github.com/denoland/deno/blob/main/LICENSE.md>
- Copyright: the Deno authors

Deno is installed independently or supplied by the user. Castracker does not
redistribute Deno in this source repository.

## yt-dlp

- Project: <https://github.com/yt-dlp/yt-dlp>
- Purpose: optional inspection and downloading of authorized public-media
  sources
- Core repository license: The Unlicense
- Core license text: <https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE>
- Upstream third-party notices:
  <https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt>

yt-dlp's release artifacts do not all have the same effective license. Upstream
currently states that its PyInstaller-bundled executables include GPLv3+
components and that the combined executable is distributed under GPLv3+.
Upstream also states that its Unix zipimport executable includes ISC- and
MIT-licensed components. Always use the notices shipped with the exact artifact
being redistributed; do not treat the core Unlicense as the license for every
prebuilt executable.

Castracker discovers an independently installed yt-dlp executable. It does not
copy yt-dlp source code into Castracker or include an executable in this source
distribution.

## FFmpeg and FFprobe

- Project: <https://ffmpeg.org/>
- Purpose: audio conversion, metadata, and artwork processing
- Upstream licensing information: <https://ffmpeg.org/legal.html>
- Upstream source: <https://ffmpeg.org/download.html#get-sources>
- Copyright: the FFmpeg developers

FFmpeg's effective license depends on its build configuration. Upstream FFmpeg
is primarily LGPL-2.1-or-later, but enabling GPL components changes the license
of the resulting build. Enabling version-3-only components can also change the
applicable version.

On Windows, `install-ffmpeg.ps1` downloads a checksum-verified Gyan Essentials
archive directly from <https://www.gyan.dev/ffmpeg/builds/> into the ignored
`.tools` directory. The build reviewed on the date above reports both
`--enable-gpl` and `--enable-version3`; redistribution of that build must follow
the GPLv3+ obligations and the notices and source information provided for the
specific Gyan release. The installer script's presence does not place the
downloaded archive in the Castracker source distribution.

## Audiobookshelf

- Project: <https://github.com/advplyr/audiobookshelf>
- Purpose: optional library-layout interoperability
- Upstream license: GPL-3.0
- License text: <https://github.com/advplyr/audiobookshelf/blob/master/LICENSE>

Audiobookshelf code is not included or invoked by Castracker. References to
Audiobookshelf describe file-layout compatibility and do not imply affiliation,
endorsement, or sponsorship.

## Media and metadata

Podcast audio, video, artwork, descriptions, and feed metadata are not licensed
under the Castracker license merely because Castracker can process them. Their
rights remain with their respective owners and licensors. Do not commit local
state, downloaded media, artwork, or sidecar metadata to the Castracker
repository unless you have explicit redistribution rights.

## Binary-release checklist

Before publishing a release that contains any third-party executable:

1. Record the exact artifact name, version, checksum, and upstream URL.
2. Inspect that artifact's embedded or accompanying license and notice files.
3. Include every required license text and copyright notice.
4. Provide corresponding source code or a compliant source offer when required.
5. Document local modifications and build configuration.
6. Have the final distribution reviewed independently; this file is a source
   inventory, not legal advice or a substitute for the upstream licenses.
