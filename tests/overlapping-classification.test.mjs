import assert from 'node:assert/strict';
import test from 'node:test';
import { applyObservedPhaseRecords } from '../public/alert-reconciliation-v2.mjs';

const time = value => Date.parse(`2026-09-30T${value}Z`);
const interval = { startMs: time('02:38:00'), endMs: time('12:22:00'), ongoing: false, level: 'unknown', phases: [] };
const record = (start, end, level, provisionalEnd = false) => ({
  startMs: time(start), updatedAtMs: time(end), provisionalEnd,
  phases: [{ startMs: time(start), endMs: time(end), level }],
});

test('September 30: one legacy interval receives both separate classified records', () => {
  const actualInterval = { ...interval, startMs: Date.parse('2026-09-29T23:38:00Z') };
  const [result] = applyObservedPhaseRecords([actualInterval], [
    { startMs: Date.parse('2026-09-29T23:37:48.729Z'), updatedAtMs: time('10:23:28'),
      phases: [{ startMs: Date.parse('2026-09-29T23:37:48.729Z'), endMs: time('02:45:46'), level: 'yellow' }] },
    record('02:46:54.921', '04:40:32', 'red'),
    record('04:43:28.535', '12:22:19.946', 'yellow', true),
    record('12:56:18.918', '13:37:28', 'yellow'),
  ]);
  assert.deepEqual(result.phases.map(p => [p.level, p.startMs, p.endMs]), [
    ['yellow', actualInterval.startMs, time('02:45:46')],
    ['unknown', time('02:45:46'), time('02:46:54.921')],
    ['red', time('02:46:54.921'), time('04:40:32')],
    ['unknown', time('04:40:32'), time('04:43:28.535')],
    ['yellow', time('04:43:28.535'), interval.endMs],
  ]);
  assert.equal(result.startMs, actualInterval.startMs);
  assert.equal(result.endMs, interval.endMs);
});

test('a provisional matching record cannot colour the gap before another incident', () => {
  const first = record('02:38:00', '03:00:00', 'yellow', true);
  const second = record('04:00:00', '05:00:00', 'red');
  const [result] = applyObservedPhaseRecords([interval], [first, second]);
  assert.deepEqual(result.phases.map(p => p.level), ['yellow', 'unknown', 'red', 'unknown']);
  assert.equal(result.phases[0].endMs, first.phases[0].endMs);
});

test('a later overlapping incident takes over without double counting duration', () => {
  const [result] = applyObservedPhaseRecords([interval], [
    record('02:38:00', '12:22:00', 'yellow'),
    record('04:00:00', '05:00:00', 'red'),
  ]);
  assert.deepEqual(result.phases.map(p => p.level), ['yellow', 'red', 'yellow']);
  assert.equal(result.phases.reduce((sum, p) => sum + p.endMs - p.startMs, 0), interval.endMs - interval.startMs);
});

test('saved confirmed colour survives where server records have no coverage', () => {
  const [result] = applyObservedPhaseRecords([{ ...interval, phases: [
    { startMs: time('02:38:00'), endMs: time('03:00:00'), level: 'red' },
  ] }], [record('04:00:00', '05:00:00', 'yellow')]);
  assert.deepEqual(result.phases.map(p => p.level), ['red', 'unknown', 'yellow', 'unknown']);
});

test('an unrelated record cannot classify an interval', () => {
  assert.deepEqual(applyObservedPhaseRecords([interval], [record('12:56:00', '13:37:00', 'red')])[0].phases, []);
});

test('a single matching provisional record still follows the confirmed legacy end', () => {
  const [result] = applyObservedPhaseRecords([interval], [record('02:38:00', '12:21:00', 'yellow', true)]);
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].endMs, interval.endMs);
});
