import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const start = source.indexOf("function normalizeOcrText(value)");
const end = source.indexOf("let isMacroRunning", start);

assert.notEqual(start, -1, "could not find the OCR matcher in index.html");
assert.notEqual(end, -1, "could not find the OCR matcher end marker");

const matcherSource = source.slice(start, end);

function matcherContext({ stratagems, maxSlots = 4, loadout = [] }) {
  const context = vm.createContext({ console });
  vm.runInContext(
    `
      let stratagemDB = ${JSON.stringify(stratagems)};
      let maxSlots = ${maxSlots};
      let activeLoadout = ${JSON.stringify(loadout)};
      let overlaySelectedIndex = -1;
      let committed = false;
      function commitLoadoutChange() { committed = true; }
      ${matcherSource}
    `,
    context,
    { filename: "index.html:ocr-matcher" },
  );
  return context;
}

function evaluate(context, expression) {
  return vm.runInContext(expression, context, { filename: "ocr-matcher-regression" });
}

// Real Chinese labels from the in-game list must survive normalization and
// match independently even when OCR returns several lines at once.
{
  const terms = [
    "\u8f68\u9053380MM\u9ad8\u7206\u5f39\u706b\u529b\u7f51",
    "\u5b9a\u5411\u62a4\u76fe",
    "\u201c\u98de\u9e70\u201d500KG\u70b8\u5f39",
    "\u8f68\u9053\u70ae\u653b\u51fb",
    "\u673a\u67aa",
  ];
  const context = matcherContext({
    maxSlots: terms.length,
    stratagems: terms.map((term, index) => ({ id: `real-${index}`, grp: "support", ocr: [term] })),
  });
  assert.deepEqual(
    JSON.parse(
      evaluate(
        context,
        `JSON.stringify(matchOcrStratagems(${JSON.stringify(terms.join("\n"))}).map(item => item.id))`,
      ),
    ),
    terms.map((_, index) => `real-${index}`),
  );
}

// Intentional legacy rule 1: a partial term never falls through to fuzzy matching.
{
  const context = matcherContext({
    stratagems: [{ id: "alpha", grp: "support", ocr: ["Alpha"] }],
  });
  assert.deepEqual(
    JSON.parse(evaluate(context, "JSON.stringify(matchOcrStratagems('Alph').map(item => item.id))")),
    [],
  );
}

// Newly bundled stratagem terms must resolve directly from the in-game Chinese label.
{
  const context = matcherContext({
    stratagems: [{ id: "wpn_meltagun", grp: "support", ocr: ["热熔枪"] }],
  });
  assert.deepEqual(
    JSON.parse(
      evaluate(context, "JSON.stringify(matchOcrStratagems('热熔枪').map(item => item.id))"),
    ),
    ["wpn_meltagun"],
  );
}

// Intentional legacy rule 2: exact lines are removed before fuzzy scores are indexed.
{
  const context = matcherContext({
    stratagems: [
      { id: "alpha", grp: "support", ocr: ["Alpha"] },
      { id: "beta", grp: "support", ocr: ["Bettor"] },
    ],
  });
  evaluate(
    context,
    `
      const originalScore = scoreStratagemAgainstOcr;
      globalThis.capturedFuzzyLines = [];
      scoreStratagemAgainstOcr = (entry, lines) => {
        capturedFuzzyLines.push([...lines]);
        return originalScore(entry, lines);
      };
      matchOcrStratagems('Alpha\\nBettar');
    `,
  );
  assert.deepEqual(
    JSON.parse(evaluate(context, "JSON.stringify(capturedFuzzyLines[1])")),
    ["bettar"],
  );
  assert.equal(
    evaluate(
      context,
      "scoreStratagemAgainstOcr(getOcrEntries().find(entry => entry.strat.id === 'beta'), ['bettar']).firstIndex",
    ),
    0,
  );
}

// Mission entries can reuse their Chinese and English names from the catalog.
{
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "server", "stratagem-admin", "data", "seed-catalog.json"), "utf8"));
  const context = matcherContext({ stratagems: catalog.items });
  const idsFor = text => JSON.parse(evaluate(context, `JSON.stringify(matchOcrStratagems(${JSON.stringify(text)}).map(item => item.id))`));
  const missionItems = catalog.items.filter(item => item.grp === "mission");
  assert.ok(missionItems.length > 0);
  for (const mission of missionItems) {
    assert.deepEqual(idsFor(mission.name.zh), [mission.id]);
    assert.deepEqual(idsFor(mission.name.en), [mission.id]);
  }
  assert.deepEqual(idsFor("地狱火炸弹"), ["mis_hellbomb"]);
  assert.deepEqual(idsFor("Portable Hellbomb"), ["pack_portable_hb"]);
  assert.deepEqual(idsFor("便携式地狱火炸弹"), ["pack_portable_hb"]);
}

// Yellow entries fill the slots remaining after regular stratagems. Locks,
// existing hotkeys, and regular stratagem order survive a mixed OCR result.
{
  const context = matcherContext({
    stratagems: [],
    maxSlots: 3,
    loadout: [
      { locked: false, strat: null, hotkey: "NumpadDecimal" },
      { locked: true, strat: { id: "locked" }, hotkey: "Numpad1" },
      { locked: false, strat: null, hotkey: "Numpad2" },
    ],
  });
  const result = JSON.parse(evaluate(context, `JSON.stringify(applyOcrLoadout([
    { id: 'yellow-a', grp: 'mission' },
    { id: 'locked', grp: 'mission' },
    { id: 'regular', grp: 'orbital' },
    { id: 'yellow-b', grp: 'mission' },
  ]))`));
  assert.deepEqual(result, { ok: true, count: 2, skippedMissionCount: 1 });
  assert.deepEqual(
    JSON.parse(evaluate(context, "JSON.stringify(activeLoadout.map(({ strat, hotkey }) => [strat.id, hotkey]))")),
    [["regular", "NumpadDecimal"], ["locked", "Numpad1"], ["yellow-a", "Numpad2"]],
  );
}

// An OCR result that does not fit must keep the previous loadout intact.
{
  const context = matcherContext({
    stratagems: [],
    maxSlots: 2,
    loadout: [
      { locked: false, strat: { id: "old-unlocked" } },
      { locked: true, strat: { id: "locked" } },
    ],
  });
  const result = JSON.parse(
    evaluate(
      context,
      "JSON.stringify(applyOcrLoadout([{ id: 'new-a' }, { id: 'new-b' }]))",
    ),
  );
  assert.deepEqual(result, { ok: false, reason: "no-space", count: 0 });
  assert.equal(evaluate(context, "activeLoadout[0].strat.id"), "old-unlocked");
  assert.equal(evaluate(context, "activeLoadout[1].strat.id"), "locked");
  assert.equal(evaluate(context, "committed"), false);
}

console.log("OCR matcher and loadout regression tests passed.");
