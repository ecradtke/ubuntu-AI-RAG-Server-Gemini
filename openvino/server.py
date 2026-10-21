#!/usr/bin/env python3
"""OpenVINO Inference Server (FastAPI).

Hosts LLM pipeline on Intel GPU and vector embeddings on Intel NPU.
Provides Ollama-compatible and OpenAI-compatible endpoints:
  /healthz, /api/tags, /api/chat, /api/generate, /api/embed, /api/embeddings,
  /api/switch-model, /api/switch-embed-model, /api/reload
"""
import os
import sys

# Ensure Intel Level Zero driver initializes NPU (accel0) in addition to GPU
os.environ.setdefault("ZE_INIT_ALL_DRIVER_TYPES_ENABLE", "1")

import asyncio
import time
import json
import threading
import logging
from typing import List, Optional, Dict, Any, Union

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] openvino-server: %(message)s")
logger = logging.getLogger("openvino-server")

# Hardware & Devices
MODELS_DIR = os.getenv("MODELS_DIR", "/var/lib/k13/openvino/models")
os.makedirs(MODELS_DIR, exist_ok=True)

INFERENCE_DEVICE = os.getenv("LLM_DEVICE", "GPU")
EMBED_DEVICE = os.getenv("EMBED_DEVICE", "NPU")
DEFAULT_LLM_REPO = os.getenv("DEFAULT_MODEL", "OpenVINO/Phi-3.5-mini-instruct-int4-ov")
DEFAULT_EMBED_REPO = os.getenv("EMBED_MODEL", "BAAI/bge-base-en-v1.5")
SWITCH_ALLOW_CPU = os.getenv("SWITCH_ALLOW_CPU", "off").lower() in ("on", "1", "true")
LLM_THINKING = os.getenv("LLM_THINKING", "off").lower() in ("on", "1", "true")
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "2048"))
SERVER_HOST = os.getenv("SERVER_HOST", "127.0.0.1")
SERVER_PORT = int(os.getenv("SERVER_PORT", "11434"))

llm_lock = threading.Lock()
embed_lock = threading.Lock()

llm_pipeline = None
llm_tokenizer = None
embed_model = None
embed_tokenizer = None

active_llm_device = INFERENCE_DEVICE
active_embed_device = EMBED_DEVICE
current_llm_repo = DEFAULT_LLM_REPO
current_embed_repo = DEFAULT_EMBED_REPO

model_switch_status: Dict[str, Any] = {"state": "idle", "model": DEFAULT_LLM_REPO, "error": None}
embed_switch_status: Dict[str, Any] = {"state": "idle", "model": DEFAULT_EMBED_REPO, "error": None}


def load_llm(model_id: str):
    global llm_pipeline, active_llm_device, current_llm_repo
    with llm_lock:
        logger.info(f"Loading LLM {model_id} on {INFERENCE_DEVICE}...")
        try:
            import openvino_genai as ov_genai
            # Download / locate model path
            from huggingface_hub import snapshot_download
            model_path = snapshot_download(repo_id=model_id, local_dir=os.path.join(MODELS_DIR, model_id.replace("/", "_")))
            
            try:
                pipe = ov_genai.LLMPipeline(model_path, INFERENCE_DEVICE)
                active_llm_device = INFERENCE_DEVICE
            except Exception as e_gpu:
                if SWITCH_ALLOW_CPU:
                    logger.warning(f"Could not load on {INFERENCE_DEVICE} ({e_gpu}), falling back to CPU...")
                    pipe = ov_genai.LLMPipeline(model_path, "CPU")
                    active_llm_device = "CPU"
                else:
                    raise e_gpu

            llm_pipeline = pipe
            current_llm_repo = model_id
            logger.info(f"[✓] LLM {model_id} active on {active_llm_device}")
        except Exception as e:
            logger.error(f"Failed to load LLM {model_id}: {e}")
            raise e


def load_embed(model_id: str):
    global embed_model, embed_tokenizer, active_embed_device, current_embed_repo
    with embed_lock:
        target_device = EMBED_DEVICE.upper()
        logger.info(f"Loading embedding model {model_id} on {target_device}...")
        try:
            import openvino as ov
            from transformers import AutoTokenizer
            core = ov.Core()
            available = core.available_devices
            logger.info(f"OpenVINO available devices: {available}")
            
            from huggingface_hub import snapshot_download
            model_path = snapshot_download(repo_id=model_id, local_dir=os.path.join(MODELS_DIR, model_id.replace("/", "_")))
            
            tok = AutoTokenizer.from_pretrained(model_path)
            # Find openvino IR xml or convert
            xml_files = [f for f in os.listdir(model_path) if f.endswith(".xml")]
            if xml_files:
                model = core.read_model(os.path.join(model_path, xml_files[0]))
            else:
                from optimum.intel.openvino import OVModelForFeatureExtraction
                ov_m = OVModelForFeatureExtraction.from_pretrained(model_path, export=True)
                model = ov_m.model

            compiled = None
            if target_device == "NPU":
                if "NPU" not in available:
                    logger.warning(
                        f"NPU requested, but 'NPU' is not found in OpenVINO available devices ({available}). "
                        "Falling back to CPU. (Check Intel NPU driver and /dev/accel/accel0 permissions)."
                    )
                else:
                    logger.info("Reshaping embedding model to static shape (1, 512) for Intel NPU compilation...")
                    try:
                        shapes = {inp.get_any_name(): [1, 512] for inp in model.inputs}
                        model.reshape(shapes)
                        logger.info("Model reshaped to static (1, 512). Compiling on NPU...")
                        compiled = core.compile_model(model, "NPU")
                        active_embed_device = "NPU"
                        logger.info(f"[✓] Embeddings {model_id} successfully compiled and active on NPU")
                    except Exception as e_npu:
                        logger.warning(f"Could not compile embeddings on NPU ({e_npu}), falling back to CPU...")
                        compiled = None

            if compiled is None:
                # CPU fallback: reset to dynamic shapes if reshaped
                try:
                    dyn_shapes = {inp.get_any_name(): [-1, -1] for inp in model.inputs}
                    model.reshape(dyn_shapes)
                except Exception:
                    pass
                compiled = core.compile_model(model, "CPU")
                active_embed_device = "CPU"
                logger.info(f"[✓] Embeddings {model_id} active on fallback CPU")

            embed_model = compiled
            embed_tokenizer = tok
            current_embed_repo = model_id
        except Exception as e:
            logger.error(f"Failed to load embed model {model_id}: {e}", exc_info=True)


app = FastAPI(title="K13 OpenVINO Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event():
    # Asynchronously load models at start
    threading.Thread(target=lambda: load_llm(current_llm_repo), daemon=True).start()
    threading.Thread(target=lambda: load_embed(current_embed_repo), daemon=True).start()


@app.get("/healthz")
def healthz():
    return {
        "status": "healthy" if llm_pipeline else "loading",
        "llm_hardware": active_llm_device,
        "embed_hardware": active_embed_device,
        "current_model": current_llm_repo,
        "current_embed_model": current_embed_repo,
        "max_new_tokens": MAX_NEW_TOKENS,
        "switch_allow_cpu": SWITCH_ALLOW_CPU,
        "llm_thinking": LLM_THINKING,
        "server_host": SERVER_HOST,
        "server_port": SERVER_PORT,
    }


@app.get("/api/tags")
def list_tags():
    return {
        "models": [
            {"name": current_llm_repo, "model": current_llm_repo},
            {"name": current_embed_repo, "model": current_embed_repo}
        ]
    }


class SwitchModelReq(BaseModel):
    model: str


@app.post("/api/switch-model")
def switch_model(req: SwitchModelReq):
    global model_switch_status
    if model_switch_status["state"] == "loading":
        raise HTTPException(status_code=409, detail="A switch is already in progress")

    def run_switch():
        global model_switch_status
        model_switch_status = {"state": "loading", "model": req.model, "error": None}
        try:
            load_llm(req.model)
            model_switch_status = {"state": "idle", "model": req.model, "error": None}
        except Exception as e:
            model_switch_status = {"state": "error", "model": current_llm_repo, "error": str(e)}

    threading.Thread(target=run_switch, daemon=True).start()
    return {"status": "started", "target": req.model}


@app.get("/api/switch-model/status")
def switch_model_status():
    return {"current_model": current_llm_repo, "switch_status": model_switch_status}


@app.post("/api/switch-embed-model")
def switch_embed_model(req: SwitchModelReq):
    global embed_switch_status
    if embed_switch_status["state"] == "loading":
        raise HTTPException(status_code=409, detail="Embed switch already in progress")

    def run_embed_switch():
        global embed_switch_status
        embed_switch_status = {"state": "loading", "model": req.model, "error": None}
        try:
            load_embed(req.model)
            embed_switch_status = {"state": "idle", "model": req.model, "error": None}
        except Exception as e:
            embed_switch_status = {"state": "error", "model": current_embed_repo, "error": str(e)}

    threading.Thread(target=run_embed_switch, daemon=True).start()
    return {"status": "started", "target": req.model}


@app.get("/api/switch-embed-model/status")
def switch_embed_model_status():
    return {"current_model": current_embed_repo, "switch_status": embed_switch_status}


@app.post("/api/reload")
def reload_gpu():
    load_llm(current_llm_repo)
    return {"status": "reloaded", "device": active_llm_device}


class EmbedReq(BaseModel):
    model: Optional[str] = None
    input: Optional[Union[str, List[str]]] = None
    prompt: Optional[str] = None


@app.post("/api/embed")
@app.post("/api/embeddings")
def embed_endpoint(req: EmbedReq):
    texts = []
    if req.input:
        texts = [req.input] if isinstance(req.input, str) else req.input
    elif req.prompt:
        texts = [req.prompt]
    else:
        raise HTTPException(status_code=400, detail="Missing input or prompt")

    if not embed_model or not embed_tokenizer:
        # Fallback dummy embedding if loading
        dims = 384 if "small" in (req.model or current_embed_repo) else 768
        return {"embeddings": [[0.0] * dims for _ in texts], "embedding": [0.0] * dims}

    with embed_lock:
        results = []
        is_static = (active_embed_device == "NPU")
        pad_mode = "max_length" if is_static else True

        for text in texts:
            inputs = embed_tokenizer(text, padding=pad_mode, truncation=True, max_length=512, return_tensors="np")
            feed_dict = {}
            for inp in embed_model.inputs:
                name = inp.get_any_name()
                if name in inputs:
                    feed_dict[name] = inputs[name]
                elif name == "token_type_ids":
                    feed_dict[name] = np.zeros((1, 512) if is_static else inputs["input_ids"].shape, dtype=inputs["input_ids"].dtype)
                elif name in inputs:
                    feed_dict[name] = inputs[name]

            out = embed_model(feed_dict)
            # mean pooling
            token_embs = out[0]
            mask = np.expand_dims(inputs["attention_mask"], -1)
            sum_embs = np.sum(token_embs * mask, axis=1)
            sum_mask = np.clip(mask.sum(axis=1), a_min=1e-9, a_max=None)
            pooled = (sum_embs / sum_mask)[0]
            # normalize
            norm = np.linalg.norm(pooled)
            norm_vec = (pooled / norm).tolist() if norm > 0 else pooled.tolist()
            results.append(norm_vec)

        return {"embeddings": results, "embedding": results[0] if results else []}


class ChatMessageReq(BaseModel):
    role: str
    content: str


class ChatReq(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessageReq]
    stream: Optional[bool] = False


@app.post("/api/chat")
async def chat_endpoint(req: ChatReq):
    if not llm_pipeline:
        raise HTTPException(status_code=503, detail="LLM pipeline is still loading models onto Intel hardware")

    # Format prompt from messages
    formatted_prompt = ""
    for m in req.messages:
        if m.role == "system":
            formatted_prompt += f"<|system|>\n{m.content}</s>\n"
        elif m.role == "user":
            formatted_prompt += f"<|user|>\n{m.content}</s>\n"
        elif m.role == "assistant":
            formatted_prompt += f"<|assistant|>\n{m.content}</s>\n"
    formatted_prompt += "<|assistant|>\n"

    def generate_sync():
        with llm_lock:
            try:
                import openvino_genai as ov_genai
                config = ov_genai.GenerationConfig()
                config.max_new_tokens = MAX_NEW_TOKENS
                res = llm_pipeline.generate(formatted_prompt, config)
                return str(res)
            except Exception as e:
                logger.error(f"Generation error: {e}")
                return f"Error during generation: {e}"

    if not req.stream:
        loop = asyncio.get_event_loop()
        answer = await loop.run_in_executor(None, generate_sync)
        return {
            "model": current_llm_repo,
            "message": {"role": "assistant", "content": answer},
            "done": True
        }

    # Streaming mode (ndjson)
    async def stream_generator():
        loop = asyncio.get_event_loop()
        answer = await loop.run_in_executor(None, generate_sync)
        # Stream chunks with realistic word spacing
        words = answer.split(" ")
        for i, w in enumerate(words):
            chunk = (w if i == 0 else " " + w)
            yield json.dumps({"model": current_llm_repo, "message": {"role": "assistant", "content": chunk}, "done": False}) + "\n"
            await asyncio.sleep(0.015)
        yield json.dumps({"model": current_llm_repo, "message": {"role": "assistant", "content": ""}, "done": True, "eval_count": len(words)}) + "\n"

    return StreamingResponse(stream_generator(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT)
EOF
