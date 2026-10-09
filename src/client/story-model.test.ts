import { describe as suite, expect, test } from 'bun:test';
import type { Digest } from './checkpoint-core.ts';
import { coverage, describe, routeKey, routeLabel, signature, SPINE_SWITCH } from './story-model.ts';

const sn = ['', 'Day1FA - Hobbeez', 'Day2DW - Saved Basil?', '[Something Battle]', '[Neutral: Epilogue]', '[True: Stab End]', 'NiFA-FearofSpiders', 'Day 3 vending machine', 'Day2DW - RESERVED'];
const vn = ['', 'World Value (WS/FA/DW/BS)', '[BS_TRUE_PATH]', '[BS_NEUTRAL_PATH]', 'BASIL_END', 'Stab_Counter', 'Unrelated'];
const db = { switches: sn, variables: vn };
const dig = (switches: number[], variables: Record<number, number> = {}): Digest =>
    ({ switches, variables, selfSwitches: {}, selfVariables: {}, gold: 0, items: {}, weapons: {}, armors: {}, party: [], levels: {}, map: { id: 1, x: 0, y: 0 } });

suite('story model', () => {
    test('spine pattern matches the authored names and nothing else', () => {
        for (const ok of ['Day0DW-', 'Day2DW - Saved Basil?', 'NiFA-FearofSpiders', 'NiFA1 - Go to Player home', 'SunFA2 - Drop off Basil', "Day3FA - Hero's Breakfast"]) expect(SPINE_SWITCH.test(ok)).toBe(true);
        for (const no of ['Day 3 vending machine', 'Day 2: DUET', '[Blackspace]', 'Voicemail Day 1', '']) expect(SPINE_SWITCH.test(no)).toBe(false);
    });
    test('signature finds the furthest beat, phases, endings and counters', () => {
        const s = signature(dig([1, 2, 3, 6, 7], { 1: 3, 3: 5, 6: 99 }), db);
        expect(s.last).toEqual({ id: 6, name: 'NiFA-FearofSpiders' });
        expect(s.spineOn).toBe(3);                 // 1, 2, 6 (7 is not a spine switch)
        expect(s.savedBasil).toBe(true);
        expect(s.phase).toEqual(['[Something Battle]']);
        expect(s.world).toBe('BS');
        expect(s.counters).toEqual({ '[BS_NEUTRAL_PATH]': 5 });   // unrelated variables are ignored
    });
    test('route label follows the devs flag names', () => {
        expect(routeLabel(signature(dig([1]), db))).toBe('undecided');
        expect(routeLabel(signature(dig([1], { 2: 4 }), db))).toBe('true');
        expect(routeLabel(signature(dig([1], { 3: 2 }), db))).toBe('neutral');
        expect(routeLabel(signature(dig([5]), db))).toBe('true');
        expect(routeLabel(signature(dig([4]), db))).toBe('neutral');
        expect(routeLabel(signature(dig([4, 5]), db))).toBe('true');          // a true ending outranks a neutral flag
    });
    test('route key ignores progress along the spine but not decisions', () => {
        const early = signature(dig([1]), db), later = signature(dig([1, 6]), db), saved = signature(dig([1, 2]), db);
        expect(routeKey(early)).toBe(routeKey(later));
        expect(routeKey(early)).not.toBe(routeKey(saved));
        expect(routeKey(signature(dig([1], { 4: 2 }), db))).not.toBe(routeKey(early));   // BASIL_END differs
    });
    test('describe is short and readable', () => {
        expect(describe(signature(dig([]), db))).toBe('start');
        expect(describe(signature(dig([2], { 2: 7 }), db))).toBe('Day2DW - Saved Basil? · true route · BS_TRUE_PATH 7');
    });
    test('coverage counts recorded beats, ignoring the [beat] prefix and non-beats', () => {
        const c = coverage(['[beat] Day1FA - Hobbeez', 'my own checkpoint', '[beat] [Blackspace]'], ['Day1FA - Hobbeez', 'Day2DW - Swim', '[Blackspace]']);
        expect(c).toEqual({ recorded: 2, total: 3, missing: ['Day2DW - Swim'] });
    });
});
