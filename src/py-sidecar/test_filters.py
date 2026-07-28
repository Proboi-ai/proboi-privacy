import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from natasha_sidecar import _valid_gliner_entity, _valid_natasha_entity


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


class NatashaEntityFilterTest(unittest.TestCase):
    """Формы взяты с ручного эталона, значения вымышленные.

    Ложные срабатывания воспроизведены как есть: это обычные слова отраслевого
    отчёта, которые Natasha принимала за людей и организации.
    """

    def test_keeps_signature_form(self):
        for value in ("Корнилаев В.А.", "Абдыгулов О.И", "Чурочкиной М.И.",
                      "В.А. Корнилаев", "Джумаханов А. В.", "Подъячев\nВ.М."):
            self.assertTrue(_valid_natasha_entity("PER", value), value)

    def test_rejects_capitalised_common_words(self):
        for value in ("Камеральная", "Камеральные", "Оруденение", "Сульфиды", "Автор",
                      "Маркшейдерские", "Отчисление", "Минералы-концентраторы",
                      "Гравитационно-флотационная", "Приозёрская", "Северо-Западного"):
            self.assertFalse(_valid_natasha_entity("PER", value), value)

    def test_rejects_bare_initials_and_garbage(self):
        for value in ("В.Т.", "М.", "Инт", "Ьодайбш", "Игрек"):
            self.assertFalse(_valid_natasha_entity("PER", value), value)

    def test_keeps_organisation_with_legal_form(self):
        for value in ("ОАО «ВГРК»", "ЗАО \"Тегерек\"", "ООО КомТранс", "ГПП «Гранистрой»",
                      "ОАО «НИИ Благородных и редких металлов и алмазов"):
            self.assertTrue(_valid_natasha_entity("ORG", value), value)

    def test_keeps_institute_abbreviation(self):
        self.assertTrue(_valid_natasha_entity("ORG", "СВКНИИ ДВО РАН"))

    def test_rejects_layout_fields_and_licence_numbers(self):
        for value in ("PAGEREF", "REF", "Купол PAGEREF", "РОСС RU", "НТС",
                      "СХБ 01947 БР", "СХБ № 01947БР"):
            self.assertFalse(_valid_natasha_entity("ORG", value), value)

    def test_rejects_generic_units_that_gold_does_not_count(self):
        for value in ("Аналитический центр", "Геофизической партии", "Промежуточный",
                      "Кристалл флюорита", "Au Ag Au Ag"):
            self.assertFalse(_valid_natasha_entity("ORG", value), value)


if __name__ == "__main__":
    unittest.main()
