#!/usr/bin/env python3
"""为 Codex 的 MiMo 模型目录打 mimodex 所需的补丁。

背景
----
MiMo 的模型目录会**替换** Codex 内置目录，因此：

1. ``~/.codex/agents/*.toml`` 里用的 ``model = "gpt-5.6-luna"`` 之类名字在该目录里
   没有元数据，Codex 会退化为兜底元数据并告警。mimodex 的代理会把这些名字映射到
   ``mimo-*``，但 Codex 侧仍需要目录条目才能拿到正确的上下文窗口等元数据。
2. agent 配置里用了 ``max`` / ``xhigh`` 推理档位，而 MiMo 目录只声明到 ``high``。
   代理会在线上把高出的档位 clamp 到 ``high``，但目录必须先接受这些值。
3. 审查（guardian）默认会回退到会话主模型，用旗舰模型跑审查很浪费。把
   ``auto_review_model_override`` 指向便宜快的模型即可。

用法
----
    python3 tools/patch-catalog.py ~/.codex/model-catalog-mimo.json
    python3 tools/patch-catalog.py <catalog> --reviewer mimo-v2.6-flash
    python3 tools/patch-catalog.py <catalog> --dry-run

脚本是幂等的：重复执行不会产生重复条目。原文件会先备份为 ``<catalog>.bak.<时间戳>``。
"""
from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
import time
from pathlib import Path

# 别名 -> (克隆源, 展示名)。克隆源决定元数据（上下文窗口、模态、工具模式等）。
DEFAULT_ALIASES: dict[str, tuple[str, str]] = {
    "gpt-5.6-luna":  ("mimo-v2.6-flash", "GPT-5.6 Luna (MiMo v2.6 Flash)"),
    "gpt-5.6-terra": ("mimo-v2.6-flash", "GPT-5.6 Terra (MiMo v2.6 Flash)"),
    "gpt-5.6-sol":   ("mimo-v2.6-pro",   "GPT-5.6 Sol (MiMo v2.6 Pro)"),
    "gpt-6-astra":   ("mimo-v2.6-pro",   "GPT-6 Astra (MiMo v2.6 Pro)"),
}

EXTRA_LEVELS = [
    {"effort": "xhigh", "description": "Extra-high reasoning depth for the hardest problems"},
    {"effort": "max",   "description": "Maximum reasoning depth"},
]


def main() -> int:
    ap = argparse.ArgumentParser(description="为 MiMo 模型目录打 mimodex 补丁")
    ap.add_argument("catalog", type=Path, help="模型目录 JSON 路径")
    ap.add_argument("--reviewer", default="mimo-v2.6-flash",
                    help="auto_review_model_override 指向的模型（默认 mimo-v2.6-flash）")
    ap.add_argument("--no-aliases", action="store_true", help="不添加 gpt-* 别名条目")
    ap.add_argument("--dry-run", action="store_true", help="只报告将要做的事，不写文件")
    args = ap.parse_args()

    if not args.catalog.is_file():
        print(f"错误：找不到 {args.catalog}", file=sys.stderr)
        return 1

    try:
        doc = json.loads(args.catalog.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"错误：{args.catalog} 不是合法 JSON：{e}", file=sys.stderr)
        return 1

    models = doc.get("models")
    if not isinstance(models, list) or not models:
        print("错误：目录缺少非空的 models 数组", file=sys.stderr)
        return 1

    by_slug = {m.get("slug"): m for m in models if isinstance(m, dict)}
    report: list[str] = []

    # 1) 补推理档位 + 收敛审查模型
    for m in models:
        if not isinstance(m, dict):
            continue
        levels = m.setdefault("supported_reasoning_levels", [])
        have = {e.get("effort") for e in levels if isinstance(e, dict)}
        added = [e["effort"] for e in EXTRA_LEVELS if e["effort"] not in have]
        if added:
            levels.extend(copy.deepcopy(e) for e in EXTRA_LEVELS if e["effort"] not in have)
            report.append(f"  + {m.get('slug')}: 补推理档位 {', '.join(added)}")
        if m.get("auto_review_model_override") != args.reviewer:
            report.append(f"  ~ {m.get('slug')}: auto_review_model_override -> {args.reviewer}")
            m["auto_review_model_override"] = args.reviewer

    # 2) 补别名条目
    if not args.no_aliases:
        priority = 20
        for slug, (source, display) in DEFAULT_ALIASES.items():
            src = by_slug.get(source)
            if src is None:
                report.append(f"  ! 跳过别名 {slug}：找不到克隆源 {source}")
                continue
            entry = copy.deepcopy(src)
            entry.update({
                "slug": slug,
                "display_name": display,
                "description": f"Alias of {source} (routed through mimodex)",
                "priority": priority,
                "auto_review_model_override": args.reviewer,
            })
            priority += 1
            models[:] = [m for m in models if m.get("slug") != slug]  # 幂等
            models.append(entry)
            report.append(f"  + 别名 {slug} <- {source}")

    slugs = [m.get("slug") for m in models if isinstance(m, dict)]
    dupes = {s for s in slugs if slugs.count(s) > 1}
    if dupes:
        print(f"错误：slug 重复 {sorted(dupes)}", file=sys.stderr)
        return 1

    if not report:
        print("目录已是目标状态，无需改动。")
        return 0

    print(f"将对 {args.catalog} 做以下改动（共 {len(models)} 条）：")
    print("\n".join(report))

    if args.dry_run:
        print("\n--dry-run：未写文件。")
        return 0

    backup = args.catalog.with_suffix(args.catalog.suffix + f".bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(args.catalog, backup)
    args.catalog.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    # 写后校验
    check = json.loads(args.catalog.read_text(encoding="utf-8"))
    final = [m.get("slug") for m in check["models"]]
    assert len(final) == len(set(final)), "写入后 slug 重复"
    print(f"\n已写入。备份：{backup}")
    print(f"最终条目（{len(final)}）：{', '.join(final)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
