"""QLoRA fine-tune of a small open instruct model on your own approved messages.

Runs locally on your NVIDIA GPU (8 GB VRAM is enough for a 3B model, ~12 GB for 7B).
Uses Unsloth when installed (faster, less VRAM), otherwise plain PEFT + bitsandbytes.

Output (all in models/, never committed):
  models/orivenai-writer-lora/      LoRA adapter (your weights)
  models/orivenai-writer-merged/    merged fp16 model
  models/orivenai-writer.gguf       quantized (Q4_K_M) for Ollama / llama.cpp
and registers the model in Ollama as `orivenai-writer`.

Usage (from the project root, inside .venv-gpu):
  python finetune/train_qlora.py --data data/training/messages.jsonl
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"


def load_rows(path: Path) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    # Messages you edited carry the most signal about your voice: show them twice.
    return rows + [r for r in rows if r.get("edited")]


def train_unsloth(args, rows):
    from unsloth import FastLanguageModel
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer
    model, tok = FastLanguageModel.from_pretrained(args.base, max_seq_length=1024, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(model, r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05,
                                             target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                                                             "gate_proj", "up_proj", "down_proj"])
    ds = Dataset.from_list([{"text": tok.apply_chat_template(r["messages"], tokenize=False)} for r in rows])
    SFTTrainer(model=model, tokenizer=tok, train_dataset=ds, args=SFTConfig(
        output_dir=str(MODELS / "ckpt"), per_device_train_batch_size=2, gradient_accumulation_steps=4,
        num_train_epochs=args.epochs, learning_rate=args.lr, logging_steps=5, save_strategy="no",
        dataset_text_field="text", max_seq_length=1024, bf16=True, report_to=[])).train()
    model.save_pretrained(MODELS / "orivenai-writer-lora")
    tok.save_pretrained(MODELS / "orivenai-writer-lora")
    model.save_pretrained_gguf(str(MODELS / "orivenai-writer-gguf"), tok, quantization_method="q4_k_m")
    ggufs = sorted((MODELS / "orivenai-writer-gguf").glob("*.gguf"))
    shutil.copy(ggufs[-1], MODELS / "orivenai-writer.gguf")


def train_peft(args, rows):
    import torch
    from datasets import Dataset
    from peft import LoraConfig, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                             bnb_4bit_compute_dtype=torch.bfloat16)
    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base, quantization_config=bnb, device_map="auto")
    model = prepare_model_for_kbit_training(model)
    lora = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    ds = Dataset.from_list([{"messages": r["messages"]} for r in rows])
    trainer = SFTTrainer(model=model, processing_class=tok, train_dataset=ds, peft_config=lora, args=SFTConfig(
        output_dir=str(MODELS / "ckpt"), per_device_train_batch_size=2, gradient_accumulation_steps=4,
        num_train_epochs=args.epochs, learning_rate=args.lr, logging_steps=5, save_strategy="no",
        bf16=True, report_to=[]))
    trainer.train()
    trainer.model.save_pretrained(MODELS / "orivenai-writer-lora")
    tok.save_pretrained(MODELS / "orivenai-writer-lora")
    # Merge in fp16 and convert to GGUF with llama.cpp's converter.
    from peft import PeftModel
    base = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.float16, device_map="cpu")
    merged = PeftModel.from_pretrained(base, MODELS / "orivenai-writer-lora").merge_and_unload()
    merged.save_pretrained(MODELS / "orivenai-writer-merged")
    tok.save_pretrained(MODELS / "orivenai-writer-merged")
    llama = MODELS / "llama.cpp"
    if not llama.exists():
        subprocess.run(["git", "clone", "--depth", "1", "https://github.com/ggerganov/llama.cpp", str(llama)], check=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(llama / "requirements.txt")], check=True)
    f16 = MODELS / "orivenai-writer-f16.gguf"
    subprocess.run([sys.executable, str(llama / "convert_hf_to_gguf.py"), str(MODELS / "orivenai-writer-merged"),
                    "--outfile", str(f16), "--outtype", "f16"], check=True)
    # Ollama quantizes on import (see Modelfile / `ollama create -q`), so f16 is enough here.
    shutil.move(f16, MODELS / "orivenai-writer.gguf")


def register_ollama(quantize: bool):
    template = (MODELS / "Modelfile.template").read_text(encoding="utf-8")
    mf = MODELS / "Modelfile"
    mf.write_text(template.replace("{{GGUF}}", str(MODELS / "orivenai-writer.gguf")), encoding="utf-8")
    cmd = ["ollama", "create", "orivenai-writer", "-f", str(mf)]
    if quantize:
        cmd[3:3] = ["-q", "q4_K_M"]
    subprocess.run(cmd, check=True)
    print("Klaar: Ollama-model 'orivenai-writer' staat klaar en wordt automatisch gebruikt.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data" / "training" / "messages.jsonl"))
    ap.add_argument("--base", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    args = ap.parse_args()
    rows = load_rows(Path(args.data))
    print(f"{len(rows)} trainingsvoorbeelden, basismodel {args.base}")
    try:
        import unsloth  # noqa: F401
        train_unsloth(args, rows)
        register_ollama(quantize=False)
    except ImportError:
        train_peft(args, rows)
        register_ollama(quantize=True)


if __name__ == "__main__":
    main()
