export type Vertical = "common" | "geo" | "legal" | "finance" | "medical" | "hr";

export type EntityType =
  | "PER"
  | "ORG"
  | "DATE"
  | "PHONE"
  | "PASSPORT"
  | "INN"
  | "EMAIL"
  | "ADDR"
  | "URL"
  | "IP"
  | "COORD"
  | "LICENSE_SUBSOIL"
  | "WELL"
  | "GEO_NAME"
  | "CADASTRE"
  | "CASE"
  | "OGRN"
  | "OGRNIP"
  | "KPP"
  | "CONTRACT_NO"
  | "NOTARY_REG"
  | "BIK"
  | "ACCOUNT"
  | "CARD"
  | "AMOUNT"
  | "SNILS"
  | "POLICY_OMS"
  | "MRN"
  | "ICD"
  | "PERSONNEL_NO"
  | "LABOUR_BOOK"
  | "DL"
  | "PLATE";

export interface EntityDef {
  type: EntityType;
  label: string;
  verticals: Vertical[];
  detector: "regex" | "checksum" | "ner" | "coords";
  confidence: "high" | "medium";
  defaultOn: boolean;
}

const entity = (
  type: EntityType,
  label: string,
  verticals: Vertical[],
  detector: EntityDef["detector"],
  confidence: EntityDef["confidence"] = "high",
  defaultOn = true,
): EntityDef => ({ type, label, verticals, detector, confidence, defaultOn });

export const ENTITY_REGISTRY: readonly EntityDef[] = [
  entity("PER", "ФИО", ["common"], "ner"),
  entity("ORG", "Организация", ["common"], "ner"),
  entity("DATE", "Дата", ["common"], "regex"),
  entity("PHONE", "Телефон", ["common"], "regex"),
  entity("PASSPORT", "Паспорт РФ", ["common"], "regex"),
  entity("INN", "ИНН", ["common"], "checksum"),
  entity("EMAIL", "Электронная почта", ["common"], "regex"),
  entity("ADDR", "Почтовый адрес", ["common"], "ner", "medium"),
  entity("URL", "Ссылка", ["common"], "regex"),
  entity("IP", "IP-адрес", ["common"], "regex"),
  entity("COORD", "Координаты", ["geo"], "coords"),
  entity("LICENSE_SUBSOIL", "Лицензия на недропользование", ["geo"], "regex", "medium"),
  entity("WELL", "Номер скважины", ["geo"], "regex", "medium"),
  entity("GEO_NAME", "Географическое название", ["geo"], "ner", "medium"),
  entity("CADASTRE", "Кадастровый номер", ["geo", "legal"], "regex", "medium"),
  entity("CASE", "Номер дела", ["legal"], "regex"),
  entity("OGRN", "ОГРН", ["legal"], "checksum"),
  entity("OGRNIP", "ОГРНИП", ["legal"], "checksum"),
  entity("KPP", "КПП", ["legal"], "regex", "medium"),
  entity("CONTRACT_NO", "Номер договора", ["geo", "legal"], "regex", "medium"),
  entity("NOTARY_REG", "Реестровый номер нотариуса", ["legal"], "regex", "medium"),
  entity("BIK", "БИК", ["finance"], "checksum"),
  entity("ACCOUNT", "Банковский счёт", ["finance"], "checksum"),
  entity("CARD", "Банковская карта", ["finance"], "checksum"),
  entity("AMOUNT", "Денежная сумма", ["finance"], "regex", "high", false),
  entity("SNILS", "СНИЛС", ["medical", "hr"], "checksum"),
  entity("POLICY_OMS", "Полис ОМС", ["medical"], "regex", "medium"),
  entity("MRN", "Номер медицинской карты", ["medical"], "regex", "medium"),
  entity("ICD", "Код МКБ-10", ["medical"], "regex"),
  entity("PERSONNEL_NO", "Табельный номер", ["hr"], "regex", "medium"),
  entity("LABOUR_BOOK", "Трудовая книжка", ["hr"], "regex", "medium"),
  entity("DL", "Водительское удостоверение", ["hr"], "regex", "medium"),
  entity("PLATE", "Госномер автомобиля", ["hr"], "regex"),
] as const;

export const ENTITY_TYPES = ENTITY_REGISTRY.map(({ type }) => type);

/** Общие сущности + сущности вертикали; выключенные по умолчанию типы не включаются. */
export function entitiesForVertical(vertical: Vertical): EntityType[] {
  return ENTITY_REGISTRY
    .filter((def) => def.defaultOn && def.verticals.some((v) => v === "common" || v === vertical))
    .map(({ type }) => type);
}

export function isVertical(value: unknown): value is Vertical {
  return ["common", "geo", "legal", "finance", "medical", "hr"].includes(value as Vertical);
}
