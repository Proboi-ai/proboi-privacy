import unittest

from gliner_windows import predict_windowed, text_windows


class FakeModel:
    def predict_entities(self, text, labels, threshold):
        out = []
        marker = "СЕКРЕТ"
        start = text.find(marker)
        if start >= 0:
            out.append({
                "start": start,
                "end": start + len(marker),
                "text": marker,
                "label": labels[0],
                "score": 0.9,
            })
        return out


class WindowingTest(unittest.TestCase):
    def test_covers_long_document_without_gaps_at_word_level(self):
        text = " ".join(f"слово{i}" for i in range(1000))
        windows = text_windows(text, max_words=100, overlap_words=20)
        self.assertGreater(len(windows), 10)
        covered = set()
        words = text.split()
        for window in windows:
            covered.update(window["text"].split())
        self.assertEqual(covered, set(words))
        self.assertEqual(windows[0]["start"], 0)
        self.assertEqual(windows[-1]["end"], len(text))

    def test_maps_tail_prediction_to_document_offset(self):
        prefix = " ".join(f"фон{i}" for i in range(700))
        text = prefix + " СЕКРЕТ завершает документ"
        predictions = predict_windowed(
            FakeModel(),
            text,
            ["секрет"],
            threshold=0.3,
            max_words=100,
            overlap_words=20,
        )
        self.assertEqual(len(predictions), 1)
        found = predictions[0]
        self.assertEqual(text[found["start"]:found["end"]], "СЕКРЕТ")
        self.assertGreater(found["start"], len(text) * 0.9)

    def test_deduplicates_overlap_prediction(self):
        text = " ".join(["фон"] * 80 + ["СЕКРЕТ"] + ["фон"] * 80)
        predictions = predict_windowed(
            FakeModel(),
            text,
            ["секрет"],
            threshold=0.3,
            max_words=100,
            overlap_words=40,
        )
        self.assertEqual(len(predictions), 1)


if __name__ == "__main__":
    unittest.main()
