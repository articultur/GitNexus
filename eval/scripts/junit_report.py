#!/usr/bin/env python3
"""Convert eval summary.json to JUnit XML for CI consumption."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def main():
    summary_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("eval/runs/ci-gate/summary.json")
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else summary_path.parent / "junit.xml"

    with summary_path.open() as f:
        summary = json.load(f)

    testsuites = ET.Element("testsuites")
    ts = ET.SubElement(testsuites, "testsuite", name="gitnexus-eval")

    delta = summary.get("delta", {})
    f1_delta = delta.get("file_f1", {}).get("delta", 0)

    tc = ET.SubElement(ts, "testcase", name="delta_file_f1", classname="eval")
    if f1_delta < 0.15:  # default threshold
        ET.SubElement(tc, "failure", message=f"delta File F1 ({f1_delta:.4f}) below threshold")

    tree = ET.ElementTree(testsuites)
    tree.write(str(output_path), encoding="unicode", xml_declaration=True)
    print(f"JUnit XML -> {output_path}")


if __name__ == "__main__":
    main()
