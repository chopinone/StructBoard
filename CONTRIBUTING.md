# Contributing

Install the prerequisites and follow the build instructions in README.md. Keep regression fixtures artificial and reproducible. Contributions to first-party code are provided under the MIT License.

Before submitting:

```powershell
python tools/check_public_source.py
npm run build:ui
npm run check:ui
npm run test:ui
python -I -B tools/run_all_tests.py
```

Add new public source files explicitly to `public-source.json` and the applicable resource contract. New or changed images require a visual and metadata privacy review before updating `reviewedAssets`. Never loosen the checks to accommodate a private dataset.

Use generated fixtures for reproductions. Do not attach real structure files, research names, local paths, screenshots of private projects, API keys, client configuration, connection tokens or logs containing them to public issues or pull requests.
