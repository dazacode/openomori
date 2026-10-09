import { describe, expect, test } from 'bun:test';
import { GAME_DIR, isGameDir } from '../gamedir.ts';
import { scanStory, storyReport, type ScanSource, type StoryIndex } from './storyscan.ts';

const cond = (o: Record<string, unknown> = {}) => ({ switch1Valid: false, switch1Id: 1, switch2Valid: false, switch2Id: 1, variableValid: false, variableId: 1, variableValue: 0, ...o });
const page = (conditions = cond(), list: any[] = []) => ({ conditions, list });
const SW = ['', 'Day1FA - A', 'Day1FA - B', 'Day1FA - C', 'Day1FA - D', 'Day1FA - E', 'Day1FA - F', '[Blackspace]', '[True: Bad End]', 'Day2DW - never set'];
const VAR = ['', '[BS_TRUE_PATH]'];
const set = (id: number) => ({ code: 121, indent: 0, parameters: [id, id, 0] });
const src: ScanSource = {
    mapInfos: () => [null, { id: 1, name: ' -- HOME' }],
    system: () => ({ switches: SW, variables: VAR }),
    commonEvents: () => [null, { id: 1, name: 'ce', list: [{ code: 122, indent: 0, parameters: [1, 1, 0, 0, 7] }] }],
    mapData: id => id !== 1 ? null : { events: [null,
        { id: 1, name: 'DOOR', pages: [1, 2, 3, 4, 5, 6].map(i => page(cond({ switch1Valid: true, switch1Id: i }), [set(i === 6 ? 7 : i)])) },
        { id: 2, name: 'plain', pages: [page(), page()] },
    ] },
};

describe('story scan (fake game)', () => {
    const ix = scanStory(src);
    test('finds spine, phase and ending flags with setters', () => {
        expect(ix.spine.map(f => f.name)).toEqual(['Day1FA - A', 'Day1FA - B', 'Day1FA - C', 'Day1FA - D', 'Day1FA - E', 'Day1FA - F', 'Day2DW - never set']);
        expect(ix.spine[0]!.setters[0]).toMatchObject({ mapName: 'HOME', eventName: 'DOOR' });
        expect(ix.spine[6]!.setCount).toBe(0);
        expect(ix.phase.map(f => f.name)).toEqual(['[Blackspace]']);
        expect(ix.endings.find(f => f.name === '[True: Bad End]')!.setCount).toBe(0);
    });
    test('records constants assigned to route counters', () => {
        expect(ix.counters.find(c => c.name === '[BS_TRUE_PATH]')!.values).toEqual([7]);
    });
    test('detects a hub: many pages, each gated by a different story switch', () => {
        expect(ix.hubs.map(h => h.eventName)).toEqual(['DOOR']);
        expect(ix.hubs[0]!.ladder).toHaveLength(6);
    });
    test('report is markdown and calls out flags nothing sets', () => {
        const r = storyReport(ix);
        expect(r).toContain('## Hubs');
        expect(r).toContain('**never set by an event**');
    });
});

// Against the real install (skipped when it is not there). The scan is lazy: Bun still runs the body of a skipped describe().
describe.skipIf(!isGameDir(GAME_DIR))('story scan (real game)', () => {
    let cached: StoryIndex | undefined;
    const real = async () => (cached ??= (await import('./mapkit-node.ts')).storyIndex());

    test('the story spine and its known hubs are found', async () => {
        const ix = await real();
        expect(ix.spine.length).toBeGreaterThan(80);
        expect(ix.spine.some(f => f.name === 'Day2DW - Saved Basil?' && f.setCount > 0)).toBe(true);
        expect(ix.hubs.some(h => h.eventName.startsWith('BED') && h.mapName.includes('PLAYER'))).toBe(true);
    }, 60000);
    test('[True: Bad End] is tested but never set; the endings and route counters exist', async () => {
        const ix = await real();
        const bad = ix.endings.find(f => f.name === '[True: Bad End]')!;
        expect(bad.setCount).toBe(0);
        expect(bad.testCount + bad.gateCount).toBeGreaterThan(5);
        expect(ix.counters.map(c => c.name)).toEqual(expect.arrayContaining(['[BS_TRUE_PATH]', '[BS_NEUTRAL_PATH]', 'Stab_Counter', 'BASIL_END']));
    }, 60000);
});
