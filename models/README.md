# Pinned local resources

`manifest.json` is the release contract. Application startup never follows a moving branch or a latest release. Generation uses the official Qwen3-8B GGUF Q4_K_M file and embedding uses the official Qwen3-Embedding-0.6B GGUF Q8_0 file. The bundle version `qwen3-8b-q4km-b10809-v2` is separate from the vector-index identity `qwen3-embedding-0.6b-q8-370f27d7-last-l2-v1`; changing only the generation model does not re-embed stored documents. The previous bundle identity is listed as compatible because its embedding weights and semantics are unchanged.

The three downloads total **5,678,057,276 bytes** (approximately 5.68 GB decimal). Keep at least **10 GB of free disk space** for installation, interrupted download parts, the unpacked runtime and initial database growth. This is a disk budget, not a measured RAM minimum. Downloads stage as `.part`, verify size and SHA-256, then rename atomically. A persisted failure requires the explicit model retry action. A single download lock protects shared caches.

Official metadata, checked 2026-09-11:

- [Qwen3-8B-GGUF pinned revision](https://huggingface.co/Qwen/Qwen3-8B-GGUF/tree/7c41481f57cb95916b40956ab2f0b139b296d974)
- [Qwen3-Embedding-0.6B-GGUF pinned revision](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/tree/370f27d7550e0def9b39c1f16d3fbaa13aa67728)
- [llama.cpp b10809 release](https://github.com/ggml-org/llama.cpp/releases/tag/b10809), selected by the official v0.4.0 release's `nightly-tag.txt` at validation time.
- [Pinned llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/tools/server/README.md)

`licenses/` includes the Qwen Apache-2.0 license and llama.cpp MIT license. The extracted upstream runtime archive retains its bundled license files. There is no remote inference endpoint or conversation telemetry. Only the pinned resource URLs are used for model preparation; inference requests go to authenticated `127.0.0.1` processes.
