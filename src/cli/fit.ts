// Long lines folded by the CLI itself (issue 32): a terminal folds a line at its very edge,
// in the middle of a word and back to the first column, which breaks the columns of the
// screen. Here a line is folded at a space, and its rest goes on lines of its own under where
// its text starts.

// A piece of a line and its SGR style; '' is no style.
export type Segment = [text: string, style: string];

const len = (text: string): number => [...text].length;

// Where the rest of a folded line starts: after a leading column that ends in two spaces (the
// time of a journal line), or else after the line's indent and its marks (▸, ●, !, ☑, ☐).
function hangOf(line: Segment[], width: number): number {
  const [first] = line;
  if (first && first[0].endsWith('  ') && first[0].trim() && len(first[0]) <= width / 2) return len(first[0]);
  const plain = line.map(([text]) => text).join('');
  const hang = len(/^(?:[ ▸●!☑☐] ?)*/u.exec(plain)?.[0] ?? '');
  return hang <= width / 2 ? hang : 0;
}

// The line as lines no longer than width, each segment keeping its style. A word longer than
// a line (a link) folds after a «/» or a «-», or else where the line ends.
export function fit(line: Segment[], width: number): Segment[][] {
  const chars = line.flatMap(([text, style]) => [...text].map(char => ({ char, style })));
  if (chars.length <= width || width < 2) return [line];
  const hang = hangOf(line, width);
  const list = chars.map(({ char }) => char).join('').split(' · ').length > 3;
  const rows: (typeof chars)[] = [];
  let rest = chars;
  while (rest.length) {
    const room = rows.length ? width - hang : width;
    if (rest.length <= room) {
      rows.push(rest);
      break;
    }
    // The last space that fits ends the row, unless all that would go on is a scrap (the unit
    // of «0,7 s»); in a list (a hint: three « · » or more) a space after a «·» in the second
    // half goes first, so «r refresh» stays whole. The spaces at the fold are dropped.
    const fits = (i: number) => rest[i]?.char === ' ' && rest.length - i > 4;
    let cut = -1;
    if (list) for (let i = room; i > room / 2; i--) if (fits(i) && rest[i - 1]?.char === '·') { cut = i; break; }
    for (let i = room; cut < 0 && i > 0; i--) if (fits(i)) cut = i;
    // A link with no space in reach folds after a «/» in its second half, or else a «-».
    for (const mark of ['/', '-']) {
      if (cut > (rows.length ? 0 : hang)) break;
      cut = -1;
      for (let i = room; i > room / 2; i--) if (rest[i - 1]?.char === mark) { cut = i; break; }
    }
    const end = cut > (rows.length ? 0 : hang) ? cut : room;
    rows.push(rest.slice(0, end));
    rest = rest.slice(end);
    while (rest[0]?.char === ' ') rest = rest.slice(1);
  }
  return rows.map((row, i) => {
    const segments: Segment[] = i ? [[' '.repeat(hang), '']] : [];
    for (const { char, style } of row) {
      const last = segments[segments.length - 1];
      if (last && last[1] === style) last[0] += char;
      else segments.push([char, style]);
    }
    return segments;
  });
}

// A plain line of text folded the same way.
export const foldText = (text: string, width: number): string[] =>
  fit([[text, '']], width).map(row => row.map(([part]) => part).join(''));
