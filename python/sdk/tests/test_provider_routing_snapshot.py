"""通过真实 dsh SDK profile 验证 Python 的供应商切换事件投影。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps" / "cli" / "lib" / "bin.js"
SCENARIO = ROOT / "snapshots" / "sdk" / "provider-failover"
NODE = shutil.which("node")


@unittest.skipUnless(CLI.is_file() and NODE, "需要先构建 dsh profile runtime 并安装 Node")
class ProviderRoutingSnapshot(unittest.TestCase):
    def test_provider_failover_projection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dsh-python-routing-") as temporary:
            root = Path(temporary).resolve()
            patch_root = root / ".snapshot-patches"
            patch_root.mkdir()
            # 复用场景的包解析与配置准备，实际应用仍由 dsh profile 启动。
            prepare = """
import { materializeProfilePatch } from './packages/test-support/session-snapshot/src/launcher.ts';
const [root, source, target] = process.argv.slice(1);
process.stdout.write(JSON.stringify(['cordis.yml', 'cordis.snapshot.yml'].map((name, index) =>
  materializeProfilePatch(source + '/' + name, root, 'sdk', target, index))));
"""
            prepared = subprocess.run(
                [NODE, "--import", "tsx/esm", "--input-type=module", "-e", prepare,
                 str(root), str(SCENARIO), str(patch_root)],
                cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
            )
            patches = tuple(json.loads(prepared.stdout))
            fixture = root / "replay.jsonl"
            fixture.write_text(
                (SCENARIO / "session.v4.jsonl").read_text(encoding="utf-8")
                .replace("{{cwd}}", json.dumps(str(root))[1:-1]),
                encoding="utf-8",
            )
            executable = CLI
            if os.name == "nt":
                executable = root / "dsh.cmd"
                executable.write_text(f'@echo off\r\n"{NODE}" "{CLI}" %*\r\n', encoding="utf-8")
            with DeepSeekHarness(
                dsh_bin=str(executable), dsh_home=str(root / ".dsh"), cwd=str(root),
                patches=patches, provider="deepseek-official", model="deepseek-v4-flash",
                env={"DSH_TELEMETRY_DISABLED": "1", "DSH_SNAPSHOT": "replay",
                     "DSH_SNAPSHOT_FILE": str(fixture), "DSH_PERMISSION_MODE": "danger-full-access"},
            ) as harness:
                result = harness.run("This prompt first receives an empty response, then retries successfully.")
            actual = {
                "final_response": result.final_response,
                "finish_reason": result.finish_reason,
                "routes": [event["data"]["header"]["config"] for event in result.events
                           if event["type"] == "request/header"],
                "retry_events": [event["type"] for event in result.events
                                 if event["type"] in {"llm/retry", "llm/retry-started"}],
                "assistant_sources": [event["data"]["message"]["source"] for event in result.events
                                      if event["type"] == "assistant/message"],
            }
            expected = Path(__file__).with_name("expected") / "provider-failover.json"
            self.assertEqual(actual, json.loads(expected.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
