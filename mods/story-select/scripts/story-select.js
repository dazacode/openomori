/// <reference path="../../../types/omori-mod.d.ts" />
// Story select: Settings > Mods > "Story select" picks a day and scene, "Go" starts a fresh game state at that point.
//
// OMORI has no chapter variable. Progress is a run of named story switches (docs/STORY-MODEL.md), so a "part" here is
//   1. the story switches that are already done at that point (ORDER below, up to and including `after`),
//   2. the world and party, by running the developers' own common events (14-17 Faraway, 18/19/22 Headspace),
//   3. a level for the Headspace party,
//   4. a spawn tile next to the scene (moved to the nearest free tile if that one is blocked).
// Flags are looked up by NAME, so a changed build still works; a name that is missing is logged, not fatal.
// Self-switches, items and the exact party of a real playthrough are not reproduced: a jump is a good approximation, not a save.
(() => {
  const mod = OmoriMod.scope();

  // The story in the order it is played. A part switches on everything up to and including its `after` entry.
  // Day 0 is a best reading of the developers' scene ladders; Days 1 to 3 follow the authored switch order.
  const ORDER = [
    // Day 0, Headspace
    'Day0DW-Basil and Mari', 'Day0DW-Halt Children', 'Day0DW - Space Boyfriend', 'Day0DW - Otherworld Ladder',
    'Day0DW - Mixtape', 'Day0DW - Missing Pluto', 'Day0DW - Capt. Spaceboy', 'Day0DW - Blackletters ABCE',
    'Day0DW - Basil Gets Kidnapped', 'Day0DW - Basil is Missing', 'Day0DW - Hangman I', 'Day0DW - Hangman II',
    // Day 0, Faraway night
    "Day0FA - Mother's Mail", 'Day0FA - Ate the Steak', 'Day0FA - Throw Up', 'NiFA - Mari Visits',
    // Day 1, Faraway
    'Day1FA - Hobbeez', 'Day1FA - GIFT', 'Day1FA - Fake Knife Fight', 'Day1FA - Stolen Photo Album', 'Day1FA - Find Maverick',
    'Day1FA - Search for Kim', 'Day1FA - Exit Candy Shop', 'Day1FA - Go to Church',
    'SunFA1 - Aubrey leaves Church', 'SunFA1 - Photo album', 'SunFA1 - Grandmas Room', 'SunFA1 - Basil Bathroom',
    'SunFA1 - Something behind you', 'NiFA1 - Go to Player home',
    // Day 1, Headspace
    'Day0FA - Fear of Heights', 'NiFA-FearofSpiders', 'Day1DW - Kel Joins', 'Day1DW - Bachelor Stage', 'Day1DW - Sprout Power',
    'Day1DW - Power is on', 'Day1DW - Hero left', 'Day1DW - EscapeTheDungeon', 'Day1DW - SW Wedding',
    'Day1DW - Capt. Spaceboy', 'Day1DW - Hidden Library', 'Day0DW-FearofDrowning',
    // Day 2, Faraway
    'Day2FA - Errand List', 'Day2FA - We Got the Stuff', "Day2FA - Dropping off Stuff at Kel's", "Day2FA - Kel's Bedroom",
    "Day2FA - Polly's Worry", "Day2FA - Basil's Scream", 'SunFA2 - Too Far', 'SunFA2 - Local Hero', 'SunFA2 - Drop off Basil',
    'NiFA2 - Sleepover',
    // Day 2, Headspace
    'Day2DW - Swim', 'Day2DW - Lost Child', 'Day2DW - GotoBathroom', 'Day2DW - AubreySecretary', 'Day2DW - JawsumReq',
    'Day2DW - It Lives!', "Day2DW - She's Perfect!", 'Day2DW - Slime Girls', 'Day2DW - Visit Basil', 'Day2DW - Saved Basil?',
    // Day 3
    'Day3FA - Goodbye PLAYER', "Day3FA - Hero's Breakfast",
  ];

  // Party common events from the game's own data (CommonEvents.json). They set the world, the item container and who follows.
  const PARTY = {
    sunny: 14,         // FA -> PLAYER
    sunnyKel: 15,      // FA -> P_K
    sunnyKelHero: 16,  // FA -> P_K_H
    sunnyAll: 17,      // FA -> EVERYONE
    omori: 18,         // DW -> OMORI
    omoriKel: 19,      // DW -> O_K
    omoriAll: 22,      // DW -> EVERYONE
  };

  // One row per part. [map, x, y] is the tile next to the scene; `after` = last finished beat in ORDER ('' = none);
  // `also` = extra switches (phase flags); `lv` = Headspace party level; `drop` = actors that have left the party.
  const G = {
    d0h: 'DAY 0 · HEADSPACE', d0f: 'DAY 0 · FARAWAY',
    d1f: 'DAY 1 · FARAWAY', d1n: 'DAY 1 · SUNSET AND NIGHT', d1h: 'DAY 1 · HEADSPACE',
    d2f: 'DAY 2 · FARAWAY', d2h: 'DAY 2 · HEADSPACE',
    d3: 'DAY 3', end: 'THE FINAL ACT',
  };
  const PARTS = [
    // Day 0
    { id: 'd0-white', g: G.d0h, l: 'White Space: waking up', at: [87, 28, 27], p: 'omori', lv: 1, after: '' },
    { id: 'd0-forest', g: G.d0h, l: 'Vast Forest: Basil and Mari', at: [92, 21, 11], p: 'omoriAll', lv: 1, after: '' },
    { id: 'd0-camp', g: G.d0h, l: 'Otherworld: "Halt, Children!"', at: [124, 17, 18], p: 'omoriAll', lv: 2, after: 'Day0DW-Basil and Mari' },
    { id: 'd0-ladder', g: G.d0h, l: 'Otherworld: the ladder', at: [117, 32, 30], p: 'omoriAll', lv: 3, after: 'Day0DW - Space Boyfriend' },
    { id: 'd0-sbf', g: G.d0h, l: "Space Boyfriend's house", at: [126, 19, 15], p: 'omoriAll', lv: 3, after: 'Day0DW - Otherworld Ladder' },
    { id: 'd0-pluto', g: G.d0h, l: 'Solar System: missing Pluto', at: [127, 42, 11], p: 'omoriAll', lv: 4, after: 'Day0DW - Mixtape' },
    { id: 'd0-night', g: G.d0f, l: 'Home at night: mother, the steak', at: [78, 21, 66], p: 'sunny', lv: 5, after: 'Day0DW - Hangman II' },
    // Day 1
    { id: 'd1-hobbeez', g: G.d1f, l: 'Hobbeez', at: [58, 10, 9], p: 'sunnyKel', lv: 5, after: 'Day0FA - Throw Up' },
    { id: 'd1-park', g: G.d1f, l: 'Park: the fake knife fight', at: [63, 32, 27], p: 'sunnyKel', lv: 5, after: 'Day1FA - GIFT' },
    { id: 'd1-basil', g: G.d1f, l: "Basil's street: the stolen photo album", at: [45, 11, 10], p: 'sunnyKel', lv: 5, after: 'Day1FA - Fake Knife Fight' },
    { id: 'd1-maverick', g: G.d1f, l: 'Park: finding Maverick', at: [63, 46, 22], p: 'sunnyKel', lv: 5, after: 'Day1FA - Stolen Photo Album' },
    { id: 'd1-kim', g: G.d1f, l: 'Shopping center: Kim and Vance', at: [55, 26, 16], p: 'sunnyKel', lv: 5, after: 'Day1FA - Exit Candy Shop' },
    { id: 'd1-church', g: G.d1f, l: "Church: Aubrey", at: [41, 14, 23], p: 'sunnyKel', lv: 5, after: 'Day1FA - Go to Church' },
    { id: 'd1-photo', g: G.d1n, l: "Aubrey's street: the photo album", at: [31, 44, 51], p: 'sunnyKel', lv: 5, after: 'SunFA1 - Aubrey leaves Church' },
    { id: 'd1-basilhouse', g: G.d1n, l: "Basil's house at sunset", at: [50, 20, 28], p: 'sunny', lv: 5, after: 'SunFA1 - Basil Bathroom' },
    { id: 'd1-home', g: G.d1n, l: 'Heading home for the night', at: [50, 48, 23], p: 'sunny', lv: 5, after: 'SunFA1 - Something behind you' },
    { id: 'd1-room', g: G.d1h, l: "Neighbour's room: Kel joins", at: [88, 15, 22], p: 'omori', lv: 8, after: 'NiFA-FearofSpiders' },
    { id: 'd1-castle', g: G.d1h, l: "Sweetheart's Castle", at: [171, 11, 26], p: 'omoriAll', lv: 10, after: 'Day1DW - Kel Joins' },
    { id: 'd1-sprout', g: G.d1h, l: 'Sprout Mole Town: the power', at: [166, 27, 34], p: 'omoriAll', lv: 11, after: 'Day1DW - Sprout Power' },
    { id: 'd1-wedding', g: G.d1h, l: "Sweetheart's wedding", at: [171, 55, 4], p: 'omoriAll', drop: [4], lv: 13, after: 'Day1DW - Hero left' },
    // Day 2
    { id: 'd2-morning', g: G.d2f, l: 'Morning: the errand list', at: [14, 49, 29], p: 'sunny', lv: 14, after: 'Day0DW-FearofDrowning' },
    { id: 'd2-gino', g: G.d2f, l: "Errands: Gino's Diner", at: [57, 8, 9], p: 'sunny', lv: 14, after: 'Day2FA - Errand List' },
    { id: 'd2-kel', g: G.d2f, l: "Kel and Hero's house", at: [15, 49, 27], p: 'sunnyKel', lv: 14, after: 'Day2FA - We Got the Stuff' },
    { id: 'd2-kelroom', g: G.d2f, l: "Kel's bedroom", at: [15, 24, 17], p: 'sunnyKelHero', lv: 14, after: "Day2FA - Dropping off Stuff at Kel's" },
    { id: 'd2-park', g: G.d2f, l: "Park at sunset: Polly's worry", at: [73, 42, 12], p: 'sunnyKelHero', lv: 14, after: "Day2FA - Kel's Bedroom" },
    { id: 'd2-lake', g: G.d2f, l: 'Secret Lake', at: [74, 13, 31], p: 'sunnyKelHero', lv: 14, after: "Day2FA - Basil's Scream" },
    { id: 'd2-dropoff', g: G.d2f, l: 'Dropping off Basil', at: [50, 25, 25], p: 'sunnyKelHero', lv: 14, after: 'SunFA2 - Local Hero' },
    { id: 'd2-sleepover', g: G.d2f, l: 'Night: the sleepover', at: [78, 24, 67], p: 'sunny', lv: 14, after: 'SunFA2 - Drop off Basil' },
    { id: 'd2-coast', g: G.d2h, l: 'North Coast: swimming', at: [90, 9, 7], p: 'omoriAll', lv: 15, after: 'NiFA2 - Sleepover' },
    { id: 'd2-casino', g: G.d2h, l: 'Last Resort: the casino', at: [194, 22, 10], p: 'omoriAll', lv: 18, after: 'Day2DW - Lost Child' },
    { id: 'd2-concierge', g: G.d2h, l: 'Last Resort: the concierge', at: [195, 7, 8], p: 'omoriAll', lv: 19, after: 'Day2DW - GotoBathroom' },
    { id: 'd2-jawsum', g: G.d2h, l: "Jawsum's office", at: [196, 15, 22], p: 'omoriAll', lv: 20, after: 'Day2DW - AubreySecretary' },
    { id: 'd2-marina', g: G.d2h, l: 'Marina', at: [227, 15, 17], p: 'omoriAll', lv: 21, after: 'Day2DW - JawsumReq' },
    { id: 'd2-medusa', g: G.d2h, l: 'Medusa', at: [234, 11, 14], p: 'omoriAll', lv: 22, after: 'Day2DW - It Lives!' },
    { id: 'd2-humphrey', g: G.d2h, l: 'Humphrey', at: [249, 14, 31], p: 'omoriAll', lv: 24, after: "Day2DW - She's Perfect!" },
    { id: 'd2-shoe', g: G.d2h, l: "The Old Shoe: Basil", at: [98, 10, 9], p: 'omoriAll', lv: 25, after: 'Day2DW - Slime Girls' },
    // Day 3
    { id: 'd3-mari', g: G.d3, l: 'Path to Basil: Mari says goodbye', at: [96, 11, 25], p: 'sunny', lv: 26, after: 'Day2DW - Saved Basil?' },
    { id: 'd3-breakfast', g: G.d3, l: "Morning: Hero's breakfast", at: [14, 44, 21], p: 'sunny', lv: 26, after: 'Day3FA - Goodbye PLAYER' },
    // The end
    { id: 'end-something', g: G.end, l: 'Something: the battle stage', at: [309, 11, 9], p: 'omoriAll', lv: 30, after: "Day3FA - Hero's Breakfast", also: ['[Something Battle]'] },
    { id: 'end-memories', g: G.end, l: "Basil's memories: the recital stage", at: [381, 14, 11], p: 'omoriAll', lv: 32, after: "Day3FA - Hero's Breakfast", also: ['[Something Battle]', '[Basil Memories]'] },
    { id: 'end-castle', g: G.end, l: "Omori's castle", at: [435, 41, 46], p: 'omoriAll', lv: 35, after: "Day3FA - Hero's Breakfast", also: ['[Blackspace]', "[Omori's Castle]"] },
    { id: 'end-home', g: G.end, l: 'The childhood home', at: [378, 49, 29], p: 'omoriAll', lv: 35, after: "Day3FA - Hero's Breakfast", also: ['[Blackspace]', '[Final Memories]'] },
    { id: 'end-epilogue', g: G.end, l: 'Epilogue: the Vast Forest', at: [92, 21, 9], p: 'omoriAll', lv: 35, after: "Day3FA - Hero's Breakfast", also: ['[Neutral: Epilogue]'] },
  ];

  // --- jumping ----------------------------------------------------------------------------------
  const norm = (s) => String(s || '').trim();
  const switchId = (name) => { const sw = $dataSystem.switches; for (let i = 1; i < sw.length; i++) if (norm(sw[i]) === name) return i; return 0; };

  /** Every switch name that is done at this part. */
  function flagsFor(part) {
    const names = [];
    if (part.after) {
      const at = ORDER.indexOf(part.after);
      if (at < 0) mod.warn(`story-select: "${part.after}" is not in the story order`);
      else names.push(...ORDER.slice(0, at + 1));
    }
    names.push(...(part.also || []));
    return names;
  }

  let pending = null;   // the part being jumped to, consumed when its map has loaded

  // The reset happens in a scene of its own: resetting the game objects under a running map scene crashes it (it keeps
  // updating against the empty map for a frame). The map scene leaves first, this one rebuilds the state, then Scene_Map starts.
  function Scene_StoryJump() { this.initialize.apply(this, arguments); }
  Scene_StoryJump.prototype = Object.create(Scene_Base.prototype);
  Scene_StoryJump.prototype.constructor = Scene_StoryJump;
  Scene_StoryJump.prototype.start = function () {
    Scene_Base.prototype.start.call(this);
    const part = pending;
    try { setup(part); } catch (e) { mod.warn('story-select: ' + e.message); pending = null; SceneManager.goto(Scene_OmoriTitleScreen); return; }
    SceneManager.goto(Scene_Map);
  };

  async function jump(part) {
    // keep whatever the player was doing: a checkpoint (Debug panel F9 > checkpoints) comes first
    try {
      if (window.$gameParty && window.$gameMap && SceneManager._scene instanceof Scene_Map) await OmoriMod.checkpoints.capture(`(auto) before story select: ${part.l}`);
    } catch (e) { mod.warn('story-select: no safety checkpoint: ' + e.message); }
    // stop the running cutscene, or its list carries on over the new map
    if (window.$gameMap && $gameMap._interpreter) $gameMap._interpreter.clear();
    if (window.$gameMessage) $gameMessage.clear();

    pending = part;
    SceneManager.goto(Scene_StoryJump);
  }

  /** A fresh game state at this part: switches, then the transfer (the party and level follow once the map has loaded). */
  function setup(part) {
    DataManager.setupNewGame();
    const missing = [];
    for (const name of flagsFor(part)) {
      const id = switchId(name);
      if (id) $gameSwitches.setValue(id, true); else missing.push(name);
    }
    if (missing.length) mod.warn(`story-select: no switch named ${missing.map(n => `"${n}"`).join(', ')}`);
    const [map, x, y] = part.at;
    $gamePlayer.reserveTransfer(map, x, y, 2, 0);
  }

  /** The nearest tile to (x, y) the player can stand on (the first one if it is free). */
  function freeTile(x, y) {
    const standable = (tx, ty) => $gameMap.isValid(tx, ty) && [2, 4, 6, 8].some(d => $gameMap.isPassable(tx, ty, d)) && !$gamePlayer.isCollidedWithEvents(tx, ty);
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (standable(x + dx, y + dy)) return [x + dx, y + dy];
        }
      }
    }
    return [x, y];
  }

  mod.hook(Scene_Map.prototype, 'onMapLoaded', function (orig, ...a) {
    const r = orig.apply(this, a);
    const part = pending;
    if (part && $gameMap.mapId() === part.at[0]) {
      pending = null;
      const [fx, fy] = freeTile(part.at[1], part.at[2]);
      if (fx !== $gamePlayer.x || fy !== $gamePlayer.y) $gamePlayer.locate(fx, fy);
      // world, party and item container: the developers' own common event
      $gameTemp.reserveCommonEvent(PARTY[part.p]);
      for (const id of part.drop || []) $gameParty.removeActor(id);
      for (const id of [1, 2, 3, 4]) { const ac = $gameActors.actor(id); if (ac && part.lv) { ac.changeLevel(part.lv, false); ac.recoverAll(); } }
    }
    return r;
  });

  // --- the menu ---------------------------------------------------------------------------------
  const options = PARTS.map(p => ({ value: p.id, label: p.l, group: p.g }));
  try {
    const pick = mod.settings.add({ id: 'part', type: 'choice', label: 'Story select', default: PARTS[0].id, options,
      help: 'Pick a day and scene, then press Go. Your current game is saved as an automatic checkpoint first (F9 > checkpoints).' });
    mod.settings.add({ id: 'go', type: 'action', label: 'Story select: jump there now', button: 'Go',
      run: () => {
        const part = PARTS.find(p => p.id === pick.get()) || PARTS[0];
        void jump(part).then(() => {
          // close Settings (OpenOMORI's panel toggles on F10) so the scene plays straight away
          setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true })), 50);
        });
      } });
  } catch (e) { mod.warn('story-select: settings unavailable: ' + e.message); }

  // for tests and other mods: OmoriMod.storySelect.parts / .jump(id)
  OmoriMod.storySelect = { parts: PARTS, order: ORDER, jump: (id) => jump(PARTS.find(p => p.id === id)) };
})();
