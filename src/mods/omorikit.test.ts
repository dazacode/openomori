import { describe, expect, test } from 'bun:test';
import { EVENT_NAMES, lintDialogue, lintSpriteName, parseDialogue, parseMacros, pluginCodes, showMessageRefs, styleTells, textCodes, usageOf } from './omorikit.ts';

const macros = new Map([['kel', '\\n<KEL>'], ['mar', '\\n<MARI>']]);
const noFaces = () => false;

describe('dialogue parsing', () => {
    test('a single backslash inside double quotes is a YAML error, with the fix named', () => {
        const { doc, findings } = parseDialogue('message_0:\n    text: "a\\!b"\n', 'x.yml');
        expect(doc).toBeNull();
        expect(findings[0]!.level).toBe('error');
        expect(findings[0]!.message).toContain('\\\\!');
    });
    test('the same text is fine with doubled backslashes or single quotes', () => {
        expect(parseDialogue('message_0:\n    text: "a\\\\!b"\n', 'x.yml').findings).toEqual([]);
        expect(parseDialogue("message_0:\n    text: 'a\\!b'\n", 'x.yml').findings).toEqual([]);
    });
    test('duplicate keys are reported', () => {
        expect(parseDialogue('message_0:\n  text: a\nmessage_0:\n  text: b\n', 'x.yml').findings[0]!.level).toBe('error');
    });
});

describe('dialogue lint', () => {
    const lint = (src: string, faceExists = noFaces) => {
        const { doc } = parseDialogue(src, 'x.yml');
        return lintDialogue(doc!, 'x.yml', { macros, faceExists });
    };
    test('a clean entry has no findings', () => {
        expect(lint("message_0:\n  text: 'Hello.\\!'\n")).toEqual([]);
    });
    test('missing text is an error', () => {
        expect(lint('message_0:\n  faceset: A\n  faceindex: 0\n').some(f => f.level === 'error' && f.message.includes('missing text'))).toBe(true);
    });
    test('faceindex must be a whole number', () => {
        expect(lint("message_0:\n  text: a\n  faceset: A\n  faceindex: 1.5\n", () => true).some(f => f.level === 'error')).toBe(true);
    });
    test('faceset without faceindex is a warning, and a missing face image is a warning', () => {
        const f = lint("message_0:\n  text: a\n  faceset: NOPE\n  faceindex: 0\n");
        expect(f.some(x => x.level === 'warn' && x.message.includes('NOPE'))).toBe(true);
        expect(lint('message_0:\n  text: a\n  faceset: A\n', () => true).some(x => x.message.includes('faceset and faceindex'))).toBe(true);
    });
    test('background and position are range-checked', () => {
        expect(lint('message_0:\n  text: a\n  background: 3\n').some(x => x.level === 'error')).toBe(true);
        expect(lint('message_0:\n  text: a\n  position: 2\n  background: 2\n')).toEqual([]);
    });
    test('unknown text codes warn; macros and a bracket code are accepted; a macro can run into text', () => {
        expect(lint("message_0:\n  text: '\\\\zzz'\n").some(x => x.level === 'warn')).toBe(false); // a doubled backslash is a literal, not a code
        expect(lint("message_0:\n  text: '\\zzz'\n").some(x => x.message.includes('\\zzz'))).toBe(true);
        expect(lint("message_0:\n  text: '\\kelHey \\SINV[1]hi\\!'\n")).toEqual([]);
    });
    test('keys with spaces are reported because ShowMessage cannot reference them', () => {
        expect(lint("message 1:\n  text: a\n").some(x => x.level === 'warn')).toBe(true);
    });
});

describe('text codes', () => {
    test('finds punctuation codes, word codes and bracket arguments', () => {
        expect(textCodes('\\!a\\QUAKE[1]b\\n<X>\\{').map(c => c.code)).toEqual(['\\!', '\\QUAKE[1]', '\\n', '\\{']);
    });
});

describe('macros and plugin codes', () => {
    test('parses macro names and texts from js/plugins.js', () => {
        const pluginsJs = 'var $plugins =\n[\n{"name":"YEP_X_MessageMacros1","status":true,"description":"","parameters":{"Macro 1 Name":"kel","Macro 1 Text":"\\\\n<KEL>","Macro 2 Name":"undefined","Macro 2 Text":"undefined"}},\n{"name":"Other","status":true,"parameters":{"Macro 1 Name":"nope","Macro 1 Text":"x"}}\n]';
        const m = parseMacros(pluginsJs);
        expect([...m.keys()]).toEqual(['kel']);
        expect(m.get('kel')).toBe('\\n<KEL>');
    });
    test('plugin text codes come from upper-case case labels, plus fn', () => {
        const codes = pluginCodes("switch (code) {\n case 'DII': break;\n case 'ITEMGET': break;\n case 'center': break;\n}");
        expect(codes.has('dii') && codes.has('itemget') && codes.has('fn')).toBe(true);
        expect(codes.has('center')).toBe(false);
    });
});

describe('sprite names', () => {
    test('valid markers pass', () => {
        expect(lintSpriteName('$FA_OMORI_RUN%(8).png', { width: 96, height: 32 })).toEqual([]);
        expect(lintSpriteName('!objects_fa_doors.png')).toEqual([]);
        expect(lintSpriteName('[SF]SW_Hole.png')).toEqual([]);
    });
    test('frames that do not divide the width warn; a zero frame count is an error', () => {
        expect(lintSpriteName('X%(8).png', { width: 100, height: 32 })[0]!.level).toBe('warn');
        expect(lintSpriteName('X%(0).png')[0]!.level).toBe('error');
    });
    test('an unknown marker warns', () => {
        expect(lintSpriteName('weird(name).png').length).toBe(1);
    });
});

describe('ShowMessage references and usage', () => {
    test('finds file.key references in any text', () => {
        expect(showMessageRefs('{"code":356,"parameters":["ShowMessage XX_GENERAL.message_4"]} ShowMessage a_b.message_1')).toEqual([{ file: 'XX_GENERAL', key: 'message_4' }, { file: 'a_b', key: 'message_1' }]);
    });
    test('counts plugin commands, script heads and codes', () => {
        const u = usageOf([[{ code: 356, parameters: ['ShowMessage a.message_1'] }, { code: 356, parameters: ['ShowMessage a.message_2'] }, { code: 355, parameters: ['$gameVariables.setValue(3, 4);'] }]]);
        expect(u.plugin.get('ShowMessage')!.count).toBe(2);
        expect(u.script.get('$gameVariables.setValue(N, N);')).toBe(1);
        expect(u.codes.get(356)).toBe(2);
    });
    test('event codes used by the wrapper have names', () => {
        expect(EVENT_NAMES[356]).toBe('plugin command');
    });
});

describe('style tells (anti-slop)', () => {
    test('flags over-used machine phrases, ignoring text codes', () => {
        expect(styleTells('We must delve into the tapestry.')).toEqual(['delve', 'tapestry']);
        expect(styleTells("It is important to note, \\QUAKE[1]that\\QUAKE[0] you left.")).toEqual(['it is important to note']);
    });
    test('ordinary lines pass', () => {
        expect(styleTells('......you left.\\!')).toEqual([]);
    });
    test('the lint reports a style warning for a flagged line', () => {
        const { doc } = parseDialogue("message_0:\n  text: 'Let us delve in.'\n", 'x.yml');
        expect(lintDialogue(doc!, 'x.yml', { macros: new Map(), faceExists: () => true }).some(f => f.level === 'warn' && f.message.includes('delve'))).toBe(true);
    });
});

describe('cross-mod checks (map ids and MapInfos)', () => {
    const { crossModFindings } = require('./omorikit-node.ts');
    test('the same map id in two mods is an error', () => {
        const f = crossModFindings([{ label: 'a', ids: new Set([1300]), registryAdds: [] }, { label: 'b', ids: new Set([1300]), registryAdds: [] }]);
        expect(f.some((x: any) => x.level === 'error' && x.message.includes('1300'))).toBe(true);
    });
    test('two mods extending MapInfos above 999 is an error; one mod is fine', () => {
        const two = crossModFindings([{ label: 'a', ids: new Set(), registryAdds: [1000, 1001] }, { label: 'b', ids: new Set(), registryAdds: [1000] }]);
        expect(two.some((x: any) => x.level === 'error' && x.message.includes('MapInfos'))).toBe(true);
        expect(crossModFindings([{ label: 'a', ids: new Set(), registryAdds: [1000] }])).toEqual([]);
    });
    test('distinct ids and no registry changes pass', () => {
        expect(crossModFindings([{ label: 'a', ids: new Set([1300]), registryAdds: [] }, { label: 'b', ids: new Set([1301]), registryAdds: [] }])).toEqual([]);
    });
});
