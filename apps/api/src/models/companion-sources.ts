/** Publisher model metadata from official workflow library 0.11.55 fixtures,
 * plus the original LTX companions documented in docs/LTX_COMPANIONS.md.
 * Hashes absent here must be resolved from publisher metadata before install. */
import type { WorkflowFile } from "../library/workflows/manifest.js";
export const COMPANION_SOURCES: WorkflowFile[] = [
  {
    "name": "clip_l.safetensors",
    "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors?download=true",
    "directory": "text_encoders",
    "paths": []
  },
  {
    "name": "llava_llama3_fp8_scaled.safetensors",
    "url": "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors?download=true",
    "directory": "text_encoders",
    "paths": []
  },
  {
    "name": "hunyuan_video_t2v_720p_bf16.safetensors",
    "url": "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/diffusion_models/hunyuan_video_t2v_720p_bf16.safetensors?download=true",
    "directory": "diffusion_models",
    "paths": []
  },
  {
    "name": "hunyuan_video_vae_bf16.safetensors",
    "url": "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/vae/hunyuan_video_vae_bf16.safetensors?download=true",
    "directory": "vae",
    "paths": []
  },
  {
    "name": "wan2.2_ti2v_5B_fp16.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
    "directory": "diffusion_models",
    "paths": []
  },
  {
    "name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "directory": "text_encoders",
    "paths": []
  },
  {
    "name": "wan2.2_vae.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors",
    "directory": "vae",
    "paths": []
  },
  {
    "name": "wan_2.1_vae.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors",
    "directory": "vae",
    "paths": []
  },
  {
    "name": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    "directory": "diffusion_models",
    "paths": []
  },
  {
    "name": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    "directory": "diffusion_models",
    "paths": []
  },
  {
    "name": "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
    "directory": "loras",
    "paths": []
  },
  {
    "name": "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    "directory": "loras",
    "paths": []
  },
  {
    "name": "t5xxl_fp16.safetensors",
    "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors",
    "directory": "text_encoders",
    "paths": []
  },
  {
    "name": "ltx-video-2b-v0.9.5.safetensors",
    "url": "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors",
    "directory": "checkpoints",
    "paths": []
  },
  {
    "name": "sd_xl_base_1.0.safetensors",
    "url": "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors?download=true",
    "directory": "checkpoints",
    "paths": []
  },
  {
    "name": "t5xxl_fp8_e4m3fn.safetensors",
    "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
    "directory": "text_encoders",
    "paths": [],
    "sha256": "7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09",
    "sizeBytes": 4893934904
  },
  {
    "name": "ltx-video-2b-v0.9.1.safetensors",
    "url": "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.1.safetensors",
    "directory": "vae",
    "paths": [],
    "sha256": "a23200896c5eddf215c7cb9517820c5763a2b054eb62ba86cbce6b871a4577e3",
    "sizeBytes": 5716863844
  }
];
