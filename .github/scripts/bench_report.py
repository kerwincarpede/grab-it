#!/usr/bin/env python3
"""Write the Benchmarks job summary: each bench's base and head times.

Reads the results `cargo bench` leaves under target/criterion/: a bench's
`base/` holds the PR base's numbers (`--save-baseline base`), its `new/`
the head's, and its `change/` the difference criterion measured
(`--baseline-lenient base`). Benches more than 10% slower are flagged and
raise a warning annotation. The report never fails the job.
"""

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# A bench this much slower than the base is flagged.
SLOWER = 0.10


@dataclass
class Result:
    name: str
    base: float | None  # mean nanoseconds per iteration
    head: float | None
    change: float | None  # head against base: 0.1 is 10% slower


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def mean(path):
    estimates = read_json(path)
    try:
        return float(estimates["mean"]["point_estimate"])
    except (KeyError, TypeError, ValueError):
        return None


def bench_name(bench_dir, root):
    for run in ("new", "base"):
        info = read_json(bench_dir / run / "benchmark.json")
        if isinstance(info, dict) and info.get("full_id"):
            return info["full_id"]
    return bench_dir.relative_to(root).as_posix()


def criterion_results(root):
    """Every bench under `root` (target/criterion), sorted by name."""
    root = Path(root)
    if not root.is_dir():
        return []
    bench_dirs = {
        path.parent.parent
        for run in ("new", "base")
        for path in root.glob(f"**/{run}/estimates.json")
    }
    results = []
    for bench_dir in bench_dirs:
        base = mean(bench_dir / "base" / "estimates.json")
        head = mean(bench_dir / "new" / "estimates.json")
        change = None
        if base is not None and head is not None:
            change = mean(bench_dir / "change" / "estimates.json")
            if change is None and base > 0:
                change = head / base - 1
        results.append(Result(bench_name(bench_dir, root), base, head, change))
    return sorted(results, key=lambda result: result.name)


def duration(nanoseconds):
    if nanoseconds is None:
        return "–"
    for unit, size in (("s", 1e9), ("ms", 1e6), ("µs", 1e3)):
        if nanoseconds >= size:
            return f"{nanoseconds / size:.3g} {unit}"
    return f"{nanoseconds:.3g} ns"


def is_slower(result):
    return result.change is not None and result.change > SLOWER


def render(results, has_base):
    """The summary's Markdown, and a warning line for each slower bench."""
    lines = ["## Benchmarks", ""]
    if not results:
        lines.append("No benchmark results were found.")
        return "\n".join(lines) + "\n", []
    if not has_base:
        lines += ["The base has no benches, so only this PR's numbers are shown.", ""]
    lines += [
        "| Benchmark | Base | Head | Change | |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    warnings = []
    for result in results:
        change = "–" if result.change is None else f"{result.change:+.1%}"
        if result.head is None:
            note = "Removed"
        elif result.base is None and has_base:
            note = "New"
        elif is_slower(result):
            note = "**Slower**"
            warnings.append(
                f"::warning title=Benchmark slower::{result.name} is "
                f"{result.change:.1%} slower than the base "
                f"({duration(result.base)} to {duration(result.head)})"
            )
        else:
            note = ""
        lines.append(
            f"| `{result.name}` | {duration(result.base)} | "
            f"{duration(result.head)} | {change} | {note} |"
        )
    slower = len(warnings)
    lines += [
        "",
        f"{slower} of {len(results)} benches are over {SLOWER:.0%} slower than the base."
        if has_base
        else f"{len(results)} benches ran.",
        "Times are the mean per iteration on a shared runner, so a few percent either way is noise.",
    ]
    return "\n".join(lines) + "\n", warnings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("criterion", help="the target/criterion folder")
    parser.add_argument(
        "--no-base",
        action="store_true",
        help="the PR base has no benches; report the head alone",
    )
    parser.add_argument(
        "--summary",
        default=os.environ.get("GITHUB_STEP_SUMMARY"),
        help="file the Markdown is appended to (default: $GITHUB_STEP_SUMMARY, else stdout)",
    )
    args = parser.parse_args(argv)
    try:
        markdown, warnings = render(criterion_results(args.criterion), not args.no_base)
        if args.summary:
            with open(args.summary, "a", encoding="utf-8") as summary:
                summary.write(markdown)
        else:
            sys.stdout.write(markdown)
        for warning in warnings:
            print(warning)
    except Exception as err:  # A broken report must not fail the job.
        print(f"::warning title=Benchmark report::Could not write the report: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
