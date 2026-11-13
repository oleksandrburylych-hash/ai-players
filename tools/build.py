#!/usr/bin/env python3
"""Собрать dist/ai-players.zip — архив, который Foundry скачивает при установке по ссылке.

В архив попадают только файлы, нужные Foundry (module.json, scripts, lang, styles, README.md),
и лежат они в корне архива. Запуск: python3 tools/build.py (из папки модуля или откуда угодно).
"""
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCLUDE = ["module.json", "README.md", "scripts", "lang", "styles"]
OUT = ROOT / "dist" / "ai-players.zip"

manifest = json.loads((ROOT / "module.json").read_text(encoding="utf-8"))
OUT.parent.mkdir(exist_ok=True)
files = []
for name in INCLUDE:
    p = ROOT / name
    files += sorted(f for f in p.rglob("*") if f.is_file()) if p.is_dir() else [p]

# Фиксированная дата — одинаковые файлы дают одинаковый архив.
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        info = zipfile.ZipInfo(str(f.relative_to(ROOT)), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, f.read_bytes())

print(f"{OUT.relative_to(ROOT)}: версия {manifest['version']}, файлов {len(files)}, {OUT.stat().st_size // 1024} КБ")
