import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from bench_report import Result, criterion_results, duration, main, render


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
        markdown, warnings = render(results, has_base=True)
        self.assertIn("| `encode/thumbnail` | – | 5 ms | – | New |", markdown)
        self.assertIn("| `encode/export_bmp` | 5 ms | – | – | Removed |", markdown)
        self.assertEqual(warnings, [])

    def test_flags_benches_over_ten_percent_slower(self):
        results = [
            Result("a", 1e6, 1.2e6, 0.2),
            Result("b", 1e6, 1.05e6, 0.05),
            Result("c", 1e6, 0.5e6, -0.5),
        ]
        markdown, warnings = render(results, has_base=True)
        self.assertIn("| `a` | 1 ms | 1.2 ms | +20.0% | **Slower** |", markdown)
        self.assertIn("| `b` | 1 ms | 1.05 ms | +5.0% |  |", markdown)
        self.assertIn("| `c` | 1 ms | 500 µs | -50.0% |  |", markdown)
        self.assertIn("1 of 3 benches are over 10% slower", markdown)
        self.assertEqual(len(warnings), 1)
        self.assertTrue(warnings[0].startswith("::warning "))
        self.assertIn("a is 20.0% slower", warnings[0])

    def test_without_a_base_reports_the_head_alone(self):
        markdown, warnings = render([Result("a", None, 3e9, None)], has_base=False)
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
        self.assertIn(render(criterion_results(self.root), True)[0], out.getvalue())

        # A summary that cannot be written is a warning, not a failure.
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main([str(self.root), "--summary", str(self.root)]), 0)
        self.assertIn("Could not write the report", out.getvalue())


if __name__ == "__main__":
    unittest.main()
