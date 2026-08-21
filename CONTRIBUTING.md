# Contributing to Castracker

Thank you for helping improve Castracker.

## Ground rules

- Submit only code and other material that you have the right to license.
- By contributing, you agree that your contribution is licensed under
  `GPL-3.0-or-later`, the same license as Castracker.
- Do not commit downloaded audio, video, artwork, personal library state,
  credentials, cookies, access tokens, or third-party executables.
- Use reserved example domains and synthetic metadata in tests. Do not add a
  real publisher feed or copyrighted catalog as a default or fixture.
- Do not add authentication bypasses, cookie extraction, paywall or DRM
  circumvention, or functionality intended to reach private or restricted
  content.
- Preserve the loopback-only server model and public-network URL validation.

## Before opening a change

Run:

```text
deno fmt
deno task verify
```

Update `THIRD_PARTY_NOTICES.md` when adding, changing, downloading, or bundling
a third-party component. Keep changes focused and include tests for security
boundaries and error handling.

Report vulnerabilities according to `SECURITY.md`, not in a public issue with
exploit details. Report copyright or other rights concerns according to
`RIGHTS.md`.
