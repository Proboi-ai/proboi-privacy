#!/usr/bin/env python3
"""
Recall/precision/F1 validator for the Natasha NER sidecar (natasha_sidecar.py).

WHAT THIS MEASURES
    The sidecar exists to catch Russian personal names (PER) and organization
    names (ORG) in free-text reports so they can be masked before the text
    leaves the system. This script feeds a set of labeled example sentences
    through the sidecar's own detection function, compares what it found
    against a hand-labeled "gold" answer key, and reports how many entities
    it caught, missed, and invented.

    It intentionally reuses the sidecar's own `_deid()` function (imported
    from natasha_sidecar.py in this same directory) rather than
    re-implementing any NER logic — this script only scores, it never guesses.

WHY RECALL IS THE HEADLINE NUMBER
    For a privacy/de-identification tool, a missed entity (false negative) is
    a leak: a real name or organization goes out un-masked. A false positive
    (over-masking a word that was not actually a name) is merely an
    inconvenience — it makes the text slightly less readable, nothing more.
    So recall is treated as the primary metric; precision and F1 are reported
    for completeness but recall regressions are the ones that should block
    a release.

USAGE
    python3 validate_recall.py [--fixture PATH] [--json PATH] [--types PER,ORG]

    Exit code 0  = ran successfully (prints the metrics table regardless of
                   how good/bad the numbers are — a low score is not a script
                   failure, it is exactly the information this tool exists to
                   surface).
    Exit code 1  = could not run at all (natasha not installed, sidecar
                   import failed, fixture missing/malformed). A clear message
                   is printed; no raw Python traceback is shown to the user.

See VALIDATION.md in this directory for the full methodology, the limits of
the bundled synthetic fixture, and how to run this against real (properly
authorized, offline) client reports on a test stand.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_FIXTURE = HERE / "fixtures" / "geo_report_sample.jsonl"
DEFAULT_TYPES = ["PER", "ORG"]


class ValidatorError(RuntimeError):
    """Raised for any condition that should stop the run with a clean message
    (as opposed to a raw traceback) and a non-zero exit code."""


# --------------------------------------------------------------------------
# Loading the sidecar's detection function
# --------------------------------------------------------------------------


def _load_sidecar_deid(engine: str = "natasha", vertical: str = "common"):
    """Imports `_deid` from natasha_sidecar.py in this directory.

    Returns the function itself — this script never re-implements NER, it
    only calls into the sidecar and scores what comes back.
    """
    sidecar_path = HERE / "natasha_sidecar.py"
    if not sidecar_path.exists():
        raise ValidatorError(f"sidecar module not found: {sidecar_path}")

    spec = importlib.util.spec_from_file_location("natasha_sidecar", sidecar_path)
    if spec is None or spec.loader is None:
        raise ValidatorError(f"could not load sidecar module spec from {sidecar_path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:  # noqa: BLE001 — import-time failure, e.g. natasha missing
        raise ValidatorError(
            "natasha not installed — run `pip install -r requirements.txt` on the stand\n"
            f"(import of natasha_sidecar.py failed: {e})"
        ) from e

    if engine == "gliner":
        gliner = getattr(module, "_deid_gliner", None)
        if gliner is None:
            raise ValidatorError("natasha_sidecar.py has no `_deid_gliner` function")
        return lambda text, _types: gliner(text, vertical)
    deid = getattr(module, "_deid", None)
    if deid is None:
        raise ValidatorError("natasha_sidecar.py has no `_deid` function — sidecar API changed?")
    return deid


def _predict(deid, text: str, types: list[str]) -> list[dict[str, Any]]:
    """Runs the sidecar's `_deid` and normalizes its output to
    (type, start, end, raw) tuples comparable with gold spans.

    `_deid` returns [{"type", "raw", "index", "confidence"}] — "index" is a
    character start offset and "raw" is the exact matched substring, so
    end = index + len(raw) (same convention as ../deid/detect.ts).
    """
    try:
        entities = deid(text, types)
    except Exception as e:  # noqa: BLE001 — e.g. natasha models not loaded
        raise ValidatorError(
            "natasha not installed — run `pip install -r requirements.txt` on the stand\n"
            f"(_deid() raised: {e})"
        ) from e

    out = []
    for ent in entities:
        start = ent["index"]
        raw = ent["raw"]
        out.append(
            {
                "type": ent["type"],
                "start": start,
                "end": start + len(raw),
                "raw": raw,
            }
        )
    return out


# --------------------------------------------------------------------------
# Fixture loading
# --------------------------------------------------------------------------


def _load_fixture(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise ValidatorError(f"fixture file not found: {path}")
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValidatorError(f"{path}:{lineno}: invalid JSON ({e})") from e
            if "text" not in obj or "spans" not in obj:
                raise ValidatorError(f"{path}:{lineno}: missing required 'text' or 'spans' field")
            text = obj["text"]
            for span in obj["spans"]:
                for key in ("type", "start", "end", "raw"):
                    if key not in span:
                        raise ValidatorError(f"{path}:{lineno}: span missing '{key}': {span}")
                got = text[span["start"] : span["end"]]
                if got != span["raw"]:
                    raise ValidatorError(
                        f"{path}:{lineno}: offset/raw mismatch — "
                        f"text[{span['start']}:{span['end']}]={got!r} but raw={span['raw']!r}"
                    )
            rows.append(obj)
    if not rows:
        raise ValidatorError(f"fixture file has no usable rows: {path}")
    return rows


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def _spans_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a["type"] == b["type"] and a["start"] < b["end"] and b["start"] < a["end"]


def _exact_key(span: dict[str, Any]) -> tuple:
    return (span["type"], span["start"], span["end"])


class TypeStats:
    """Accumulates exact-match and overlap-match counts for one entity type
    (or "OVERALL" across all types)."""

    def __init__(self) -> None:
        self.tp_exact = 0
        self.fp_exact = 0
        self.fn_exact = 0
        self.tp_overlap = 0
        self.fp_overlap = 0
        self.fn_overlap = 0

    def precision_exact(self) -> float:
        return _safe_div(self.tp_exact, self.tp_exact + self.fp_exact)

    def recall_exact(self) -> float:
        return _safe_div(self.tp_exact, self.tp_exact + self.fn_exact)

    def f1_exact(self) -> float:
        return _f1(self.precision_exact(), self.recall_exact())

    def precision_overlap(self) -> float:
        return _safe_div(self.tp_overlap, self.tp_overlap + self.fp_overlap)

    def recall_overlap(self) -> float:
        return _safe_div(self.tp_overlap, self.tp_overlap + self.fn_overlap)

    def f1_overlap(self) -> float:
        return _f1(self.precision_overlap(), self.recall_overlap())

    def as_dict(self) -> dict[str, Any]:
        return {
            "exact": {
                "tp": self.tp_exact,
                "fp": self.fp_exact,
                "fn": self.fn_exact,
                "precision": round(self.precision_exact(), 4),
                "recall": round(self.recall_exact(), 4),
                "f1": round(self.f1_exact(), 4),
            },
            "overlap": {
                "tp": self.tp_overlap,
                "fp": self.fp_overlap,
                "fn": self.fn_overlap,
                "precision": round(self.precision_overlap(), 4),
                "recall": round(self.recall_overlap(), 4),
                "f1": round(self.f1_overlap(), 4),
            },
        }


def _safe_div(n: float, d: float) -> float:
    return n / d if d else 0.0


def _f1(p: float, r: float) -> float:
    return _safe_div(2 * p * r, p + r)


def score(
    fixture_rows: list[dict[str, Any]], deid, types: list[str]
) -> tuple[dict[str, TypeStats], list[dict[str, Any]]]:
    """Runs predictions for every row and accumulates per-type + overall stats.

    Returns (stats_by_type, per_row_details) where stats_by_type always has
    an "OVERALL" key plus one key per entity type seen in gold or predicted.
    per_row_details is a list of dicts describing what was missed/invented
    per row, useful for spot-checking a run.
    """
    stats: dict[str, TypeStats] = {"OVERALL": TypeStats()}
    details = []

    for row in fixture_rows:
        text = row["text"]
        gold = [s for s in row["spans"] if s["type"] in types]
        pred = _predict(deid, text, types)

        for s in gold + pred:
            stats.setdefault(s["type"], TypeStats())

        # --- exact match: bipartite match on (type, start, end) ---
        gold_remaining = list(gold)
        pred_remaining = list(pred)
        matched_gold_idx: set[int] = set()
        matched_pred_idx: set[int] = set()
        for gi, g in enumerate(gold_remaining):
            for pi, p in enumerate(pred_remaining):
                if pi in matched_pred_idx:
                    continue
                if _exact_key(g) == _exact_key(p):
                    matched_gold_idx.add(gi)
                    matched_pred_idx.add(pi)
                    break

        tp_exact_rows = [gold_remaining[i] for i in matched_gold_idx]
        fn_exact_rows = [g for i, g in enumerate(gold_remaining) if i not in matched_gold_idx]
        fp_exact_rows = [p for i, p in enumerate(pred_remaining) if i not in matched_pred_idx]

        for g in tp_exact_rows:
            stats[g["type"]].tp_exact += 1
            stats["OVERALL"].tp_exact += 1
        for g in fn_exact_rows:
            stats[g["type"]].fn_exact += 1
            stats["OVERALL"].fn_exact += 1
        for p in fp_exact_rows:
            stats[p["type"]].fp_exact += 1
            stats["OVERALL"].fp_exact += 1

        # --- lenient match: any character-span overlap of the same type ---
        matched_gold_idx_ov: set[int] = set()
        matched_pred_idx_ov: set[int] = set()
        for gi, g in enumerate(gold):
            for pi, p in enumerate(pred):
                if pi in matched_pred_idx_ov:
                    continue
                if _spans_overlap(g, p):
                    matched_gold_idx_ov.add(gi)
                    matched_pred_idx_ov.add(pi)
                    break

        tp_ov_rows = [gold[i] for i in matched_gold_idx_ov]
        fn_ov_rows = [g for i, g in enumerate(gold) if i not in matched_gold_idx_ov]
        fp_ov_rows = [p for i, p in enumerate(pred) if i not in matched_pred_idx_ov]

        for g in tp_ov_rows:
            stats[g["type"]].tp_overlap += 1
            stats["OVERALL"].tp_overlap += 1
        for g in fn_ov_rows:
            stats[g["type"]].fn_overlap += 1
            stats["OVERALL"].fn_overlap += 1
        for p in fp_ov_rows:
            stats[p["type"]].fp_overlap += 1
            stats["OVERALL"].fp_overlap += 1

        if fn_exact_rows or fp_exact_rows:
            details.append(
                {
                    "text": text,
                    "missed": fn_exact_rows,
                    "invented": fp_exact_rows,
                }
            )

    return stats, details


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def _print_table(stats: dict[str, TypeStats]) -> None:
    order = [t for t in DEFAULT_TYPES if t in stats] + sorted(
        t for t in stats if t not in DEFAULT_TYPES and t != "OVERALL"
    )
    order.append("OVERALL")

    header = f"{'type':<10} {'metric':<8} {'TP':>4} {'FP':>4} {'FN':>4} {'P':>7} {'R':>7} {'F1':>7}"
    sep = "-" * len(header)
    print(sep)
    print(header)
    print(sep)
    for etype in order:
        s = stats[etype]
        print(
            f"{etype:<10} {'exact':<8} {s.tp_exact:>4} {s.fp_exact:>4} {s.fn_exact:>4} "
            f"{s.precision_exact():>7.3f} {s.recall_exact():>7.3f} {s.f1_exact():>7.3f}"
        )
        print(
            f"{'':<10} {'overlap':<8} {s.tp_overlap:>4} {s.fp_overlap:>4} {s.fn_overlap:>4} "
            f"{s.precision_overlap():>7.3f} {s.recall_overlap():>7.3f} {s.f1_overlap():>7.3f}"
        )
    print(sep)
    print(
        "exact   = span must match gold on (type, start, end) exactly.\n"
        "overlap = lenient secondary metric — same type and at least one\n"
        "          overlapping character; absorbs boundary/quote/legal-form\n"
        "          convention differences (see VALIDATION.md)."
    )


def _print_details(details: list[dict[str, Any]], limit: int = 20) -> None:
    if not details:
        return
    print()
    print(f"Rows with exact-match misses or extra detections (showing up to {limit}):")
    for d in details[:limit]:
        print(f"  text: {d['text']!r}")
        for m in d["missed"]:
            print(f"    MISSED   {m['type']:<4} {m['raw']!r} @[{m['start']}:{m['end']}]")
        for e in d["invented"]:
            print(f"    INVENTED {e['type']:<4} {e['raw']!r} @[{e['start']}:{e['end']}]")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Measure precision/recall/F1 of the Natasha sidecar's PER/ORG detection "
            "against a labeled fixture. See VALIDATION.md for methodology."
        )
    )
    parser.add_argument(
        "--engine",
        choices=["natasha", "gliner"],
        default="natasha",
        help="sidecar NER engine to evaluate",
    )
    parser.add_argument(
        "--vertical",
        default="common",
        help="labels vertical for GLiNER",
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=DEFAULT_FIXTURE,
        help=f"path to a labeled JSONL fixture (default: {DEFAULT_FIXTURE.relative_to(HERE)})",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="also write a machine-readable JSON summary to this path",
    )
    parser.add_argument(
        "--types",
        type=str,
        default=",".join(DEFAULT_TYPES),
        help=f"comma-separated entity types to evaluate (default: {','.join(DEFAULT_TYPES)})",
    )
    parser.add_argument(
        "--show-misses",
        action="store_true",
        help="print per-row detail for every miss/false-positive (exact match)",
    )
    args = parser.parse_args(argv)

    types = [t.strip().upper() for t in args.types.split(",") if t.strip()]

    try:
        deid = _load_sidecar_deid(args.engine, args.vertical)
        fixture_rows = _load_fixture(args.fixture)
        stats, details = score(fixture_rows, deid, types)
    except ValidatorError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print(f"Fixture: {args.fixture}")
    print(f"Rows evaluated: {len(fixture_rows)}")
    print(f"Types evaluated: {', '.join(types)}")
    print()
    _print_table(stats)
    if args.show_misses:
        _print_details(details)

    summary = {
        "fixture": str(args.fixture),
        "engine": args.engine,
        "rows_evaluated": len(fixture_rows),
        "types_evaluated": types,
        "stats": {etype: s.as_dict() for etype, s in stats.items()},
    }
    if args.json:
        args.json.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nJSON summary written to {args.json}")
    else:
        print("\nJSON summary:")
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
