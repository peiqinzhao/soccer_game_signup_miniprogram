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
  assert.deepStrictEqual(t.teams[2].members.map((m) => m.openid), ids.slice(16, 24)) // 按签到顺序
  assert.deepStrictEqual(gks(t.teams[2]), [1, 2, 3, 4, 5, 6, 7, 8])

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

test('first real game fixes: 10:10:xx is on time, late arrivals join teams, old-cutoff fines corrected', async () => {
  const { gameId, ids, checkin } = await setup({ capacity: 24, teamSize: 8, teamCount: 3, players: 20 })
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  for (const id of ids.slice(0, 16)) await checkin(id) // 分队
  // 10:10:30 签到：准时
  fake.setNow(startAt + 10 * MIN + 30 * 1000)
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

  // 早期比赛：cutoffAt 存的是 10:10:00，10:10 结算判了未到；10:10:40 来签到 → 准时并撤销罚款
  const g = fake.store.games.get(gameId)
  const reg = fake.store.registrations.get(`${gameId}_${ids[19]}`)
  assert.strictEqual(reg.attendance, 'no_show')
  g.cutoffAt = startAt + 10 * MIN
  g.endAt = startAt + 120 * MIN
  fake.setNow(startAt + 10 * MIN + 40 * 1000)
  assert.strictEqual((await api(ids[19], 'checkin', { gameId, ...VENUE })).attendance, 'on_time')
  const fine = fake.store.fines.get(`${gameId}_${ids[19]}_attendance`)
  assert.deepStrictEqual([fine.status, fine.note], ['waived', '按时签到'])
})

test('check-in too far reports accuracy hint', async () => {
  const { gameId, ids } = await setup({ capacity: 4, teamSize: 2, teamCount: 2, players: 2 })
  const err = await apiErr(ids[1], 'checkin', { gameId, lat: VENUE.lat + 0.02, lng: VENUE.lng, accuracy: 3000 })
  assert.match(err, /精确位置/)
})
