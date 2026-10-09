/// <reference path="../../../types/omori-mod.d.ts" />
// New Game+: start a fresh story and bring part of your progress with you.
// Start it from Settings > Mods > "Start New Game+", or from an event with the plugin command `ngplus.start`.
// What carries over is chosen with the toggles in the same place.
// Everything is inside a function: all mods' scripts share one global scope.
(() => {
  const mod = OmoriMod.scope();

  const opt = {
    levels: mod.settings.add({ id: 'levels', type: 'toggle', label: 'Keep levels', help: 'Level and experience of every party member.', default: true }),
    skills: mod.settings.add({ id: 'skills', type: 'toggle', label: 'Keep skills', help: 'Skills each character has learned.', default: true }),
    equipment: mod.settings.add({ id: 'equipment', type: 'toggle', label: 'Keep equipment', help: 'What each character has equipped.', default: true }),
    items: mod.settings.add({ id: 'items', type: 'toggle', label: 'Keep items', help: 'Items, weapons and armor in the bag.', default: true }),
    gold: mod.settings.add({ id: 'gold', type: 'toggle', label: 'Keep gold', default: true }),
  };

  /** Plain, serialisable copy of what should carry over (so it survives the game objects being replaced). */
  function capture() {
    const copy = x => JSON.parse(JSON.stringify(x));
    const out = { cycle: ($gameSystem._ngPlusCycle || 0), actors: {}, party: null };
    const actors = $gameActors._data || [];
    actors.forEach((a, id) => {
      if (!a) return;
      out.actors[id] = { level: a._level, exp: copy(a._exp), skills: copy(a._skills), equips: copy(a._equips) };
    });
    out.party = { gold: $gameParty._gold, items: copy($gameParty._items), weapons: copy($gameParty._weapons), armors: copy($gameParty._armors) };
    return out;
  }

  /** Write the captured data into the (new) game that is now running. */
  function apply(c) {
    for (const [id, saved] of Object.entries(c.actors)) {
      const a = $gameActors.actor(Number(id));
      if (!a) continue;
      if (opt.levels.get()) { a._level = saved.level; a._exp = saved.exp; }
      if (opt.skills.get()) a._skills = saved.skills.slice();
      if (opt.equipment.get()) a._equips = saved.equips.map(e => Object.assign(new Game_Item(), e));
      a.refresh();
      a.recoverAll();
    }
    if (opt.gold.get()) $gameParty._gold = c.party.gold;
    if (opt.items.get()) { $gameParty._items = c.party.items; $gameParty._weapons = c.party.weapons; $gameParty._armors = c.party.armors; }
    $gameSystem._ngPlusCycle = c.cycle + 1;
  }

  /** From the title screen there is no running game: use the most recent save. */
  function ensureSource() {
    if ($gameParty && $gameParty.exists && $gameParty.exists() && $gameActors) return true;
    const id = DataManager.latestSavefileId();
    if (!(id > 0 && StorageManager.exists(id) && DataManager.loadGame(id))) return false;
    return true;
  }

  async function start() {
    if (!ensureSource()) { mod.warn('New Game+ needs a running game or at least one save to carry progress from.'); return false; }
    // Safety net: a checkpoint of the game being left, restorable from the debug panel (F9 > checkpoints).
    try { await OmoriMod.checkpoints.capture('before New Game+'); } catch (e) { mod.error(e, 'could not save a checkpoint first (continuing)'); }
    const carried = capture();
    DataManager.setupNewGame();
    apply(carried);
    SceneManager.goto(Scene_Map);
    mod.log(`New Game+ #${carried.cycle + 1} started`);
    return true;
  }

  mod.settings.add({ id: 'start', type: 'action', label: 'New Game+', button: 'Start New Game+', help: 'Starts the story again from the beginning with the options above. A checkpoint of the current game is saved first.', run: () => { void start(); } });
  mod.command('ngplus.start', () => { void start(); });

  // For other mods and tests: NewGamePlus.start(), NewGamePlus.cycle(), NewGamePlus.options.<name>.get()/set()
  window.NewGamePlus = { start, options: opt, cycle: () => ($gameSystem && $gameSystem._ngPlusCycle) || 0 };
})();
