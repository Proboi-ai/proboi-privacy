import { detectEntities } from "../src/deid/detect";
import { entitiesForVertical } from "../src/deid/entities";
import { assertReleaseThresholds, scoreCorpus } from "../src/validation";
import { GOLD_CORPUS } from "../validation/gold";

const report = scoreCorpus(
  GOLD_CORPUS,
  (doc) => detectEntities(doc.text, entitiesForVertical(doc.vertical)),
  [...new Map(GOLD_CORPUS.map((doc) => [JSON.stringify(doc.quasi), doc.quasi])).values()]
    .flatMap((quasi, index) => [
      { id: `public-${index}-a`, quasi },
      { id: `public-${index}-b`, quasi },
    ]),
);
assertReleaseThresholds(report);
console.log(JSON.stringify(report, null, 2));
