/**
 * Расстояние Левенштейна с ранним выходом по порогу.
 *
 * Зачем своё, а не `fastest-levenshtein` (MIT, 769★), как предполагала спека: после сужения
 * нечёткого уровня (см. шапку `restore.ts`) сравниваются ТОЛЬКО имена типов — строки
 * до 12 символов, десяток штук на вызов. Пакет ради этого добавил бы зависимость в репозиторий,
 * который продаётся аудируемостью и минимальной цепочкой поставки. 30 строк проверяемого
 * кода дешевле в аудите, чем ещё один узел в дереве зависимостей.
 *
 * Классический алгоритм Вагнера — Фишера на двух строках матрицы, O(|a|·|b|) времени,
 * O(min(|a|,|b|)) памяти. Порог даёт ранний выход: если вся строка матрицы уже больше `max`,
 * итоговое расстояние тоже будет больше — считать дальше нечего.
 */

/**
 * Возвращает расстояние Левенштейна, если оно ≤ `max`, иначе `null`.
 *
 * `null` вместо числа — сознательно: вызывающему нужен ответ «в пределах порога или нет»,
 * и так его нельзя случайно сравнить с порогом неправильно.
 */
export function levenshteinWithin(a: string, b: string, max: number): number | null {
  if (a === b) return 0;
  if (max < 0) return null;

  // Разница длин — нижняя граница расстояния: короткий выход без матрицы.
  if (Math.abs(a.length - b.length) > max) return null;
  if (a.length === 0) return b.length <= max ? b.length : null;
  if (b.length === 0) return a.length <= max ? a.length : null;

  // Короткую строку кладём в столбцы — размер строки матрицы = min(|a|,|b|)+1.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  let prev = new Array<number>(short.length + 1);
  let cur = new Array<number>(short.length + 1);
  for (let j = 0; j <= short.length; j++) prev[j] = j;

  for (let i = 1; i <= long.length; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    const li = long.charCodeAt(i - 1);
    for (let j = 1; j <= short.length; j++) {
      const cost = li === short.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(
        cur[j - 1]! + 1, // вставка
        prev[j]! + 1, // удаление
        prev[j - 1]! + cost, // замена
      );
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Вся строка вышла за порог — расстояние уже не опустится ниже.
    if (rowMin > max) return null;
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  const d = prev[short.length]!;
  return d <= max ? d : null;
}
