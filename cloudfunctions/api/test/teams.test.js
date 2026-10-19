const test = require('node:test')
const assert = require('node:assert')
const fake = require('./fake-sdk')
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

async function setup({ capacity, teamSize, teamCount, players }) {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  const ids = ['o', ...Array.from({ length: players - 1 }, (_, i) => `p${i + 1}`)]
  for (const id of ids) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', {
    clubId,
    form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId, capacity, teamSize, teamCount, autoTeams: true, goalkeeper: true },
  })
  for (const id of ids) await api(id, 'signup', { gameId, inviter: 'o' })
  fake.setNow(startAt - 20 * MIN)
  const checkin = async (id) => {
    fake.setNow(Date.now() + 1000) // 保证签到顺序
    return api(id, 'checkin', { gameId, ...VENUE })
  }
  return { gameId, clubId, ids, checkin }
}

const sizes = (t) => t.teams.map((x) => x.members.length)
const gks = (team) => team.members.map((m) => m.gk)

test('8v8v8: first 16 random into A/B, next 8 into C, overflow to smallest team', async () => {
  const { gameId, ids, checkin } = await setup({ capacity: 26, teamSize: 8, teamCount: 3, players: 26 })

  for (const id of ids.slice(0, 15)) await checkin(id)
  let t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual([t.formed, t.checkedIn, t.threshold], [false, 15, 16])

  await checkin(ids[15]) // 第 16 人触发
  t = (await api('p1', 'getGame', { gameId })).teams
  assert.strictEqual(t.formed, true)
  assert.deepStrictEqual(sizes(t), [8, 8, 0])
  assert.deepStrictEqual(gks(t.teams[0]), [1, 2, 3, 4, 5, 6, 7, 8])
  const first16 = new Set(ids.slice(0, 16))
  assert.ok([...t.teams[0].members, ...t.teams[1].members].every((m) => first16.has(m.openid)))
  assert.ok(t.myTeam === 'A' || t.myTeam === 'B')
  assert.ok(t.myGk >= 1 && t.myGk <= 8)

  for (const id of ids.slice(16, 24)) await checkin(id)
  t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual(sizes(t), [8, 8, 8])
  assert.deepStrictEqual(t.teams[2].members.map((m) => m.openid).sort(), ids.slice(16, 24).sort())
  assert.deepStrictEqual(gks(t.teams[2]), [1, 2, 3, 4, 5, 6, 7, 8]) // 按号码排序后是完整的 1..8
  // C 队号码是分队时预先随机的，按到场顺序依次发放
  const slots = fake.store.games.get(gameId).gkSlots.C
  const byArrival = ids.slice(16, 24).map((id) => t.teams[2].members.find((m) => m.openid === id).gk)
  assert.deepStrictEqual(byArrival, slots)

  await checkin(ids[24]) // 超员：都一样多 → A
  await checkin(ids[25]) // → B
  t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual(sizes(t), [9, 9, 8])
  assert.strictEqual(t.teams[0].members.at(-1).openid, ids[24])
  assert.strictEqual(t.teams[0].members.at(-1).gk, 9)

  // 重新随机：只动首批 16 人；C 队和后到的人不变
  const before = (await api('o', 'getGame', { gameId })).teams
  await api('o', 'reshuffleTeams', { gameId })
  t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual(sizes(t), [9, 9, 8])
  assert.deepStrictEqual(t.teams[2].members.map((m) => m.openid), before.teams[2].members.map((m) => m.openid))
  assert.strictEqual(t.teams[0].members.at(-1).openid, ids[24])
  assert.deepStrictEqual(gks(t.teams[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  const firstAB = (x) => [...x.teams[0].members, ...x.teams[1].members].filter((m) => !m.late).map((m) => m.openid).sort()
  assert.deepStrictEqual(firstAB(t), firstAB(before))

  // 只重排 A 队守门员：A 队成员不变、编号仍是 1..9；其他队不动
  const beforeGk = (await api('o', 'getGame', { gameId })).teams
  await api('o', 'reshuffleGoalkeepers', { gameId, team: 'A' })
  t = (await api('o', 'getGame', { gameId })).teams
  const memberIds = (x) => x.members.map((m) => m.openid).sort()
  assert.deepStrictEqual(memberIds(t.teams[0]), memberIds(beforeGk.teams[0]))
  assert.deepStrictEqual(gks(t.teams[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepStrictEqual(t.teams[1].members, beforeGk.teams[1].members)
  assert.deepStrictEqual(t.teams[2].members, beforeGk.teams[2].members)
  await api('o', 'reshuffleGoalkeepers', { gameId }) // 全部队
  assert.deepStrictEqual(sizes((await api('o', 'getGame', { gameId })).teams), [9, 9, 8])
  assert.match(await apiErr('p1', 'reshuffleGoalkeepers', { gameId }), /管理员/)
  assert.match(await apiErr('o', 'reshuffleGoalkeepers', { gameId, team: 'Z' }), /不存在/)

  // 权限与状态
  assert.match(await apiErr('p1', 'reshuffleTeams', { gameId }), /管理员/)
  assert.match(await apiErr('o', 'formTeamsNow', { gameId }), /已经分过队/)
})

test('manual form spreads everyone evenly; latecomers go to smallest team', async () => {
  const { gameId, clubId, ids, checkin } = await setup({ capacity: 24, teamSize: 8, teamCount: 3, players: 24 })
  assert.match(await apiErr('o', 'formTeamsNow', { gameId }), /还没有人签到/)
  for (const id of ids.slice(0, 10)) await checkin(id)
  await api('o', 'formTeamsNow', { gameId })
  let t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual(sizes(t), [4, 3, 3])
  await checkin(ids[10]) // → B（B、C 同样少，按顺序）
  t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual(sizes(t), [4, 4, 3])

  // 管理员代签到也会分队
  await api('o', 'setAttendance', { gameId, target: ids[11], attendance: 'on_time' })
  t = (await api('o', 'getGame', { gameId })).teams
  assert.deepStrictEqual(sizes(t), [4, 4, 4])

  // 已分队后不能改赛制
  const { form } = await api('o', 'gameForm', { clubId, gameId })
  assert.match(await apiErr('o', 'saveGame', { clubId, gameId, form: { ...form, teamSize: 7 } }), /不能再修改赛制/)
})

test('two teams: random split only when both teams can be filled', async () => {
  const { gameId, ids, checkin } = await setup({ capacity: 10, teamSize: 5, teamCount: 2, players: 10 })
  for (const id of ids.slice(0, 9)) await checkin(id)
  assert.strictEqual((await api('o', 'getGame', { gameId })).teams.threshold, 10)
  assert.strictEqual((await api('o', 'getGame', { gameId })).teams.formed, false)
  await checkin(ids[9])
  assert.deepStrictEqual(sizes((await api('o', 'getGame', { gameId })).teams), [5, 5])
})

test('teams disabled: no team data', async () => {
  fake.reset()
  fake.setNow(Date.UTC(2026, 9, 1))
  await api('o', 'login')
  await api('o', 'updateProfile', { nickname: 'O' })
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', { clubId, form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId } })
  const g = await api('o', 'getGame', { gameId })
  assert.strictEqual(g.teams, null)
  assert.deepStrictEqual([g.game.teamSize, g.game.teamCount, g.game.autoTeams], [8, 3, false])
})

test('heals a drifted registeredCount and promotes the waitlist; marks waitlist quits', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  for (const id of ['o', 'a', 'b', 'c']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', { clubId, form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId, capacity: 2 } })
  await api('o', 'signup', { gameId })
  await api('a', 'signup', { gameId, inviter: 'o' })
  await api('b', 'signup', { gameId, inviter: 'o' }) // 替补 1
  await api('c', 'signup', { gameId, inviter: 'o' }) // 替补 2
  await api('c', 'cancelSignup', { gameId }) // 退出替补

  // 模拟 bug：有人取消了，但计数没减（以前版本或并发导致）
  fake.store.registrations.get(`${gameId}_a`).status = 'cancelled'
  let g = await api('o', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.name).sort(), ['B', 'O']) // B 被递补
  assert.strictEqual(g.game.registeredCount, 2)
  const quit = g.cancelled.find((r) => r.name === 'C')
  assert.strictEqual(quit.cancelledFrom, 'waitlist')
})

test('game tags: admin defines, players self-toggle, admin can edit others', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  for (const id of ['o', 'a', 'b']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const form = { date: '2026-10-04', time: '10:00', timezone: tz, venueId }
  // 球队默认标签
  await api('o', 'updateClub', { clubId, settings: { defaultTags: '已付款，带球' } })
  assert.deepStrictEqual((await api('o', 'gameForm', { clubId })).settings.defaultTags, ['已付款', '带球'])
  assert.match(await apiErr('o', 'updateClub', { clubId, settings: { defaultTags: 'a,b,c,d' } }), /最多 3 个/)
  assert.match(await apiErr('o', 'saveGame', { clubId, form: { ...form, tags: '已付款,带球,带背心,能守门' } }), /最多 3 个/)
  assert.match(await apiErr('o', 'saveGame', { clubId, form: { ...form, tags: ['这个标签太长了吧'] } }), /太长/)
  const { gameId } = await api('o', 'saveGame', { clubId, form: { ...form, tags: '已付款，带球 已付款' } })
  assert.deepStrictEqual((await api('o', 'gameForm', { clubId, gameId })).form.tags, ['已付款', '带球'])

  await api('a', 'signup', { gameId, inviter: 'o' })
  await api('b', 'signup', { gameId, inviter: 'o' })
  assert.deepStrictEqual(await api('a', 'toggleTag', { gameId, tag: '已付款' }), { on: true })
  assert.match(await apiErr('a', 'toggleTag', { gameId, tag: '不存在' }), /没有这个标签/)
  assert.match(await apiErr('a', 'toggleTag', { gameId, tag: '已付款', target: 'b' }), /管理员/)
  assert.match(await apiErr('o', 'toggleTag', { gameId, tag: '已付款' }), /已报名/) // o 没报名
  await api('o', 'toggleTag', { gameId, tag: '已付款', target: 'b', on: true })
  await api('o', 'toggleTag', { gameId, tag: '已付款', target: 'b', on: true }) // 幂等
  let g = await api('b', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => [r.name, r.tags]), [['A', ['已付款']], ['B', ['已付款']]])

  // 赛后也能改；取消
  fake.setNow(startAt + 3 * 60 * MIN)
  assert.deepStrictEqual(await api('a', 'toggleTag', { gameId, tag: '已付款' }), { on: false })
  // 管理员删掉标签定义后不再显示
  fake.setNow(startAt - 60 * MIN)
  await api('o', 'saveGame', { clubId, gameId, form: { ...form, tags: '带球' } })
  g = await api('o', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.tags), [[], []])
  assert.deepStrictEqual(g.game.tags, ['带球'])

  // 结算后：完整编辑被锁，但管理员仍可改标签，球员仍可打标签
  fake.setNow(startAt + 3 * 60 * MIN)
  await api('o', 'getGame', { gameId }) // 触发结算
  assert.match(await apiErr('o', 'saveGame', { clubId, gameId, form: { ...form, tags: '已付款' } }), /已结算/)
  assert.match(await apiErr('a', 'setGameTags', { gameId, tags: '已付款' }), /管理员/)
  assert.deepStrictEqual(await api('o', 'setGameTags', { gameId, tags: '已付款' }), { tags: ['已付款'] })
  assert.deepStrictEqual(await api('a', 'toggleTag', { gameId, tag: '已付款' }), { on: true })
  g = await api('o', 'getGame', { gameId })
  // B 之前打过“已付款”，标签删掉再加回来后恢复显示
  assert.deepStrictEqual(g.registered.map((r) => r.tags), [['已付款'], ['已付款']])
})

test('first real game fixes: 10:10:00 is late, late arrivals join teams, no-show becomes late on arrival', async () => {
  const { gameId, ids, checkin } = await setup({ capacity: 24, teamSize: 8, teamCount: 3, players: 20 })
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  for (const id of ids.slice(0, 16)) await checkin(id) // 分队
  // 10:09:59 签到：准时
  fake.setNow(startAt + 10 * MIN - 1000)
  assert.strictEqual((await api(ids[16], 'checkin', { gameId, ...VENUE })).attendance, 'on_time')
  // 10:12 签到：迟到，结算之后也分进队、排守门员
  fake.setNow(startAt + 12 * MIN)
  await api('o', 'getGame', { gameId }) // 结算
  assert.strictEqual((await api(ids[17], 'checkin', { gameId, ...VENUE })).attendance, 'late')
  let t = (await api('o', 'getGame', { gameId })).teams
  const late = t.teams.flatMap((x) => x.members).find((m) => m.openid === ids[17])
  assert.ok(late && late.gk > 0, 'late player should be in a team with a goalkeeper number')
  // 管理员把未到的人改为迟到（人其实在场）：也分进队
  await api('o', 'setAttendance', { gameId, target: ids[18], attendance: 'late' })
  t = (await api('o', 'getGame', { gameId })).teams
  assert.ok(t.teams.flatMap((x) => x.members).some((m) => m.openid === ids[18]))
  // 分队后的操作在结算后仍可用
  await api('o', 'reshuffleGoalkeepers', { gameId, team: 'C' })
  await api('o', 'reshuffleTeams', { gameId })

  // 结算时判了未到的人 10:20 才来：改成迟到，罚款原因同步改为迟到
  const reg = fake.store.registrations.get(`${gameId}_${ids[19]}`)
  assert.strictEqual(reg.attendance, 'no_show')
  fake.setNow(startAt + 20 * MIN)
  assert.strictEqual((await api(ids[19], 'checkin', { gameId, ...VENUE })).attendance, 'late')
  const fine = fake.store.fines.get(`${gameId}_${ids[19]}_attendance`)
  assert.deepStrictEqual([fine.status, fine.reason], ['pending', 'late'])
})

test('check-in too far reports accuracy hint', async () => {
  const { gameId, ids } = await setup({ capacity: 4, teamSize: 2, teamCount: 2, players: 2 })
  const err = await apiErr(ids[1], 'checkin', { gameId, lat: VENUE.lat + 0.02, lng: VENUE.lng, accuracy: 3000 })
  assert.match(err, /精确位置/)
})

test('settlement resumes after an interrupted run', async () => {
  const { gameId, ids } = await setup({ capacity: 6, teamSize: 3, teamCount: 2, players: 4 })
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  // 模拟上次结算超时：已标记 settledAt，只处理了一个人
  const g = fake.store.games.get(gameId)
  g.settledAt = startAt + 10 * MIN
  fake.store.registrations.get(`${gameId}_${ids[0]}`).attendance = 'no_show'
  fake.setNow(startAt + 15 * MIN)
  fake.as('')
  const r = await main({ Type: 'Timer', TriggerName: 'settle' })
  assert.strictEqual(r.settled, 1)
  const att = ids.map((id) => fake.store.registrations.get(`${gameId}_${id}`).attendance)
  assert.deepStrictEqual(att, ['no_show', 'no_show', 'no_show', 'no_show'])
  assert.strictEqual(fake.store.games.get(gameId).settleDone, true)
  // 剩下 3 人补上了罚款（第一个人上次已处理完，不再重复处理）
  const fines = [...fake.store.fines.values()].filter((f) => f.gameId === gameId)
  assert.strictEqual(fines.length, 3)
  // 再跑一次：不再处理
  const r2 = await main({ Type: 'Timer', TriggerName: 'settle' })
  assert.strictEqual(r2.settled, 0)
})

test('check-in can be turned off per game or by club default', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  for (const id of ['o', 'a']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const form = { date: '2026-10-04', time: '10:00', timezone: tz, venueId }

  // 单场关闭：自动分队也被关掉
  const { gameId } = await api('o', 'saveGame', { clubId, form: { ...form, checkinEnabled: false, autoTeams: true, goalkeeper: true } })
  let g = (await api('o', 'getGame', { gameId })).game
  assert.deepStrictEqual([g.checkinEnabled, g.autoTeams, g.goalkeeper], [false, false, false])
  await api('a', 'signup', { gameId, inviter: 'o' })
  fake.setNow(startAt - 10 * MIN)
  assert.match(await apiErr('a', 'checkin', { gameId, ...VENUE }), /没有开启签到/)
  assert.match(await apiErr('o', 'getCheckinCode', { gameId }), /没有开启签到/)
  // 结算：不判未到、不罚款
  fake.setNow(startAt + 30 * MIN)
  const d = await api('o', 'getGame', { gameId })
  assert.strictEqual(d.registered[0].attendance, '')
  assert.strictEqual([...fake.store.fines.values()].filter((f) => f.gameId === gameId).length, 0)

  // 球队默认关闭 → 新比赛默认关闭；单场可再打开
  await api('o', 'updateClub', { clubId, settings: { checkinEnabled: false } })
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  const { gameId: g2 } = await api('o', 'saveGame', { clubId, form: { ...form, date: '2026-10-11' } })
  assert.strictEqual((await api('o', 'getGame', { gameId: g2 })).game.checkinEnabled, false)
  const { gameId: g3 } = await api('o', 'saveGame', { clubId, form: { ...form, date: '2026-10-18', checkinEnabled: true } })
  assert.strictEqual((await api('o', 'getGame', { gameId: g3 })).game.checkinEnabled, true)
  // 旧比赛（没有这个字段）视为开启
  delete fake.store.games.get(g3).checkinEnabled
  assert.strictEqual((await api('o', 'gameForm', { clubId, gameId: g3 })).form.checkinEnabled, true)
})

test('registration notes: self-written, admin-editable, content-checked, cleared on re-signup', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '18:00', tz)
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  for (const id of ['o', 'a', 'b', 'c']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', { clubId, form: { date: '2026-10-04', time: '18:00', timezone: tz, venueId, capacity: 2 } })
  await api('a', 'signup', { gameId, inviter: 'o' })
  await api('b', 'signup', { gameId, inviter: 'o' })
  await api('c', 'signup', { gameId, inviter: 'o' }) // 替补也能写

  assert.deepStrictEqual(await api('a', 'setRegNote', { gameId, note: '  6:20   到 ' }), { note: '6:20 到' })
  await api('c', 'setRegNote', { gameId, note: '能来就来' })
  assert.match(await apiErr('a', 'setRegNote', { gameId, note: '这是一段非常非常非常非常非常长的备注超过二十个字' }), /最多 20/)
  assert.match(await apiErr('a', 'setRegNote', { gameId, note: '违规内容' }), /不合适/)
  assert.match(await apiErr('b', 'setRegNote', { gameId, note: 'x', target: 'a' }), /管理员/)
  assert.match(await apiErr('o', 'setRegNote', { gameId, note: 'x' }), /只有报名/) // o 没报名

  let g = await api('b', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => [r.name, r.note]), [['A', '6:20 到'], ['B', '']])
  assert.strictEqual(g.waitlist[0].note, '能来就来')

  // 管理员清空；比赛结束后也能改
  await api('o', 'setRegNote', { gameId, note: '', target: 'a' })
  fake.setNow(startAt + 5 * 60 * MIN)
  await api('b', 'setRegNote', { gameId, note: '已到' })
  g = await api('o', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.note), ['', '已到'])

  // 取消后重新报名，备注清空
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  await api('c', 'cancelSignup', { gameId })
  await api('c', 'signup', { gameId })
  assert.strictEqual((await api('o', 'getGame', { gameId })).waitlist[0].note, '')
})

test('admin proxy check-in only inside the check-in window', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 2 * 24 * 60 * MIN)
  for (const id of ['o', 'a']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', { clubId, form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId } })
  await api('a', 'signup', { gameId, inviter: 'o' })
  // 三天前 / 开赛前 31 分钟：不行
  assert.match(await apiErr('o', 'setAttendance', { gameId, target: 'a', attendance: 'on_time' }), /开放/)
  fake.setNow(startAt - 31 * MIN)
  assert.match(await apiErr('o', 'setAttendance', { gameId, target: 'a', attendance: 'on_time' }), /开放/)
  // 开赛前 30 分钟：可以；再点一次提示已签到
  fake.setNow(startAt - 30 * MIN)
  await api('o', 'setAttendance', { gameId, target: 'a', attendance: 'on_time' })
  assert.ok((await api('o', 'getGame', { gameId })).registered[0].checkinAt)
  assert.match(await apiErr('o', 'setAttendance', { gameId, target: 'a', attendance: 'on_time' }), /已经签到/)
})

test('my stats and the club-level fines switch', async () => {
  const { gameId, clubId, ids, checkin } = await setup({ capacity: 6, teamSize: 3, teamCount: 2, players: 4 })
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  const [o, a, b, c] = ids
  await checkin(o) // 准时
  fake.setNow(startAt + 15 * MIN)
  await api(a, 'checkin', { gameId, ...VENUE }) // 迟到（结算前签到也算迟到）
  await api(o, 'getGame', { gameId }) // 结算：b、c 未到
  await api(o, 'addFine', { clubId, target: a, amountCents: 300, note: '穿钉鞋', gameId })
  const fines = (await api(o, 'listFines', { clubId, status: 'pending' })).fines.filter((f) => f.openid === a)
  await api(o, 'resolveFines', { clubId, fineIds: [fines.find((f) => f.reason === 'late')._id], op: 'paid', method: 'cash' })
  fake.setNow(startAt + 3 * 60 * MIN) // 比赛结束

  let st = (await api(a, 'myStats')).clubs[0]
  assert.deepStrictEqual(st.attendance, { played: 1, onTime: 0, late: 1, noShow: 0, cancelled: 0, upcoming: 0 })
  assert.deepStrictEqual(st.fines.byReason.map((x) => [x.reason, x.n]).sort(), [['穿钉鞋', 1], ['迟到', 1]])
  assert.deepStrictEqual([st.fines.totalCents, st.fines.paidCents, st.fines.pendingCents], [800, 500, 300])
  st = (await api(o, 'myStats')).clubs[0]
  assert.strictEqual(st.attendance.onTime, 1)

  // 关闭罚款：不再拦截报名、不能加罚款、新比赛不罚款
  await api(o, 'updateClub', { clubId, settings: { finesEnabled: false } })
  const venueId = fake.store.games.get(gameId).venue.id
  const { gameId: g2 } = await api(o, 'saveGame', { clubId, form: { date: '2026-10-11', time: '10:00', timezone: tz, venueId, fineCents: 500 } })
  assert.strictEqual((await api(o, 'getGame', { gameId: g2 })).game.fineCents, 0)
  assert.deepStrictEqual(await api(b, 'signup', { gameId: g2 }), { status: 'registered' }) // b 有未付的未到罚款
  assert.strictEqual((await api(b, 'getGame', { gameId: g2 })).me.unpaidCents, 0)
  assert.match(await apiErr(o, 'addFine', { clubId, target: b, amountCents: 100, note: 'x' }), /没有启用罚款/)
  assert.strictEqual((await api(b, 'myStats')).clubs[0].finesEnabled, false)
  assert.deepStrictEqual((await api(b, 'myPendingFines')).fines, []) // 不再提示待付
})

test('match goals and assists: player self-record after checkin, admin edit, and leaderboard', async () => {
  const { gameId, clubId, ids, checkin } = await setup({ capacity: 6, teamSize: 3, teamCount: 2, players: 3 })
  const [o, a, b] = ids

  // 签到前普通队员不能填自己的进球/助攻
  assert.match(await apiErr(a, 'setMatchStats', { gameId, goals: 1, assists: 0 }), /签到后/)

  // 签到后自己可以记录进球和助攻
  await checkin(o)
  await checkin(a)
  assert.deepStrictEqual(await api(a, 'setMatchStats', { gameId, goals: 2, assists: 1 }), { goals: 2, assists: 1 })
  assert.deepStrictEqual(await api(o, 'setMatchStats', { gameId, goals: 1, assists: 2 }), { goals: 1, assists: 2 })

  // 普通队员不能改别人的数据，管理员可以修改
  assert.match(await apiErr(a, 'setMatchStats', { gameId, target: o, goals: 9, assists: 0 }), /管理员/)
  assert.deepStrictEqual(await api(o, 'setMatchStats', { gameId, target: a, goals: 3, assists: 1 }), { goals: 3, assists: 1 })

  const g = await api(o, 'getGame', { gameId })
  const regA = g.registered.find((r) => r.openid === a)
  assert.strictEqual(regA.goals, 3)
  assert.strictEqual(regA.assists, 1)

  const lb = await api(a, 'leaderboard', { clubId })
  assert.strictEqual(lb.clubId, clubId)
  assert.deepStrictEqual(
    lb.rows.map((r) => [r.openid, r.games, r.goals, r.assists]),
    [
      [a, 1, 3, 1],
      [o, 1, 1, 2],
      [b, 0, 0, 0],
    ],
  )
})

