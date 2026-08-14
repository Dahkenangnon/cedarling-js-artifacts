# Cedarling JavaScript artifacts

This local repository stages reproducible, pre-publication snapshots of
`@janssenproject/cedarling`. It exists so Cedarling.dev can exercise the exact
JavaScript SDK that will later be proposed for the official repository without
publishing from the Jans working tree.

The snapshot command:

1. exports the current Jans `HEAD` into an ignored build directory;
2. overlays tracked working-tree changes and untracked files below
   `jans-cedarling`;
3. builds the WebAssembly package with a checksum-pinned `wasm-pack`;
4. builds the JavaScript SDK and bundles the WebAssembly package into one npm
   tarball;
5. writes provenance, checksums, and an SPDX SBOM; and
6. installs the tarball in an offline-style consumer fixture and exercises ESM,
   CommonJS, WebAssembly initialization, and a real Cedar authorization.

Run:

```sh
npm run snapshot
```

Generated source trees and tools remain ignored. Only the packaged artifacts
and their metadata are committed. This repository is never published or pushed
by the automation in this checkout.

