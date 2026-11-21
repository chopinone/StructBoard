# Publishing source and releases

1. Run the source guard, frontend checks and regression suite on the reviewed commit.
2. Build binaries from that clean source checkout. Do not publish an installation folder that has been used with personal workspaces.
3. Run `tools/build_public_release.py` with the new build output. It copies only the declared public source inventory and includes license files in distributions.
4. Check the extracted source archive with `tools/check_public_source.py --root PATH --all-files`. Inspect the portable ZIP and installer payload separately.
5. Publish the corresponding source ZIP alongside binaries, `LICENSE`, third-party notices and checksums so each release can be rebuilt and audited. Keep each release's license file with its artifacts; previously published releases retain the license they shipped with.

The GitHub workflow produces artifacts on manual dispatch. It does not publish a release automatically. Choose an empty public repository and push only the reviewed source history. Never attach an unrelated development repository or old Git object directory.

Do not include local audit logs, runtime profiles, credential files, research pipelines, model outputs, screen recordings or debug dumps. Promotional media should receive a separate content review before it is attached to a public release.
