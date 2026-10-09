/// <reference path="../../../types/omori-mod.d.ts" />
// Runs in the browser after the game's plugins load.
// Everything is inside a function: all mods' scripts share one global scope.
(() => {
  const mod = OmoriMod.scope();
  mod.log('hello from story-demo');
  mod.on('map:setup', mapId => mod.log('entered map', mapId));
})();
