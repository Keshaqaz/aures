import { command } from './common.ts';
import type { CommandOptions } from './common.ts';
import { openWorker } from './active-worker.ts';
import { readOverview, renderOverview, paint, WIDTH } from './overview.ts';
import { fitOnRail } from './fit.ts';

// `aures status`: the overview of the screen, printed once: the resets, the
// rules, the worker and the warnings that need the user.
export async function status(options: CommandOptions): Promise<number> {
  const { io, mac, now = Date.now, timeZone } = options;
  return command('status', io, async () => {
    const worker = await openWorker(options, 'status');
    const model = await readOverview({ worker, mac, now });
    const width = io.width ?? WIDTH, lines = renderOverview(model, { now, timeZone, width });
    // In a terminal long lines fold under their text, as on the screen (issue 32); a plain
    // status there is folded by the live line.
    for (const line of io.color ? lines.flatMap(line => fitOnRail(line, width)) : lines) io.print(paint(line, io.color).trimEnd());
    return 0;
  });
}
