# Third-party notices

This private trial distribution retains dependency license files in the bundled `node_modules` and model/runtime notices under `models/licenses`. The application itself has not been assigned a public open-source license.

| Component | Pinned version | License / location |
|---|---|---|
| Qwen3-1.7B-GGUF | Revision in `models/manifest.json` | Apache-2.0; `models/licenses` |
| Qwen3-Embedding-0.6B-GGUF | Revision in `models/manifest.json` | Apache-2.0; `models/licenses` |
| llama.cpp | b10809 | MIT; `models/licenses` |
| LanceDB OSS Node SDK | 0.38.0 | Apache-2.0; bundled package license |
| Apache Arrow JS | 18.1.0 | Apache-2.0; bundled package LICENSE and NOTICE |
| Model Context Protocol SDK | 1.30.0 | MIT; bundled package license |
| proper-lockfile | 4.1.2 | MIT; bundled package license |
| Zod | 4.6.1 | MIT; bundled package license |

Dependency versions and integrity digests are locked in `package-lock.json`. The optional `sharp` dependency is overridden to 0.35.4, the patched version for upstream image decoding advisories. Banana Memory does not use optional cloud embedding clients or image inference APIs.

Model files are downloaded from the original publishers at installation time rather than redistributed inside the application archive. Their exact origin URLs, revisions, hashes, sizes and licenses accompany the release.
