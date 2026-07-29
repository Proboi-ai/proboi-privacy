/**
 * Личность и её употребления.
 *
 * Сейф нумерует ЛИЧНОСТЬ, а не форму: «Иванов И.П.», «Иванову И.П.» и «Ивановым И.П.» —
 * один человек и ОДИН ярлык. Иначе модель видит троих разных людей и не связывает
 * «[PER_01] подписал» с «направлено [PER_02]» — ровно та связность, ради которой
 * обезличивание вообще делают обратимым.
 *
 * Обратная сторона — возврат. Если по одному ярлыку всегда подставлять именительный падеж,
 * получится «направлено Иванов И.П.»: текст станет неграмотным на каждом втором упоминании,
 * а это ХУЖЕ лишних номеров. Поэтому падеж выбирается по месту, тремя ступенями:
 *
 *   1. ПО СЛОВУ-ПОДСКАЗКЕ. При обезличивании запоминаем слово слева от каждой формы:
 *      «направлено» → «Иванову И.П.», «с» → «Ивановым И.П.». В ответе модели контекст вокруг
 *      ярлыка почти всегда тот же — ярлык непрозрачен, склонять его нечем, и фразу вокруг
 *      модель сохраняет. Морфология здесь не нужна вовсе: документ сам приносит таблицу
 *      «слово → форма», включая управление глаголов, которого нет ни в одном словаре.
 *      На неизменённом контексте это даёт возврат байт-в-байт.
 *   2. ПО ПРЕДЛОГУ. Модель перефразировала, и предлог новый — падеж берём из таблицы и
 *      склоняем именительную форму. В таблице ТОЛЬКО однозначные предлоги.
 *   3. КАК БЫЛО. Подсказок нет — отдаём исходную форму, поведение прежнее.
 *
 * Почему не «падеж вхождения по позиции» (вариант А в хендоффе): модель переставляет и
 * переписывает текст, привязка к позиции теряется. Почему не подсказка модели в промпте
 * (вариант В): это меняет контракт с моделью ради задачи, которая решается на нашей стороне.
 */

import { fullNameForms, inflectFullName, type GramCase, type Gender } from "./surname";

/** Слева от ярлыка нет управляющего слова (начало текста или знак препинания). */
export const NO_CUE = "";

/**
 * Слово слева: «направлено [PER_01]» → «направлено». Запятая, двоеточие и тире рвут
 * управление («Ответственный: [PER_01]») — там подсказки нет.
 *
 * Точка НЕ рвёт: она с равным успехом конец предложения и часть сокращения, а «им.» в
 * «НИИ им. [PER_01]» — самая настоящая подсказка, и без неё родительный падеж в названии
 * института возвращался бы именительным («им. Склифосовский»).
 */
export function cueBefore(text: string, index: number): string {
  const m = /([А-Яа-яЁёA-Za-z]+)\.?[  \t]*$/u.exec(text.slice(Math.max(0, index - 48), index));
  return m ? m[1]!.toLowerCase() : NO_CUE;
}

/**
 * Предлоги с ОДНОЗНАЧНЫМ падежом при имени человека. Многопадежные (в, на, за, под, по)
 * сюда не входят: без синтаксического разбора их падеж не определить, а ошибка падежа
 * портит текст — ради неё вся эта машинерия и затевалась. «с/со» и «о/об» включены:
 * при человеке они творительный и предложный практически без исключений.
 */
const CASE_BY_PREPOSITION: Readonly<Record<string, GramCase>> = {
  без: "gen", близ: "gen", вместо: "gen", возле: "gen", вокруг: "gen", для: "gen",
  до: "gen", из: "gen", кроме: "gen", насчёт: "gen", около: "gen", от: "gen",
  относительно: "gen", после: "gen", помимо: "gen", посредством: "gen", против: "gen",
  ради: "gen", сверх: "gen", у: "gen",
  благодаря: "dat", вопреки: "dat", к: "dat", ко: "dat", навстречу: "dat",
  подобно: "dat", согласно: "dat",
  между: "ins", меж: "ins", над: "ins", надо: "ins", перед: "ins", передо: "ins",
  с: "ins", со: "ins",
  о: "loc", об: "loc", обо: "loc", при: "loc",
};

/** Падеж по слову слева; однозначного признака нет → именительный. */
export function caseFromCue(cue: string): GramCase {
  return CASE_BY_PREPOSITION[cue] ?? "nom";
}

/** Часть сейфа, нужная для выбора формы. `TokenVault` реализует её как есть. */
export interface IdentityVault {
  original(token: string): string | undefined;
  entry?(token: string): { type: string; lemma?: string; morph?: Record<string, string> } | undefined;
  useFor?(token: string, cue: string): string | undefined;
  surfaces?(): Array<{ token: string; surface: string }>;
}

function genderOf(morph: Record<string, string> | undefined): Gender | undefined {
  if (morph?.gender === "femn") return "femn";
  if (morph?.gender === "masc") return "masc";
  return undefined;
}

/**
 * Оригинал в форме, подходящей месту ярлыка в позиции `index`.
 *
 * Не ФИО, неизвестный токен или сейф без морфологии → исходная форма, как до этой правки.
 * Именно поэтому все не-PER типы и старые записи сейфа ведут себя байт-в-байт по-прежнему.
 */
export function originalFor(
  vault: IdentityVault,
  token: string,
  text: string,
  index: number,
): string | undefined {
  const canonical = vault.original(token);
  if (canonical === undefined) return undefined;
  const entry = vault.entry?.(token);
  if (entry?.type !== "PER") return canonical;

  const cue = cueBefore(text, index);
  const observed = cue === NO_CUE ? undefined : vault.useFor?.(token, cue);
  if (observed !== undefined) return observed;

  // Склонять можно только от именительного. Его знает морфология (`lemma`); не отработала —
  // склонение исходной формы дало бы мусор, поэтому возвращаем её как есть.
  const nominative = entry.lemma;
  if (nominative === undefined) return canonical;
  const gramCase = caseFromCue(cue);
  return gramCase === "nom"
    ? nominative
    : inflectFullName(nominative, gramCase, genderOf(entry.morph));
}

/**
 * Все падежные написания выданных суррогатов и оригинал, склонённый в тот же падеж.
 *
 * Модель получает связный текст с вымышленным человеком и свободно его склоняет: выдали
 * «Петров А.В.» — в ответе «направлено Петрову А.В.». Поиск по одной поверхности такие формы
 * не находит, и пользователь получает в документе ВЫМЫШЛЕННОГО человека вместо настоящего,
 * то есть молчаливую подмену вместо видимого висящего ярлыка.
 *
 * Поверхность хранится в именительном (см. components/text-deid.ts), поэтому шесть форм
 * строятся корректно, а оригинал склоняется от СВОЕЙ именительной формы: канон может быть
 * косвенным, если первым в документе встретилось «Иванову И.И.».
 *
 * Порядок — от длинной формы к короткой: иначе «Петров» съел бы начало «Петровым».
 */
export function surrogateForms(vault: IdentityVault): Array<{ form: string; replacement: string }> {
  const out: Array<{ form: string; replacement: string }> = [];
  const seen = new Set<string>();
  for (const { token, surface } of vault.surfaces?.() ?? []) {
    const original = vault.original(token);
    if (!original || !surface) continue;
    const entry = vault.entry?.(token);
    const gender = genderOf(entry?.morph);
    const nominative = entry?.lemma ?? original;
    const variants: Array<[GramCase, string]> =
      entry?.type === "PER" || entry === undefined
        ? fullNameForms(surface, gender)
        : [["nom", surface]];

    for (const [gramCase, form] of variants) {
      if (seen.has(form)) continue; // одна и та же форма у двух людей — не угадываем, берём первую
      seen.add(form);
      out.push({
        form,
        // Не вышло склонить — fail-open внутри inflectFullName вернёт исходное написание:
        // имя верное, падеж прежний.
        replacement: gramCase === "nom" ? nominative : inflectFullName(nominative, gramCase, gender),
      });
    }
  }
  return out.sort((a, b) => b.form.length - a.form.length);
}
