import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from natasha_sidecar import _valid_gliner_entity


class GlinerEntityFilterTest(unittest.TestCase):
    def test_accepts_russian_names(self):
        for value in ("Иванов И.И.", "И.И. Иванов", "Анна Петрова"):
            self.assertTrue(_valid_gliner_entity("PER", value))

    def test_rejects_numeric_document_values(self):
        for value in ("ЯКУ 12345 НР", "044525225", "Карта 4111 1111 1111 1111", "Полис ОМС"):
            self.assertFalse(_valid_gliner_entity("PER", value))

    def test_does_not_restrict_other_types(self):
        self.assertTrue(_valid_gliner_entity("ORG", "ПАО «Контур»"))

    def test_rejects_roles_as_people(self):
        self.assertFalse(_valid_gliner_entity("PER", "Недропользователем"))

    def test_rejects_generic_geo_phrases_but_keeps_named_fields(self):
        for value in ("участком недр", "добычи полезных ископаемых", "Калининградском заливе"):
            self.assertFalse(_valid_gliner_entity("FIELD", value))
        for value in ("Падовском участке", "месторождение Рыбачье", "Сев.-Лесное"):
            self.assertTrue(_valid_gliner_entity("FIELD", value))


if __name__ == "__main__":
    unittest.main()
