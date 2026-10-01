const test = require('node:test')
const assert = require('node:assert')
const rules = require('../lib/rules')
const T = require('../lib/time')

const MIN = 60 * 1000
const tz = 'America/Los_Angeles'

// 2026-09-27（周日）10:00 PDT
const startAt = T.zonedToUtcMs('2026-09-27', '10:00', tz)
const game = {
  startAt,
  endAt: startAt + 120 * MIN,
  cutoffAt: startAt + 10 * MIN,
  cancelDeadlineAt: T.deadlineBefore(startAt, tz, 1, '21:00'),
  penaltyWindowMin: 60,
  checkinOpenBeforeMin: 30,
}

test('zoned time converts to UTC', () => {
  assert.strictEqual(new Date(startAt).toISOString(), '2026-09-27T17:00:00.000Z')
  assert.deepStrictEqual(T.zonedParts(startAt, tz), { date: '2026-09-27', time: '10:00' })
  assert.strictEqual(T.fmtLocal(startAt, tz), '9月27日(周日) 10:00')
  assert.strictEqual(T.offsetMin(startAt, tz), -7 * 60)
})

test('default cancel deadline is previous day 21:00 local, across DST', () => {
  assert.strictEqual(new Date(game.cancelDeadlineAt).toISOString(), '2026-09-27T04:00:00.000Z')
  // 2026-11-01 是夏令时结束日；前一天 21:00 仍是 PDT
  const s = T.zonedToUtcMs('2026-11-01', '10:00', tz)
  assert.strictEqual(new Date(s).toISOString(), '2026-11-01T18:00:00.000Z')
  assert.strictEqual(new Date(T.deadlineBefore(s, tz, 1, '21:00')).toISOString(), '2026-11-01T04:00:00.000Z')
})

test('cancel phases', () => {
  assert.strictEqual(rules.cancelPhase(game, game.cancelDeadlineAt - 1), 'free')
  assert.strictEqual(rules.cancelPhase(game, game.cancelDeadlineAt), 'warn')
  assert.strictEqual(rules.cancelPhase(game, startAt - 61 * MIN), 'warn')
  assert.strictEqual(rules.cancelPhase(game, startAt - 60 * MIN), 'penalty')
  assert.strictEqual(rules.cancelPhase(game, startAt + 5 * MIN), 'penalty')
})

test('attendance: 10:10 on time, 10:11 late, none = no show', () => {
  assert.strictEqual(rules.attendanceFor(startAt + 10 * MIN, game), 'on_time')
  assert.strictEqual(rules.attendanceFor(startAt + 11 * MIN, game), 'late')
  assert.strictEqual(rules.attendanceFor(0, game), 'no_show')
})

test('check-in window opens 30 minutes before', () => {
  assert.strictEqual(rules.canCheckinAt(game, startAt - 31 * MIN), false)
  assert.strictEqual(rules.canCheckinAt(game, startAt - 30 * MIN), true)
  assert.strictEqual(rules.canCheckinAt(game, game.endAt + 1), false)
})

test('late promotion exemption', () => {
  assert.strictEqual(rules.isLatePromotion({ promotedAt: 0 }, game), false)
  assert.strictEqual(rules.isLatePromotion({ promotedAt: startAt - 2 * 60 * MIN }, game), false)
  assert.strictEqual(rules.isLatePromotion({ promotedAt: startAt - 30 * MIN }, game), true)
})

test('haversine distance', () => {
  const a = { lat: 37.4, lng: -122.0 }
  const b = { lat: 37.4009, lng: -122.0 } // ~100m 北
  const d = rules.haversineM(a, b)
  assert.ok(d > 95 && d < 105, `got ${d}`)
})

test('check-in code rotates per minute and accepts previous minute', () => {
  const now = startAt
  const code = rules.checkinCode('secret', 'g1', now)
  assert.match(code, /^\d{4}$/)
  assert.ok(rules.verifyCheckinCode('secret', 'g1', code, now))
  assert.ok(rules.verifyCheckinCode('secret', 'g1', code, now + MIN))
  assert.ok(!rules.verifyCheckinCode('secret', 'g1', code, now + 2 * MIN) || code === rules.checkinCode('secret', 'g1', now + 2 * MIN))
  assert.ok(!rules.verifyCheckinCode('other', 'g1', code, now) || code === rules.checkinCode('other', 'g1', now))
})

test('shiftDate', () => {
  assert.strictEqual(T.shiftDate('2026-09-27', 7), '2026-10-04')
})
