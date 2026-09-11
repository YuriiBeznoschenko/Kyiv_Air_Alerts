import assert from 'node:assert/strict';
import test from 'node:test';

import { parseKyivDigitalHistory } from '../netlify/functions/legacy-history.mjs';

test('parses completed Kyiv Digital alert intervals in chronological order', () => {
  const html = `
    <table>
      <tr><td>04:00 11.09.26</td><td>🟢 Відбій тривоги</td><td>1 годину 18 хвилин</td></tr>
      <tr><td>02:42 11.09.26</td><td>🔴 Повітряна тривога!</td><td></td></tr>
      <tr><td>21:26 10.09.26</td><td>🟢 Відбій тривоги</td><td>28 хвилин</td></tr>
      <tr><td>20:58 10.09.26</td><td>🔴 Повітряна тривога!</td><td></td></tr>
    </table>`;

  const result = parseKyivDigitalHistory(html);

  assert.deepEqual(result.intervals, [
    [Date.UTC(2026, 8, 10, 20, 58), Date.UTC(2026, 8, 10, 21, 26)],
    [Date.UTC(2026, 8, 11, 2, 42), Date.UTC(2026, 8, 11, 4, 0)],
  ]);
  assert.equal(result.alertCount, 2);
  assert.equal(result.eventCount, 4);
  assert.equal(result.active, false);
});

test('keeps the latest unmatched start as an active interval', () => {
  const html = `
    <table>
      <tr><td>09:10 11.09.26</td><td><strong>🔴 Повітряна тривога!</strong></td><td>&nbsp;</td></tr>
      <tr><td>04:00 11.09.26</td><td>🟢 Відбій тривоги</td><td></td></tr>
      <tr><td>02:42 11.09.26</td><td>🔴 Повітряна тривога!</td><td></td></tr>
    </table>`;

  const result = parseKyivDigitalHistory(html);

  assert.deepEqual(result.intervals.at(-1), [Date.UTC(2026, 8, 11, 9, 10), null]);
  assert.equal(result.active, true);
});

test('ignores unrelated table rows and duplicate events', () => {
  const html = `
    <table>
      <tr><td>Summary</td><td>2468 alerts</td></tr>
      <tr><td>09:10 11.09.26</td><td>Повітряна тривога!</td></tr>
      <tr><td>09:10 11.09.26</td><td>Повітряна тривога!</td></tr>
    </table>`;

  const result = parseKyivDigitalHistory(html);

  assert.equal(result.eventCount, 1);
  assert.equal(result.alertCount, 1);
  assert.equal(result.active, true);
});
