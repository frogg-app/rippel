# LTX-Video 0.9.1 companions

The diffusion-model workflow needs these files. Metadata was retrieved from
the publishers' Hugging Face APIs on 2026-09-11; no weights were downloaded.

| Destination beneath `ComfyUI/models/` | Bytes | SHA-256 |
| --- | ---: | --- |
| `text_encoders/t5/t5xxl_fp8_e4m3fn.safetensors` | 4,893,934,904 | `7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09` |
| `vae/ltx-video-2b-v0.9.1.safetensors` | 5,716,863,844 | `a23200896c5eddf215c7cb9517820c5763a2b054eb62ba86cbce6b871a4577e3` |

- [FP8 T5 encoder](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors)
- [Original LTX 0.9.1 checkpoint containing its VAE](https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.1.safetensors)

The original checkpoint is deliberately used for the VAE: the existing workflow
documents that ComfyUI extracts the VAE weights from this format. The publisher's
Diffusers VAE has different packaging and has not been verified here. LTX-2/2.5
audio or video VAEs must not satisfy the 0.9.1 requirement. If an identical
checkpoint is already installed, verify its hash and copy it into `vae/` instead
of downloading it again; retain the diffusion-model copy.

The encoder destination matches ComfyUI-Manager's catalogue. Both Windows and
Unix subfolders are accepted. FP16 remains an accepted fallback when FP8 is not
installed. UMT5 is not a substitute for T5-XXL.

Live validation is pending: this workspace cannot reach `192.168.1.10:8188`.
