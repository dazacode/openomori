import './shim/index.ts'; // side effects first: defines require/process/nw before any game code
import { boot } from './boot.ts';

boot().catch(e => {
    document.body.style.cssText = 'background:#000;color:#fff;font:14px monospace;white-space:pre-wrap;padding:16px';
    document.body.textContent = e instanceof Error ? e.stack ?? e.message : String(e);
});
