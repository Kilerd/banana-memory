# Pinned local resources

`manifest.json` is the release contract. Application startup never follows a moving branch or a latest release. Generation and embedding use the official Qwen GGUF Q8_0 files. The version `qwen3-q8-b10809-v1` is also the vector-index identity; changing the embedding revision, pooling, normalization or query instruction requires re-embedding stored documents.

The three downloads total **2,484,699,804 bytes** (approximately 2.48 GB decimal). Keep at least **4 GB of free disk space** for installation, temporary files, unpacked runtime and initial database growth. This is a disk budget, not a measured RAM minimum. Downloads stage as `.part`, verify size and SHA-256, then rename atomically. A persisted failure requires the explicit model retry action. A single download lock protects shared caches.

Official metadata, checked 2026-09-10:

- [Qwen3-1.7B-GGUF pinned revision](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/tree/90862c4b9d2787eaed51d12237eafdfe7c5f6077)
- [Qwen3-Embedding-0.6B-GGUF pinned revision](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/tree/370f27d7550e0def9b39c1f16d3fbaa13aa67728)
- [llama.cpp b10809 release](https://github.com/ggml-org/llama.cpp/releases/tag/b10809), selected by the official v0.4.0 release's `nightly-tag.txt` at validation time.
- [Pinned llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/tools/server/README.md)

`licenses/` includes the Qwen Apache-2.0 license and llama.cpp MIT license. The extracted upstream runtime archive retains its bundled license files. There is no remote inference endpoint or conversation telemetry. Only the pinned resource URLs are used for model preparation; inference requests go to authenticated `127.0.0.1` processes.
