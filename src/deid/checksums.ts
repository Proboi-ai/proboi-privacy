/** Российские идентификаторы: формат и опубликованные контрольные суммы. */

const digits = (v: string): number[] | null =>
  /^\d+$/.test(v) ? [...v].map(Number) : null;

const weightedDigit = (value: number[], weights: number[]): number =>
  weights.reduce((sum, weight, i) => sum + weight * value[i]!, 0) % 11 % 10;

export function isValidInn(v: string): boolean {
  const d = digits(v);
  if (!d || new Set(d).size === 1) return false;
  if (d.length === 10) {
    return d[9] === weightedDigit(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]);
  }
  if (d.length === 12) {
    return (
      d[10] === weightedDigit(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) &&
      d[11] === weightedDigit(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
    );
  }
  return false;
}

function modControl(v: string, bodyLength: number, divisor: bigint): boolean {
  if (!new RegExp(`^\\d{${bodyLength + 1}}$`).test(v)) return false;
  return Number(BigInt(v.slice(0, bodyLength)) % divisor % 10n) === Number(v.at(-1));
}

export function isValidOgrn(v: string): boolean {
  return /^[15]\d{12}$/.test(v) && modControl(v, 12, 11n);
}

export function isValidOgrnip(v: string): boolean {
  return /^3\d{14}$/.test(v) && modControl(v, 14, 13n);
}

export function isValidSnils(v: string): boolean {
  const normalized = v.replace(/[ -]/g, "");
  const d = digits(normalized);
  if (!d || d.length !== 11 || new Set(d).size === 1) return false;
  const sum = d.slice(0, 9).reduce((acc, n, i) => acc + n * (9 - i), 0);
  const control = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : (sum % 101) % 100;
  return control === Number(normalized.slice(9));
}

/**
 * У БИК нет отдельной контрольной цифры: проверяем государственный формат РФ.
 * Контроль с БИК выполняется у корреспондентского/расчётного счёта ниже.
 */
export function isValidBik(v: string): boolean {
  // Первые две цифры — не только «04». С казначейской реформы 2021 года счета бюджетных
  // заказчиков обслуживает ТОФК, и его БИК начинается на «00»/«01» («007162163» — УФК по
  // ХМАО). Старая маска отсекала их, а вместе с ними разваливалась и проверка контрольного
  // ключа счёта: она требует БИК. В договорах госзакупок такой плательщик — типовой.
  return /^0[014]\d{7}$/.test(v) && !/^(\d)\1{8}$/.test(v);
}

export function isValidAccount(account: string, bik: string): boolean {
  if (!/^\d{20}$/.test(account) || /^(\d)\1{19}$/.test(account) || !isValidBik(bik)) return false;
  const validWith = (prefix: string) =>
    [...`${prefix}${account}`].reduce(
      (sum, n, i) => sum + Number(n) * [7, 1, 3][i % 3]!,
      0,
    ) % 10 === 0;
  return validWith(bik.slice(-3)) || validWith(`0${bik.slice(4, 6)}`);
}

export function isValidCard(v: string): boolean {
  const normalized = v.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(normalized) || /^(\d)\1+$/.test(normalized)) return false;
  let sum = 0;
  let double = false;
  for (let i = normalized.length - 1; i >= 0; i--) {
    let n = Number(normalized[i]);
    if (double && (n *= 2) > 9) n -= 9;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}
