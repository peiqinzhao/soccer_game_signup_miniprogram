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

async function setupClub(owner, member) {
  const { clubId } = await api(owner, 'createClub', { name: `${owner}-club` })
  const { venueId } = await api(owner, 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api(owner, 'saveGame', {
    clubId,
    form: { date: '2026-10-11', time: '10:00', timezone: 'America/Los_Angeles', venueId },
  })
  await api(member, 'signup', { gameId, inviter: owner })
  await api(owner, 'addLedgerEntry', { clubId, type: 'opening', amountCents: 100, note: 'x' })
  return { clubId, gameId }
}

test('reset clears only the caller-owned clubs\' activity', async () => {
  fake.reset()
  fake.setNow(Date.UTC(2026, 9, 1))
  for (const id of ['o', 'p', 'q']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id })
  }
  const mine = await setupClub('o', 'p')
  const theirs = await setupClub('q', 'p')

  fake.as('')
  assert.strictEqual((await reset.main({ confirm: 'DELETE' })).ok, false) // 没有身份
  fake.as('o')
  assert.strictEqual((await reset.main({})).ok, false) // 没确认
  fake.as('p')
  assert.match((await reset.main({ confirm: 'DELETE' })).error, /没有创建任何球队/)

  fake.as('o')
  const r = await reset.main({ confirm: 'DELETE' })
  assert.deepStrictEqual(r.removed, { reminders: 0, registrations: 1, fines: 0, ledger: 1, games: 1 })

  // 自己球队：成员和场地保留，账本清空
  const c = await api('o', 'getClub', { clubId: mine.clubId })
  assert.deepStrictEqual(c.members.map((m) => m.openid).sort(), ['o', 'p'])
  assert.strictEqual(c.venues.length, 1)
  assert.strictEqual((await api('o', 'getLedger', { clubId: mine.clubId })).balanceCents, 0)
  // 别人的球队完好
  assert.strictEqual((await api('q', 'getLedger', { clubId: theirs.clubId })).balanceCents, 100)
  assert.strictEqual((await api('q', 'getGame', { gameId: theirs.gameId })).registered.length, 1)
})
