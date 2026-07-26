import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import natasha_sidecar as sidecar


class ModelProfilesTest(unittest.TestCase):
    def tearDown(self):
        sidecar._release_gliner()
        sidecar._GLINER_ERROR = None
        sidecar._GLINER_PROFILE = None

    def test_relative_paths_threshold_and_labels_are_profile_specific(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "geo-model").mkdir()
            config = {
                "geo": {
                    "model": "geo-model",
                    "threshold": 0.6,
                    "status": "pilot",
                    "labels": {"FIELD": "месторождение"},
                }
            }
            path = root / "models.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with patch.dict(os.environ, {"PRIVACY_GLINER_MODELS_CONFIG": str(path)}, clear=False):
                result = sidecar._profile_config("geo")
            self.assertEqual(result["model"], str((root / "geo-model").resolve()))
            self.assertEqual(result["display_model"], "geo-model")
            self.assertEqual(result["threshold"], 0.6)
            self.assertEqual(result["labels"], {"FIELD": "месторождение"})

    def test_one_loaded_model_is_reused_or_released_on_profile_switch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "shared").mkdir()
            (root / "medical").mkdir()
            path = root / "models.json"
            path.write_text(json.dumps({
                "geo": {"model": "shared", "threshold": 0.5, "labels": {"FIELD": "поле"}},
                "legal": {"model": "shared", "threshold": 0.6, "labels": {"ORG": "организация"}},
                "medical": {"model": "medical", "threshold": 0.7, "labels": {"PER": "пациент"}},
            }), encoding="utf-8")
            loaded = []

            class FakeGLiNER:
                @staticmethod
                def from_pretrained(model, **_kwargs):
                    instance = object()
                    loaded.append((model, instance))
                    return instance

            with (
                patch.dict(os.environ, {"PRIVACY_GLINER_MODELS_CONFIG": str(path)}, clear=False),
                patch.dict(sys.modules, {"gliner": SimpleNamespace(GLiNER=FakeGLiNER)}),
            ):
                sidecar._load_gliner("geo")
                first = sidecar._GLINER
                sidecar._load_gliner("legal")
                self.assertIs(sidecar._GLINER, first)
                sidecar._load_gliner("medical")
                self.assertIsNot(sidecar._GLINER, first)
            self.assertEqual(len(loaded), 2)
            self.assertEqual(sidecar._GLINER_PROFILE, "medical")


if __name__ == "__main__":
    unittest.main()
