// Scripts run in the browser after the game's plugins load. scope() ties logs and errors to this mod.
// Wrapped in a function because every mod script shares one global scope (a top-level `const mod` would clash with other mods).
(() => {
  const mod = OmoriMod.scope();

  mod.log('loaded');
  mod.on('map:setup', mapId => mod.log('entered map', mapId));

  // hook(target, method, fn): fn gets the original as its first argument. Errors are caught and reported to the Mods panel.
  mod.hook(Game_Party.prototype, 'gainGold', function (orig, amount) {
    return orig(amount);
  });
})();
