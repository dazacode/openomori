// Story scanner: reads every map event and common event of the player's own game and builds an index of the story's
// flags: which switches/variables are set where, which events are gated by them, and which events act as "hubs"
// (an event whose many pages are gated by story switches, i.e. the game's own priority ladder of story positions).
// Used by `bun run mod routes` (a readable report) and by the dev server (/__story.json, for checkpoint coverage).
import { SPINE_SWITCH, PHASE_FLAGS, ENDING_FLAGS, ROUTE_COUNTERS } from '../client/story-model.ts';

export interface ScanSource {
    mapInfos(): any[];
    mapData(id: number): any | null;     // null when the map has no data file
    commonEvents(): any[];
    system(): { switches: (string | null)[]; variables: (string | null)[] };
}

export interface Where { map: number; mapName: string; event: number; eventName: string; page: number }
export interface FlagInfo { id: number; name: string; setters: Where[]; setCount: number; testCount: number; gateCount: number }
export interface Hub { map: number; mapName: string; event: number; eventName: string; ladder: { page: number; needs: string[] }[] }
export interface StoryIndex {
    spine: FlagInfo[];                    // story-block switches in id order
    phase: FlagInfo[];                    // named late-game phase switches
    endings: FlagInfo[];                  // ending switches
    counters: (FlagInfo & { values: number[] })[];  // route counters (variables) with the constants they are set to
    hubs: Hub[];
    mapsScanned: number;
}

const MAX_SETTERS = 6;

export function scanStory(src: ScanSource): StoryIndex {
    const sys = src.system();
    const infos = src.mapInfos();
    const mapName = (id: number) => String(infos[id]?.name ?? `map ${id}`).replace(/^[\s\-❀❈>]+/, '').trim() || `map ${id}`;

    type Acc = { setters: Where[]; set: number; test: number; gate: number; values: Set<number> };
    const sw = new Map<number, Acc>(), vr = new Map<number, Acc>();
    const acc = (m: Map<number, Acc>, id: number) => { let a = m.get(id); if (!a) m.set(id, a = { setters: [], set: 0, test: 0, gate: 0, values: new Set() }); return a; };

    const names = sys.switches.map(n => n ?? '');
    const hubs: Hub[] = [];

    const scanList = (list: any[], where: Where | null) => {
        for (const c of list) {
            const p = c.parameters;
            if (c.code === 121) for (let i = p[0]; i <= p[1]; i++) { const a = acc(sw, i); a.set++; if (where && a.setters.length < MAX_SETTERS) a.setters.push(where); }
            else if (c.code === 122) for (let i = p[0]; i <= p[1]; i++) { const a = acc(vr, i); a.set++; if (p[3] === 0 && p[2] === 0) a.values.add(p[4]); if (where && a.setters.length < MAX_SETTERS) a.setters.push(where); }
            else if (c.code === 111) { if (p[0] === 0) acc(sw, p[1]).test++; else if (p[0] === 1) acc(vr, p[1]).test++; }
        }
    };
    const gates = (pg: any, w: Where) => {
        const c = pg.conditions;
        const needs: string[] = [];
        if (c.switch1Valid) { acc(sw, c.switch1Id).gate++; needs.push(names[c.switch1Id] || `s${c.switch1Id}`); }
        if (c.switch2Valid) { acc(sw, c.switch2Id).gate++; needs.push(names[c.switch2Id] || `s${c.switch2Id}`); }
        if (c.variableValid) { acc(vr, c.variableId).gate++; needs.push(`${sys.variables[c.variableId] || 'v' + c.variableId}>=${c.variableValue}`); }
        return needs;
    };

    src.commonEvents().forEach(e => { if (e) scanList(e.list, null); });
    let scanned = 0;
    for (let id = 1; id < infos.length; id++) {
        const d = src.mapData(id);
        if (!d) continue;
        scanned++;
        for (const ev of d.events as any[]) {
            if (!ev) continue;
            const ladder: Hub['ladder'] = [];
            ev.pages.forEach((pg: any, pi: number) => {
                const w: Where = { map: id, mapName: mapName(id), event: ev.id, eventName: ev.name, page: pi };
                const needs = gates(pg, w);
                scanList(pg.list, w);
                if (needs.length) ladder.push({ page: pi, needs });
            });
            // A hub: many pages, most gated by story switches, and each gate a different one (a priority ladder).
            const storyGated = ladder.filter(l => l.needs.some(n => SPINE_SWITCH.test(n) || PHASE_FLAGS.includes(n) || ENDING_FLAGS.includes(n)));
            if (storyGated.length >= 6 && new Set(storyGated.map(l => l.needs[0])).size >= 5) hubs.push({ map: id, mapName: mapName(id), event: ev.id, eventName: ev.name, ladder: storyGated });
        }
    }

    const info = (id: number, name: string, a: Acc | undefined): FlagInfo => ({ id, name, setters: a?.setters ?? [], setCount: a?.set ?? 0, testCount: a?.test ?? 0, gateCount: a?.gate ?? 0 });
    const swInfo = (id: number) => info(id, names[id] ?? '', sw.get(id));
    const idsWhere = (pred: (n: string) => boolean) => names.map((n, i) => (n && pred(n) ? i : -1)).filter(i => i > 0);
    const varNames = sys.variables.map(n => n ?? '');
    return {
        spine: idsWhere(n => SPINE_SWITCH.test(n)).map(swInfo),
        phase: idsWhere(n => PHASE_FLAGS.includes(n)).map(swInfo),
        endings: idsWhere(n => ENDING_FLAGS.includes(n)).map(swInfo),
        counters: ROUTE_COUNTERS.flatMap(n => { const i = varNames.indexOf(n); if (i < 1) return []; const a = vr.get(i); return [{ ...info(i, n, a), values: [...(a?.values ?? [])].sort((x, y) => x - y) }]; }),
        hubs: hubs.sort((a, b) => b.ladder.length - a.ladder.length),
        mapsScanned: scanned,
    };
}

/** Markdown report for people and agents. */
export function storyReport(ix: StoryIndex): string {
    const w = (x: Where) => `${x.mapName} (map ${x.map}) / "${x.eventName}" p${x.page}`;
    const row = (f: FlagInfo) => `| ${f.id} | ${f.name} | ${f.setCount ? f.setters.slice(0, 2).map(w).join('; ') + (f.setCount > 2 ? ` (+${f.setCount - 2})` : '') : '**never set by an event**'} | ${f.gateCount + f.testCount} |`;
    const table = (rows: FlagInfo[]) => ['| id | name | set by | gates |', '|---|---|---|---|', ...rows.map(row)].join('\n');
    const dead = ix.spine.filter(f => !f.setCount).length;
    return [
        `# Story model (derived from this install; ${ix.mapsScanned} maps scanned)`,
        '',
        `## Spine: the authored story-progress switches (${ix.spine.length}, ${dead} never set by any event)`,
        'Ordered by switch id, which is the order the developers authored the story in. "never set" ones are names reserved for scenes that were cut or are set by scripts/plugins.',
        '',
        table(ix.spine),
        '',
        '## Late-game phase flags',
        table(ix.phase),
        '',
        '## Ending flags',
        table(ix.endings),
        '',
        '## Route counters (variables)',
        '| id | name | assigned values | gates |', '|---|---|---|---|',
        ...ix.counters.map(c => `| ${c.id} | ${c.name} | ${c.values.length ? c.values.join(', ') : '(added to only)'} | ${c.gateCount + c.testCount} |`),
        '',
        `## Hubs: events whose pages form the game's own priority ladder (${ix.hubs.length})`,
        'Later pages win in RPG Maker, so each ladder below lists story positions in the order the game checks them (top = lowest priority).',
        '',
        ...ix.hubs.slice(0, 25).flatMap(h => [`### ${h.mapName} (map ${h.map}) / "${h.eventName}" e${h.event}`, ...h.ladder.map(l => `- p${l.page}: ${l.needs.join(' & ')}`), '']),
    ].join('\n');
}
