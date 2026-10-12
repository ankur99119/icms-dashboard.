# ICMS shared viewer package

This package contains only static dashboard code, not operational data.
It is NOT a working deployment until Google publishing and reader sign-in
are configured and tested. The writer and receiver require protocol v2.

Upload these five viewer files together to the chosen static-site root.
config.js contains public identifiers only, not passwords or writer tokens.
Keep the Sheet private and share it only with the approved readers.

The collecting computer needs the complete local project, its ICMS login,
and its private writer configuration. They do NOT belong in this package.
Run "Check ICMS Setup.command" on that computer for configuration gaps.

Before officers use it: verify one live source window, one committed cloud
publication, sign-in from a second computer, and failed-publication handling.
Google deployment and repository changes are not performed by packaging.

## Upload on GitHub (ankur99119)

1. Sign in to github.com/ankur99119.
2. Create a repository named icms-dashboard. For the simplest GitHub Pages
   setup choose Public. This package contains code only, not ICMS data.
3. Unzip this package on your Mac. Upload its contents, not the ZIP itself.
   index.html must be at the repository root, not inside another folder.
4. Use Add file -> Upload files, then commit the uploaded files.
5. Open repository Settings -> Pages. Choose Deploy from a branch, select
   main and /(root), then Save.
6. Wait for GitHub to display the actual published URL. The expected address
   is https://ankur99119.github.io/icms-dashboard/ ; it is not verified live
   merely because this package was generated.
7. Send that address back for reader Google sign-in configuration.

The required dashboard files are index.html, app.js, styles.css, config.js,
and periods.js. README.md and PACKAGE-MANIFEST.json may also be uploaded.
Do not upload the full project, data directory, ICMS reports or writer token.

## Current limitation

Reader CLIENT_ID is currently blank unless you have configured it separately.
The page will explain that sign-in is not configured; private data cannot yet
load. Do not make the Sheet public to work around this. The Google OAuth web
client needs authorised JavaScript origin https://ankur99119.github.io
(the origin has no /icms-dashboard/ path). Approved reader sharing and a
second-computer test remain required.

The first bounded central snapshot was committed for 10-Oct-2026. This viewer
currently supports Report 19 originating summaries and Report 16 detention
with Report 301 descriptions, not all locally planned modules. Your collection
computer remains necessary for fresh ICMS data; GitHub runs no collector.
