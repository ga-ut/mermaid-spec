# Publishing a release

The package is `@ga-ut/mermaid-spec`, a Bun CLI published under the GA-UT
organization on the public npm registry. The executable is named `mermaid-spec`.
Consumers can use `bunx` or a global install; npm and Node.js are needed only
if a maintainer uses npm's publishing client.

## Prepare

1. Use the GA-UT repository and a clean checkout. Follow
   [the versioning policy](./versioning.md); do not move an existing tag or
   reuse a published npm version.
2. Update `package.json`, the changelog, and version-pinned documentation.
3. Run `bun ci` and `bun run release:check`. This rebuilds the committed
   examples and runs all verification gates. Review the generated diff.
4. Review the complete publish file list. Only public source, examples, and
   documentation belong in the package. Exclude private specifications,
   credentials, local data, recordings, and test/build output.

## Pack and verify

Create a temporary directory outside the checkout and run:

```bash
npm pack --pack-destination <temporary-directory> --json
bun ./scripts/smoke-package.js --archive <absolute-path-to-tarball>
```

The smoke test installs that exact archive in a temporary project and checks
CLI help/version, specification validation, build/verify, and public exports.
It removes its temporary installation when finished. Keep the audited tarball
outside Git until publication finishes.

## Publish

1. Confirm the intended npm account with
   `npm whoami --registry=https://registry.npmjs.org/`. If needed, complete
   `npm login` and any browser or two-factor prompts yourself. Never put a
   token, password, or one-time code in a commit, issue, or chat message.
   Confirm membership with `npm org ls ga-ut` and check that the packed
   package name is exactly `@ga-ut/mermaid-spec` before publishing.
2. Commit the reviewed source and generated files. Record the commit and
   archive checksum. Publish the audited archive:

   ```bash
   npm publish <absolute-path-to-tarball> --access public --registry=https://registry.npmjs.org/
   ```

   Publishing an archive does not replace the verification gate above. Do not
   publish a different archive after testing, or infer success from a dry run.
3. Check `npm view @ga-ut/mermaid-spec@<version> version dist.integrity` and compare
   the integrity value with the audited archive. If publication times out,
   check the registry before retrying.
4. From a directory without a local install, use a fresh Bun cache and run
   `bunx @ga-ut/mermaid-spec@<version> --version`, then the README's first-specification
   commands. Confirm that no project dependency was added.
5. Push the matching commit and annotated `v<version>` tag, check CI, and
   create a GitHub Release pointing to that tag. Link the npm package and
   describe the changes and runtime requirement.

Keep local verification, npm publication, GitHub publication, and registry
installation checks as separate outcomes. If authentication or publication
fails, do not claim the package is available. Delete only the temporary
artifacts created for this release after it is verified.
