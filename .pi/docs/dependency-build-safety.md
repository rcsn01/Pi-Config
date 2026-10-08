# Dependency build approval review

## Conclusion

The reviewed installation scripts show no suspicious behavior. Approving these exact versions is reasonable. Name-only approvals also cover future versions, so version-qualified approvals are safer.

This is a review of installation behavior, not a full audit of the packages' runtime code or a guarantee against compromised releases. Build approvals permit code execution with the installer's permissions; they do not sandbox scripts.

## Evidence

The installed versions and their dependency paths come from `.pi/pnpm-lock.yaml`:

- `@google/genai@2.21.0` comes through `@earendil-works/pi-ai`.
- `protobufjs@7.6.5` comes through `@google/genai`.
- `esbuild@0.28.2` comes through `@earendil-works/chord` and Vite.

Fetched the published npm archives without executing any package code. For all three packages, the archive SHA-512 matched both npm registry metadata and the repository lockfile. Published manifests matched installed manifests. The published esbuild and protobufjs install scripts matched their installed copies byte-for-byte. This confirms consistency, not publisher trustworthiness.

## Script behavior

| Package | Reviewed behavior | Assessment |
| --- | --- | --- |
| `@google/genai@2.21.0` | `preinstall` only runs `echo 'preinstall: no-op'`. The manifest also declares `prepare`, but its referenced file is absent from the published archive. This assessment covers the registry dependency, not a Git/source installation. | The preinstall is harmless and does not need approval for functionality. Blocking it explicitly is a reasonable least-privilege option. |
| `esbuild@0.28.2` | `postinstall` runs `node install.js`. Locates the platform-specific binary, links it into place, and executes it with `--version`. If the optional binary package is missing, can invoke npm or download its exact-version archive from npm. Fallback binaries are checked against embedded SHA-256 hashes. Supports an explicit `ESBUILD_BINARY_PATH` environment override. | Normal native executable setup. Reasonable to approve this version, but it has real filesystem, network, and process-execution capabilities. |
| `protobufjs@7.6.5` | `postinstall` reads package manifests and optionally prints a warning about dependency version schemes. Returns immediately when its own `versionScheme` is absent. No networking, subprocess execution, or file writes in this script. | Low-risk install script. Approval is reasonable, though blocking the warning-only hook should not affect runtime behavior. |

No install, rebuild, or lifecycle script was run during this review.

## Configuration recommendation

For a conservative configuration that preserves the existing approvals but limits them to reviewed versions:

```yaml
allowBuilds:
  '@google/genai@2.21.0': true
  'esbuild@0.28.2': true
  'protobufjs@7.6.5': true
```

For least privilege, explicitly denying the Google SDK's no-op hook and protobufjs's warning-only hook is also reasonable. Validate a fresh install and the project's relevant workflows before adopting those denials.

Official pnpm documentation describes version-qualified matchers and says unlisted versions remain blocked. Bare package names are not version-qualified and should be treated as approving future releases too. A lockfile limits the versions installed today, but does not restrict the approval after a lockfile update. Keep unreviewed builds blocked; do not enable `dangerouslyAllowAllBuilds`.

No build configuration was changed by this review.

## Primary sources

- [pnpm build settings, including allowBuilds](https://pnpm.io/settings/build#allowbuilds)
- [pnpm strictDepBuilds](https://pnpm.io/settings/build#strictdepbuilds)
- [Published Google SDK 2.21.0 metadata and archive link](https://registry.npmjs.org/@google%2fgenai/2.21.0)
- [Published esbuild 0.28.2 metadata and archive link](https://registry.npmjs.org/esbuild/0.28.2)
- [Published protobufjs 7.6.5 metadata and archive link](https://registry.npmjs.org/protobufjs/7.6.5)

The install-script findings were derived from the exact published archives referenced by these metadata endpoints, not from a moving repository branch.
