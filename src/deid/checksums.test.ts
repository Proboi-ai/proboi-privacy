import { describe, expect, it } from "bun:test";
import {
  isValidAccount,
  isValidBik,
  isValidCard,
  isValidInn,
  isValidOgrn,
  isValidOgrnip,
  isValidSnils,
} from "./checksums";

const expectVectors = (
  validate: (value: string) => boolean,
  valid: string[],
  invalid: string[],
) => {
  for (const value of valid) expect(validate(value), value).toBe(true);
  for (const value of invalid) expect(validate(value), value).toBe(false);
};

describe("privacy/deid/checksums", () => {
  it("ИНН: 10/12 цифр", () => {
    expectVectors(
      isValidInn,
      ["7707083893", "7736207543", "500100732259", "7710140679", "7812014560"],
      ["7707083894", "7736207542", "500100732258", "7710140678", "7812014561"],
    );
  });

  it("ОГРН", () => {
    expectVectors(
      isValidOgrn,
      ["1027700132195", "1027700070518", "1047796570007", "1067746062449", "1147746733661"],
      ["1027700132194", "1027700070519", "1047796570008", "1067746062448", "1147746733662"],
    );
  });

  it("ОГРНИП", () => {
    expectVectors(
      isValidOgrnip,
      ["304500116000157", "315774600012344", "318774600099996", "324631600000121", "307770000000450"],
      ["304500116000156", "315774600012345", "318774600099997", "324631600000122", "307770000000451"],
    );
  });

  it("СНИЛС", () => {
    expectVectors(
      isValidSnils,
      ["11223344595", "90114404441", "08765430300", "12345678964", "00100199864"],
      ["11223344594", "90114404442", "08765430301", "12345678963", "00100199865"],
    );
  });

  it("БИК: формат РФ", () => {
    expectVectors(
      isValidBik,
      ["044525225", "044525974", "044525593", "044030653", "045004641"],
      ["144525225", "04452522", "0445252250", "04A525225", "000000000"],
    );
  });

  it("банковский счёт проверяется вместе с БИК", () => {
    const valid = [
      ["40702810111111111114", "044525225"],
      ["40702811222222222229", "044525974"],
      ["40702812333333333334", "044525593"],
      ["40702813444444444447", "044030653"],
      ["40702814555555555550", "045004641"],
    ] as const;
    for (const [account, bik] of valid) expect(isValidAccount(account, bik)).toBe(true);
    for (const [account, bik] of valid) {
      expect(isValidAccount(`${account.slice(0, -1)}${(Number(account.at(-1)) + 1) % 10}`, bik)).toBe(false);
    }
  });

  it("банковская карта: алгоритм Луна", () => {
    expectVectors(
      isValidCard,
      ["4111111111111111", "5555555555554444", "378282246310005", "6011111111111117", "3566002020360505"],
      ["4111111111111112", "5555555555554445", "378282246310006", "6011111111111118", "3566002020360506"],
    );
  });
});
