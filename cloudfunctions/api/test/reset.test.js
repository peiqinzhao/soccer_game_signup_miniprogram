const test = require('node:test')
const assert = require('node:assert')
const fake = require('./fake-sdk')
const { main } = require('../index')
const reset = require('../../reset/index')

const VENUE = { lat: 37.3861, lng: -122.0839 }

async function api(openid, action, params = {}) {
  fake.as(openid)
  const r = await main({ action, ...params })
  if (!r.ok) throw new Error(r.error)
  return r.data
}

test('reset clears activity only and refuses client calls', async () => {
  fake.reset()
  fake.setNow(Date.UTC(2026, 9, 1))
  for (const id of ['o', 'p']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', {
    clubId,
    form: { date: '2026-10-11', time: '10:00', timezone: 'America/Los_Angeles', venueId },
  })
  await api('p', 'signup', { gameId, inviter: 'o' })
  await api('o', 'addLedgerEntry', { clubId, type: 'opening', amountCents: 100, note: 'x' })

  fake.as('p') // 客户端调用
  assert.strictEqual((await reset.main({ confirm: 'DELETE' })).ok, false)
  fake.as('') // 控制台云端测试
  assert.strictEqual((await reset.main({})).ok, false)

  const r = await reset.main({ confirm: 'DELETE' })
  assert.deepStrictEqual(r.removed, { games: 1, registrations: 1, fines: 0, ledger: 1, reminders: 0 })
  const c = await api('o', 'getClub', { clubId })
  assert.deepStrictEqual(c.members.map((m) => m.openid).sort(), ['o', 'p']) // 成员保留
  assert.strictEqual(c.venues.length, 1)
  assert.strictEqual((await api('o', 'getLedger', { clubId })).balanceCents, 0)
})
