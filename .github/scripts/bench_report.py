#!/usr/bin/env python3
"""Write the Benchmarks job summary: each bench's base and head times.

Reports two suites, each in its own table:

- Rust: the results `cargo bench` leaves under target/criterion/. A
  bench's `base/` holds the PR base's numbers (`--save-baseline base`), its
  `new/` the head's, and its `change/` the difference criterion measured
  (`--baseline-lenient base`).
- Frontend: the JSON reports of `npm run bench` (vitest's `json` reporter)
  for the head and, when it ran, the base. The change is the ratio of their
  means.

Benches more than 10% slower are flagged and raise a warning annotation.
The report goes to stdout and to the job summary, and never fails the job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# A bench this much slower than the base is flagged.
SLOWER = 0.10


@dataclass
class Result:
    name: str
    base: Optional[float]  # mean nanoseconds per iteration
    head: Optional[float]
    change: Optional[float]  # head against base: 0.1 is 10% slower


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


def criterion_results(root, has_base=True):
    """Every bench under `root` (target/criterion), sorted by name. Without
    a base, any base/ and change/ folders are ignored: a plain `cargo bench`
    saves its own numbers to base/."""
    root = Path(root)
    runs = ("new", "base") if has_base else ("new",)
    if not root.is_dir():
        return []
    bench_dirs = {
        path.parent.parent
        for run in runs
        for path in root.glob(f"**/{run}/estimates.json")
    }
    results = []
    for bench_dir in bench_dirs:
        base = mean(bench_dir / "base" / "estimates.json") if has_base else None
        head = mean(bench_dir / "new" / "estimates.json")
        change = None
        if base is not None and head is not None:
            change = mean(bench_dir / "change" / "estimates.json")
            if change is None and base > 0:
                change = head / base - 1
        results.append(Result(bench_name(bench_dir, root), base, head, change))
    return sorted(results, key=lambda result: result.name)


def stored_criterion_results(head, baseline):
    """Join two independent Criterion runs by full benchmark ID, not directory name."""
    heads = {r.name: r.head for r in criterion_results(head, False)}
    bases = {r.name: r.head for r in criterion_results(baseline, False) if r.head is not None}
    return compare_means(heads, bases), bool(bases)


def vitest_means(path):
    """Each bench's mean nanoseconds per iteration in a vitest JSON report.

    A bench is named after its test and its own name, such as
    `overlay/geometry/drag 1000 moves`. None when the report is missing or
    cannot be read.
    """
    report = read_json(Path(path)) if path else None
    if not isinstance(report, dict):
        return None
    means = {}
    for module in report.get("testResults") or []:
        for test in module.get("assertionResults") or []:
            for benchmark in test.get("benchmarks") or []:
                for task in benchmark.get("tasks") or []:
                    # A row `bench.from()` read from a file was not timed in this run.
                    if task.get("fromStore"):
                        continue
                    try:
                        name = f"{benchmark['name']}/{task['name']}"
                        # vitest's latencies are in milliseconds.
                        means[name] = float(task["latency"]["mean"]) * 1e6
                    except (KeyError, TypeError, ValueError):
                        continue
    return means


def vitest_results(head, base=None):
    """The head's and base's frontend benches, sorted by name, and whether the base ran."""
    head_means = vitest_means(head) or {}
    base_means = vitest_means(base)
    has_base = base_means is not None
    return compare_means(head_means, base_means or {}), has_base


def compare_means(head_means, base_means):
    results = []
    for name in sorted(set(head_means) | set(base_means)):
        base_ns = base_means.get(name)
        head_ns = head_means.get(name)
        change = head_ns / base_ns - 1 if base_ns and head_ns is not None else None
        results.append(Result(name, base_ns, head_ns, change))
    return results


def duration(nanoseconds):
    if nanoseconds is None:
        return "–"
    for unit, size in (("s", 1e9), ("ms", 1e6), ("µs", 1e3)):
        if nanoseconds >= size:
            return f"{nanoseconds / size:.3g} {unit}"
    return f"{nanoseconds:.3g} ns"


def is_slower(result):
    return result.change is not None and result.change > SLOWER


def section(title, results, has_base):
    """One suite's table as Markdown lines, and a warning line for each slower bench."""
    lines = [f"### {title}", ""]
    if not results:
        return lines + ["No benchmark results were found.", ""], []
    if not has_base:
        lines += ["No usable baseline for this suite; only this PR's numbers are shown.", ""]
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
        "",
    ]
    return lines, warnings


def render(sections):
    """The summary's Markdown for `(title, results, has_base)` sections, and their warnings."""
    lines = ["## Benchmarks", ""]
    warnings = []
    if not sections:
        lines += ["No benchmark results were found.", ""]
    for title, results, has_base in sections:
        section_lines, section_warnings = section(title, results, has_base)
        lines += section_lines
        warnings += section_warnings
    lines.append("Times are the mean per iteration on a shared runner, so a few percent either way is noise.")
    return "\n".join(lines) + "\n", warnings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("criterion", nargs="?", help="the target/criterion folder")
    parser.add_argument(
        "--no-base",
        action="store_true",
        help="the PR base's Rust benches did not run; report the head alone",
    )
    parser.add_argument("--stored-baseline", type=Path, help="downloaded main measurements directory")
    parser.add_argument("--baseline-note", help="where the comparison came from")
    parser.add_argument("--vitest", help="the head's vitest JSON report")
    parser.add_argument(
        "--vitest-base",
        help="the base's vitest JSON report; without it the frontend shows the head alone",
    )
    parser.add_argument(
        "--summary",
        default=os.environ.get("GITHUB_STEP_SUMMARY"),
        help="file the Markdown is also appended to (default: $GITHUB_STEP_SUMMARY)",
    )
    args = parser.parse_args(argv)
    try:
        sections = []
        if args.criterion and args.stored_baseline:
            sections.append(("Rust", *stored_criterion_results(args.criterion, args.stored_baseline / "criterion")))
        elif args.criterion:
            has_base = not args.no_base
            sections.append(("Rust", criterion_results(args.criterion, has_base), has_base))
        if args.vitest:
            base = args.stored_baseline / "vitest.json" if args.stored_baseline else args.vitest_base
            sections.append(("Frontend", *vitest_results(args.vitest, base)))
        markdown, warnings = render(sections)
        if args.baseline_note:
            markdown += f"\n{args.baseline_note}\n"
        # Also in the log: job summaries are hidden from signed-out
        # viewers and from the API.
        sys.stdout.write(markdown)
        if args.summary:
            with open(args.summary, "a", encoding="utf-8") as summary:
                summary.write(markdown)
        for warning in warnings:
            print(warning)
    except Exception as err:  # A broken report must not fail the job.
        print(f"::warning title=Benchmark report::Could not write the report: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
