const test = require('node:test')
const assert = require('node:assert')
const fake = require('./fake-sdk')
const config = require('../config')
const { main } = require('../index')
const T = require('../lib/time')

const MIN = 60 * 1000
const tz = 'America/Los_Angeles'
const VENUE = { lat: 37.3861, lng: -122.0839 }

async function api(openid, action, params = {}) {
  fake.as(openid)
  const r = await main({ action, ...params })
  if (!r.ok) throw new Error(`${action}: ${r.error}`)
  return r.data
}
async function apiErr(openid, action, params = {}) {
  fake.as(openid)
  const r = await main({ action, ...params })
  assert.strictEqual(r.ok, false, `${action} should fail`)
  return r.error
}
const tick = () => {
  fake.as('') // 定时器调用没有用户身份
  return main({ Type: 'Timer', TriggerName: 'settle' })
}

test('admins can sign up before opening; open reminders fire when signup opens and follow changes', async () => {
  fake.reset()
  const saved = config.OPEN_TEMPLATE_ID
  config.OPEN_TEMPLATE_ID = 'open'
  const opens = T.zonedToUtcMs('2026-10-01', '20:00', tz)
  fake.setNow(opens - 2 * 24 * 60 * MIN)
  for (const id of ['o', 'a', 'x']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const form = { date: '2026-10-04', time: '10:00', timezone: tz, venueId, signupOpens: { date: '2026-10-01', time: '20:00' } }
  const { gameId } = await api('o', 'saveGame', { clubId, form })

  // 管理员提前报名；普通人不行
  assert.deepStrictEqual(await api('o', 'signup', { gameId }), { status: 'registered' })
  assert.match(await apiErr('x', 'signup', { gameId, inviter: 'o' }), /开放/)

  // 设置提醒
  await api('x', 'setOpenReminder', { gameId, envVersion: 'trial' })
  assert.strictEqual((await api('x', 'getGame', { gameId })).me.openReminder, true)
  assert.strictEqual((await api('a', 'getGame', { gameId })).me.openReminder, false)

  // 管理员把开放时间改到 21:00 → 提醒跟着变
  const later = T.zonedToUtcMs('2026-10-01', '21:00', tz)
  await api('o', 'saveGame', { clubId, gameId, form: { ...form, signupOpens: { date: '2026-10-01', time: '21:00' } } })
  fake.setNow(later - 1000)
  await tick()
  assert.strictEqual(fake.sent.length, 0) // 还没开放
  fake.setNow(later + 3 * MIN) // 定时器在开放后几分钟内扫到
  await tick()
  assert.strictEqual(fake.sent.length, 1)
  assert.deepStrictEqual([fake.sent[0].touser, fake.sent[0].templateId, fake.sent[0].miniprogramState], ['x', 'open', 'trial'])
  assert.deepStrictEqual(fake.sent[0].data, {
    thing1: { value: '周日 · V' },
    thing3: { value: 'V' },
    date5: { value: '2026年10月4日 10:00' },
    thing6: { value: '报名已开放，快来报名' },
  })
  await tick()
  assert.strictEqual(fake.sent.length, 1) // 不重复发
  assert.strictEqual((await api('x', 'getGame', { gameId })).me.openReminder, false)

  // 开放后不能再设提醒；开放后普通人可以报名
  fake.setNow(later)
  assert.match(await apiErr('x', 'setOpenReminder', { gameId }), /已经开放/)
  assert.deepStrictEqual(await api('x', 'signup', { gameId, inviter: 'o' }), { status: 'registered' })

  // 取消定时开放 / 取消比赛 → 未发送的提醒作废
  fake.setNow(opens - 2 * 24 * 60 * MIN)
  const { gameId: g2 } = await api('o', 'saveGame', { clubId, form: { ...form, date: '2026-10-11', signupOpens: { date: '2026-10-08', time: '20:00' } } })
  await api('a', 'setOpenReminder', { gameId: g2 })
  await api('o', 'saveGame', { clubId, gameId: g2, form: { ...form, date: '2026-10-11', signupOpens: null } })
  const { gameId: g3 } = await api('o', 'saveGame', { clubId, form: { ...form, date: '2026-10-18', signupOpens: { date: '2026-10-15', time: '20:00' } } })
  await api('a', 'setOpenReminder', { gameId: g3 })
  await api('o', 'cancelGame', { gameId: g3, reason: '下雨' })
  fake.setNow(T.zonedToUtcMs('2026-10-16', '00:00', tz))
  await tick()
  assert.strictEqual(fake.sent.filter((m) => m.templateId === 'open').length, 1)
  config.OPEN_TEMPLATE_ID = saved
})

test('open reminders retry transient errors, give up on permanent ones, skip stale', async () => {
  fake.reset()
  const saved = config.OPEN_TEMPLATE_ID
  config.OPEN_TEMPLATE_ID = 'open'
  const opens = T.zonedToUtcMs('2026-10-01', '20:00', tz)
  fake.setNow(opens - 24 * 60 * MIN)
  for (const id of ['o', 'x', 'y']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const form = { date: '2026-10-04', time: '10:00', timezone: tz, venueId, signupOpens: { date: '2026-10-01', time: '20:00' } }
  const { gameId } = await api('o', 'saveGame', { clubId, form })
  await api('x', 'setOpenReminder', { gameId })
  await api('y', 'setOpenReminder', { gameId })

  // x 临时错误、y 永久错误
  const cloud = require('wx-server-sdk')
  const realSend = cloud.openapi.subscribeMessage.send
  cloud.openapi.subscribeMessage.send = async (m) => {
    throw { errCode: m.touser === 'x' ? -501001 : 43101, errMsg: 'boom' }
  }
  fake.setNow(opens + MIN)
  let r = await tick()
  assert.deepStrictEqual([r.reminded, r.remindFailed], [0, 2])
  cloud.openapi.subscribeMessage.send = realSend
  fake.setNow(opens + 6 * MIN)
  r = await tick()
  assert.deepStrictEqual([r.reminded, r.remindFailed], [1, 0]) // 只重试 x
  assert.strictEqual(fake.sent.at(-1).touser, 'x')
  r = await tick()
  assert.strictEqual(r.reminded, 0)

  // 过期：开放 30 分钟后才被扫到的不发
  const { gameId: g2 } = await api('o', 'saveGame', { clubId, form: { ...form, date: '2026-10-11', signupOpens: { date: '2026-10-08', time: '20:00' } } })
  fake.setNow(opens + 10 * MIN)
  await api('x', 'setOpenReminder', { gameId: g2 })
  fake.setNow(T.zonedToUtcMs('2026-10-08', '21:00', tz))
  r = await tick()
  assert.strictEqual(r.reminded, 0)
  config.OPEN_TEMPLATE_ID = saved
})
