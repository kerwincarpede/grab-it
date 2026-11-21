import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from bench_report import Result, criterion_results, duration, main, render, vitest_results


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def estimates(nanoseconds):
    return {"mean": {"point_estimate": nanoseconds}, "median": {"point_estimate": nanoseconds}}


class Report(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def bench(self, name, base=None, head=None, change=None):
        folder = self.root.joinpath(*name.split("/"))
        for run, value in (("base", base), ("new", head)):
            if value is not None:
                write(folder / run / "estimates.json", estimates(value))
                write(folder / run / "benchmark.json", {"full_id": name})
        if change is not None:
            write(folder / "change" / "estimates.json", estimates(change))

    def test_reads_base_head_and_criterions_change(self):
        self.bench("detect/ocr", base=2e8, head=2.5e8, change=0.24)
        self.bench("detect/faces", base=1e6, head=1e6)
        self.assertEqual(criterion_results(self.root), [
            Result("detect/faces", 1e6, 1e6, 0.0),
            Result("detect/ocr", 2e8, 2.5e8, 0.24),
        ])

    def test_new_and_removed_benches_have_no_change(self):
        self.bench("encode/thumbnail", head=5e6)
        self.bench("encode/export_bmp", base=5e6)
        results = criterion_results(self.root)
        self.assertEqual(results, [
            Result("encode/export_bmp", 5e6, None, None),
            Result("encode/thumbnail", None, 5e6, None),
        ])
        markdown, warnings = render([("Rust", results, True)])
        self.assertIn("| `encode/thumbnail` | – | 5 ms | – | New |", markdown)
        self.assertIn("| `encode/export_bmp` | 5 ms | – | – | Removed |", markdown)
        self.assertEqual(warnings, [])

    def test_flags_benches_over_ten_percent_slower(self):
        results = [
            Result("a", 1e6, 1.2e6, 0.2),
            Result("b", 1e6, 1.05e6, 0.05),
            Result("c", 1e6, 0.5e6, -0.5),
        ]
        markdown, warnings = render([("Rust", results, True)])
        self.assertIn("| `a` | 1 ms | 1.2 ms | +20.0% | **Slower** |", markdown)
        self.assertIn("| `b` | 1 ms | 1.05 ms | +5.0% |  |", markdown)
        self.assertIn("| `c` | 1 ms | 500 µs | -50.0% |  |", markdown)
        self.assertIn("1 of 3 benches are over 10% slower", markdown)
        self.assertEqual(len(warnings), 1)
        self.assertTrue(warnings[0].startswith("::warning "))
        self.assertIn("a is 20.0% slower", warnings[0])

    def test_without_a_base_reports_the_head_alone(self):
        markdown, warnings = render([("Rust", [Result("a", None, 3e9, None)], False)])
        self.assertIn("only this PR's numbers", markdown)
        self.assertIn("| `a` | – | 3 s | – |  |", markdown)
        self.assertIn("1 benches ran.", markdown)
        self.assertEqual(warnings, [])

    def test_without_a_base_ignores_the_heads_own_base_folder(self):
        # A plain `cargo bench` saves the head's numbers to base/ too.
        self.bench("detect/ocr", base=2e8, head=2e8, change=0.0)
        self.assertEqual(
            criterion_results(self.root, has_base=False),
            [Result("detect/ocr", None, 2e8, None)],
        )
        summary = self.root / "summary.md"
        self.assertEqual(main([str(self.root), "--no-base", "--summary", str(summary)]), 0)
        self.assertIn("| `detect/ocr` | – | 200 ms | – |  |", summary.read_text())

    def vitest(self, name, means):
        """A vitest JSON report of `means` (milliseconds) by `test/bench` name."""
        tests = {}
        for bench, mean in means.items():
            test, task = bench.rsplit("/", 1)
            tests.setdefault(test, []).append({"name": task, "latency": {"mean": mean}, "rank": 1})
        report = {
            "testResults": [{
                "name": "/work/src/overlay/geometry.bench.ts",
                "assertionResults": [
                    {"title": test, "benchmarks": [{"name": test, "tasks": tasks}]}
                    for test, tasks in tests.items()
                ],
            }],
        }
        write(self.root / name, report)
        return str(self.root / name)

    def test_reads_vitest_reports(self):
        base = self.vitest("base.json", {"overlay/geometry/drag": 0.02, "editor/render/plan": 0.5})
        head = self.vitest("head.json", {"overlay/geometry/drag": 0.03, "recording/clips/scrub": 1.5})
        results, has_base = vitest_results(head, base)
        self.assertTrue(has_base)
        self.assertEqual([result.name for result in results], [
            "editor/render/plan", "overlay/geometry/drag", "recording/clips/scrub",
        ])
        self.assertEqual(results[0], Result("editor/render/plan", 5e5, None, None))
        self.assertEqual(results[1].base, 2e4)
        self.assertEqual(results[1].head, 3e4)
        self.assertAlmostEqual(results[1].change, 0.5)
        self.assertEqual(results[2], Result("recording/clips/scrub", None, 1.5e6, None))

    def test_vitest_without_a_base_or_a_readable_report(self):
        head = self.vitest("head.json", {"editor/flatten/borders": 2})
        results, has_base = vitest_results(head, str(self.root / "missing.json"))
        self.assertFalse(has_base)
        self.assertEqual(results, [Result("editor/flatten/borders", None, 2e6, None)])

        (self.root / "broken.json").write_text("{")
        self.assertEqual(vitest_results(str(self.root / "broken.json")), ([], False))

        # Rows read back with `bench.from()` and malformed tasks are skipped.
        write(self.root / "odd.json", {"testResults": [{"assertionResults": [{"benchmarks": [{
            "name": "t",
            "tasks": [
                {"name": "stored", "latency": {"mean": 1}, "fromStore": True},
                {"name": "no latency"},
                {"name": "kept", "latency": {"mean": 1}},
            ],
        }]}]}]})
        self.assertEqual(vitest_results(str(self.root / "odd.json")), ([Result("t/kept", None, 1e6, None)], False))

    def test_reports_each_suite_in_its_own_table(self):
        self.bench("detect/ocr", base=1e6, head=1e6, change=0.0)
        base = self.vitest("base.json", {"overlay/geometry/drag": 1})
        head = self.vitest("head.json", {"overlay/geometry/drag": 2})
        summary = self.root / "summary.md"
        out = io.StringIO()
        with redirect_stdout(out):
            main([str(self.root), "--vitest", head, "--vitest-base", base, "--summary", str(summary)])
        markdown = summary.read_text()
        self.assertLess(markdown.index("### Rust"), markdown.index("`detect/ocr`"))
        self.assertLess(markdown.index("### Frontend"), markdown.index("`overlay/geometry/drag`"))
        self.assertIn("| `overlay/geometry/drag` | 1 ms | 2 ms | +100.0% | **Slower** |", markdown)
        self.assertIn("overlay/geometry/drag is 100.0% slower", out.getvalue())
        # The log carries both tables too.
        self.assertIn(markdown, out.getvalue())

        # A base whose Rust benches failed still compares the frontend.
        summary.unlink()
        with redirect_stdout(io.StringIO()):
            main([str(self.root), "--no-base", "--vitest", head, "--vitest-base", base, "--summary", str(summary)])
        rust, frontend = summary.read_text().split("### Frontend")
        self.assertIn("only this PR's numbers", rust)
        self.assertNotIn("only this PR's numbers", frontend)

        # The frontend alone, with no base report.
        summary.unlink()
        with redirect_stdout(io.StringIO()):
            main(["--vitest", head, "--summary", str(summary)])
        markdown = summary.read_text()
        self.assertNotIn("### Rust", markdown)
        self.assertIn("only this PR's numbers", markdown)
        self.assertIn("1 benches ran.", markdown)

    def test_formats_durations(self):
        self.assertEqual(duration(12.345), "12.3 ns")
        self.assertEqual(duration(4_560), "4.56 µs")
        self.assertEqual(duration(7.5e6), "7.5 ms")
        self.assertEqual(duration(None), "–")

    def test_never_fails_the_job(self):
        summary = self.root / "summary.md"
        missing = str(self.root / "missing")
        self.assertEqual(main([missing, "--summary", str(summary)]), 0)
        self.assertIn("No benchmark results were found.", summary.read_text())

        self.bench("detect/ocr", base=1e6, head=2e6, change=1.0)
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main([str(self.root), "--summary", str(summary)]), 0)
        self.assertIn("::warning title=Benchmark slower::detect/ocr", out.getvalue())
        self.assertIn("`detect/ocr`", summary.read_text())
        # The log carries the same report as the summary.
        self.assertIn(render([("Rust", criterion_results(self.root), True)])[0], out.getvalue())

        # A summary that cannot be written is a warning, not a failure.
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main([str(self.root), "--summary", str(self.root)]), 0)
        self.assertIn("Could not write the report", out.getvalue())


if __name__ == "__main__":
    unittest.main()
