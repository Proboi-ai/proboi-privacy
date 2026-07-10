/**
 * «Местная СК» — ФЛАГМАН, но честно: usability-обёртка, НЕ крипто-защита.
 *
 * Council-вердикт: обратимый affine/Helmert-сдвиг = obfuscation.
 * Вскрывается атакой известным-открытым-текстом (KPA) по 1–2 реальным точкам
 * (координата из Росреестра / публичной лицензии / геотега) за минуты. Поэтому:
 *   • реальная приватность = ТОКЕНИЗАЦИЯ координат (coords.ts + vault.ts);
 *   • «местная СК» = обёртка: геологи и так работают в местной (условной) системе
 *     (Пост. Правит. РФ №139/2007), + снижает случайную утечку. НЕ продаём как крипто.
 *
 * Два слоя, оба обратимы точно (в пределах точности проекции):
 *   1. datumConvert — реальная геодезия через proj4 (WGS84 ↔ Пулково-1942 и т.п.).
 *   2. affine — обратимый сдвиг+поворот+масштаб с ключом клиента (LocalCSKey).
 */

import proj4 from "proj4";
import type { GeoPoint } from "./coords";

// Пулково-1942 (СК-42), геогр.: эллипсоид Красовского + 7-параметр towgs84.
proj4.defs(
  "PULKOVO-1942",
  "+proj=longlat +ellps=krass +towgs84=23.57,-140.95,-79.8,0,0.35,0.79,-0.22 +no_defs",
);
// ГСК-2011 практически совпадает с WGS84 на уровне метров — используем как алиас.
proj4.defs("GSK-2011", "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs");

const CRS_ALIAS: Record<string, string> = {
  WGS84: "EPSG:4326",
  "EPSG:4326": "EPSG:4326",
  "СК-42": "PULKOVO-1942",
  "SK-42": "PULKOVO-1942",
  "PULKOVO-1942": "PULKOVO-1942",
  "ГСК-2011": "GSK-2011",
  "GSK-2011": "GSK-2011",
};

function resolveCRS(name: string): string {
  const r = CRS_ALIAS[name];
  if (!r) throw new Error(`Неизвестная СК: "${name}"`);
  return r;
}

/** Реальная геодезическая конверсия датума (round-trip в пределах точности proj4). */
export function datumConvert(p: GeoPoint, from: string, to: string): GeoPoint {
  const [lon, lat] = proj4(resolveCRS(from), resolveCRS(to), [p.lon, p.lat]);
  return { lat: lat!, lon: lon! };
}

/** Ключ перехода местной СК — секрет клиента (хранится в GeoVault). */
export interface LocalCSKey {
  dx: number; // сдвиг по долготе
  dy: number; // сдвиг по широте
  rotation: number; // поворот, радианы
  scale: number; // масштаб (~1)
}

/** WGS84 → местные условные координаты (обратимо ключом). */
export function toLocalCS(p: GeoPoint, key: LocalCSKey): { x: number; y: number } {
  const c = Math.cos(key.rotation);
  const s = Math.sin(key.rotation);
  const x = key.scale * (c * p.lon - s * p.lat) + key.dx;
  const y = key.scale * (s * p.lon + c * p.lat) + key.dy;
  return { x, y };
}

/** Местные условные координаты → WGS84 (точная инверсия toLocalCS тем же ключом). */
export function fromLocalCS(pt: { x: number; y: number }, key: LocalCSKey): GeoPoint {
  const c = Math.cos(key.rotation);
  const s = Math.sin(key.rotation);
  const ux = (pt.x - key.dx) / key.scale;
  const uy = (pt.y - key.dy) / key.scale;
  const lon = c * ux + s * uy;
  const lat = -s * ux + c * uy;
  return { lat, lon };
}
