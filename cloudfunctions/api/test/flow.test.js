// 用内存数据库跑一遍完整流程：报名 → 替补 → 取消 → 递补 → 签到 → 结算 → 罚款 → 账本
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
  if (!r.ok) throw new Error(r.error)
  return r.data
}

async function apiErr(openid, action, params = {}) {
  fake.as(openid)
  const r = await main({ action, ...params })
  assert.strictEqual(r.ok, false, `${action} should fail`)
  return r.error
}

test('full game flow', async () => {
  fake.reset()
  const savedIds = [config.PROMOTED_TEMPLATE_ID, config.CHANGED_TEMPLATE_ID]
  config.PROMOTED_TEMPLATE_ID = 'tmpl'
  config.CHANGED_TEMPLATE_ID = '' // 本测试只看候补通知
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 5 * 24 * 60 * MIN)

  for (const [id, name] of [['owner', '老王'], ['a', 'A'], ['b', 'B'], ['c', 'C']]) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: name })
  }
  const { clubId } = await api('owner', 'createClub', { name: '养生足球', venmo: '@club-fund' })
  const { venueId } = await api('owner', 'saveVenue', { clubId, venue: { name: 'MTV Garfield', ...VENUE, radiusM: 100 } })
  const { gameId } = await api('owner', 'saveGame', {
    clubId,
    form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId, capacity: 2, durationMin: 120 },
  })

  // 非管理员不能发起
  assert.match(await apiErr('a', 'gameForm', { clubId }), /你还不是该球队成员|需要管理员/)

  // 报名：owner 转发给 a/b/c
  assert.deepStrictEqual(await api('a', 'signup', { gameId, inviter: 'owner' }), { status: 'registered' })
  assert.deepStrictEqual(await api('b', 'signup', { gameId, inviter: 'owner' }), { status: 'registered' })
  assert.deepStrictEqual(
    await api('c', 'signup', { gameId, inviter: 'a', subscribed: true, envVersion: 'trial' }),
    { status: 'waitlist' },
  )
  assert.match(await apiErr('a', 'signup', { gameId }), /已经报名/)

  let g = await api('owner', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.name), ['A', 'B'])
  assert.strictEqual(g.registered[0].inviterName, '老王')
  assert.strictEqual(g.waitlist[0].inviterName, 'A')
  assert.strictEqual(g.registered[0].isNew, true)

  // 缺席截止前取消：free，C 递补并收到通知
  assert.deepStrictEqual(await api('a', 'cancelSignup', { gameId }), { phase: 'free', fined: false })
  g = await api('owner', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.name), ['B', 'C'])
  assert.strictEqual(fake.sent.length, 1)
  assert.strictEqual(fake.sent[0].touser, 'c')
  assert.strictEqual(fake.sent[0].data.thing1.value, 'C')
  assert.strictEqual(fake.sent[0].miniprogramState, 'trial')
  assert.strictEqual(fake.sent[0].data.time4.value, '2026年10月4日 10:00')
  for (const v of Object.values(fake.sent[0].data)) assert.ok(v.value.length <= 20, v.value)

  // A 再报名 → 替补
  assert.deepStrictEqual(await api('a', 'signup', { gameId }), { status: 'waitlist' })

  // 前一天 21:00 之后、开赛 1 小时前：warn，不罚款
  fake.setNow(T.zonedToUtcMs('2026-10-03', '21:30', tz))
  assert.deepStrictEqual(await api('c', 'cancelSignup', { gameId }), { phase: 'warn', fined: false })
  g = await api('owner', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.name), ['B', 'A']) // A 递补

  // C 没转发：管理员手动罚款；A 是截止前取消的，不能罚；非管理员不能罚
  assert.match(await apiErr('owner', 'fineNoForward', { gameId, target: 'a' }), /缺席截止后/)
  assert.match(await apiErr('b', 'fineNoForward', { gameId, target: 'c' }), /管理员/)
  const { fineId: nf } = await api('owner', 'fineNoForward', { gameId, target: 'c' })
  let cFines = (await api('c', 'listFines', { clubId })).fines
  assert.deepStrictEqual(cFines.map((f) => f.reasonText), ['缺席未转发'])
  // 这里豁免掉，不影响后面 C 重新排队
  await api('owner', 'resolveFines', { clubId, fineIds: [nf], op: 'waived', note: '已在群里说过' })

  // C 重新排队
  assert.deepStrictEqual(await api('c', 'signup', { gameId }), { status: 'waitlist' })

  // 开赛前 30 分钟：B 临时取消 → 罚款；C 递补（晚递补，免自动罚款）
  fake.setNow(startAt - 30 * MIN)
  assert.deepStrictEqual(await api('b', 'cancelSignup', { gameId }), { phase: 'penalty', fined: true })
  g = await api('owner', 'getGame', { gameId })
  assert.deepStrictEqual(g.registered.map((r) => r.name), ['A', 'C'])

  // B 有未付罚款，不能报下一场
  const { gameId: next } = await api('owner', 'saveGame', {
    clubId,
    form: { date: '2026-10-11', time: '10:00', timezone: tz, venueId },
  })
  assert.match(await apiErr('b', 'signup', { gameId: next }), /未付罚款 \$5\.00.*@club-fund/)

  // 签到：太远失败；在范围内成功
  assert.match(
    await apiErr('a', 'checkin', { gameId, lat: VENUE.lat + 0.01, lng: VENUE.lng }),
    /距离球场约 \d+ 米/,
  )
  fake.setNow(startAt + 5 * MIN)
  assert.strictEqual((await api('a', 'checkin', { gameId, lat: VENUE.lat + 0.0003, lng: VENUE.lng })).attendance, 'on_time')
  assert.match(await apiErr('a', 'cancelSignup', { gameId }), /已经签到/)

  // 签到码
  const { code } = await api('owner', 'getCheckinCode', { gameId })
  assert.match(await apiErr('a', 'getCheckinCode', { gameId }), /管理员/)

  // 截止后打开详情 → 自动结算。C 没签到但属于晚递补，不罚款
  fake.setNow(startAt + 11 * MIN)
  g = await api('a', 'getGame', { gameId })
  assert.ok(g.game.settledAt)
  const att = Object.fromEntries(g.registered.map((r) => [r.name, r.attendance]))
  assert.deepStrictEqual(att, { A: 'on_time', C: 'no_show' })

  // C 迟到签到（签到码已过期，用 GPS）
  assert.match(await apiErr('c', 'checkin', { gameId, code }), /签到码错误或已过期/)
  assert.strictEqual((await api('c', 'checkin', { gameId, ...VENUE })).attendance, 'late')

  // 管理员把 C 改为未到 → 手动产生罚款；再改回准时 → 豁免
  await api('owner', 'setAttendance', { gameId, target: 'c', attendance: 'no_show' })
  let fines = (await api('owner', 'listFines', { clubId, status: 'pending' })).fines
  assert.deepStrictEqual(fines.map((f) => [f.name, f.reasonText]).sort(), [['B', '临时取消'], ['C', '未到']])
  await api('owner', 'setAttendance', { gameId, target: 'c', attendance: 'on_time' })
  fines = (await api('owner', 'listFines', { clubId, status: 'pending' })).fines
  assert.deepStrictEqual(fines.map((f) => f.name), ['B'])

  // 比赛页：管理员能看到本场罚款，普通成员看不到
  const gf = (await api('owner', 'getGame', { gameId })).fines
  assert.deepStrictEqual(gf.filter((f) => f.status === 'pending').map((f) => [f.openid, f.reasonText]), [['b', '临时取消']])
  assert.deepStrictEqual((await api('a', 'getGame', { gameId })).fines, [])

  // 从比赛页给 A 加“穿钉鞋”罚款，关联本场
  await api('owner', 'addFine', { clubId, target: 'a', amountCents: 500, note: '穿钉鞋', gameId })
  const spike = (await api('owner', 'getGame', { gameId })).fines.find((f) => f.openid === 'a')
  assert.deepStrictEqual([spike.reasonText, spike.status], ['穿钉鞋', 'pending'])
  await api('owner', 'resolveFines', { clubId, fineIds: [spike._id], op: 'waived', note: '测试' })

  // 普通成员只能看到自己的罚款
  assert.deepStrictEqual((await api('a', 'listFines', { clubId })).fines.map((f) => f.openid), ['a'])

  // 期初余额 + B 付款 → 账本
  await api('owner', 'addLedgerEntry', { clubId, type: 'opening', amountCents: 12000, note: '从 Google Sheet 迁移' })
  await api('owner', 'resolveFines', { clubId, fineIds: [fines[0]._id], op: 'paid', method: 'venmo' })
  await api('owner', 'addLedgerEntry', { clubId, type: 'expense', amountCents: 4500, note: '买球' })
  let ledger = await api('a', 'getLedger', { clubId })
  assert.strictEqual(ledger.balanceCents, 12000 + 500 - 4500)
  assert.ok(ledger.entries.some((e) => e.payerName === 'B'))
  assert.match(await apiErr('a', 'addLedgerEntry', { clubId, type: 'income', amountCents: 1, note: 'x' }), /管理员/)

  // B 付清后可以报名
  assert.deepStrictEqual(await api('b', 'signup', { gameId: next }), { status: 'registered' })

  // 撤销已付 → 账本收入作废，B 又变成欠款
  await api('owner', 'resolveFines', { clubId, fineIds: [fines[0]._id], op: 'reopen' })
  ledger = await api('owner', 'getLedger', { clubId })
  assert.strictEqual(ledger.balanceCents, 12000 - 4500)

  // 豁免必须填原因
  assert.match(
    await apiErr('owner', 'resolveFines', { clubId, fineIds: [fines[0]._id], op: 'waived' }),
    /原因/,
  )

  // 管理员权限：owner 设 a 为管理员后 a 可以发起
  await api('owner', 'setRole', { clubId, target: 'a', role: 'admin' })
  assert.ok((await api('a', 'gameForm', { clubId, copyLast: true })).form)
  assert.match(await apiErr('a', 'setRole', { clubId, target: 'b', role: 'admin' }), /只有创建者/)

  // 客户端不能伪造 openid
  fake.as('a')
  const spoof = await main({ action: 'cancelSignup', gameId: next, openid: 'b' })
  assert.strictEqual(spoof.ok, false)
  ;[config.PROMOTED_TEMPLATE_ID, config.CHANGED_TEMPLATE_ID] = savedIds
})

test('scheduled signup opening and default cancel deadline', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 5 * 24 * 60 * MIN)
  await api('o', 'login')
  await api('o', 'updateProfile', { nickname: 'O' })
  await api('x', 'login')
  await api('x', 'updateProfile', { nickname: 'X' })
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const { gameId } = await api('o', 'saveGame', {
    clubId,
    form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId, signupOpens: { date: '2026-10-01', time: '20:00' } },
  })
  const g = await api('o', 'getGame', { gameId })
  assert.strictEqual(g.game.local.cancelDeadline, '10月3日(周六) 21:00')
  assert.match(await apiErr('x', 'signup', { gameId, inviter: 'o' }), /10月1日\(周四\) 20:00 开放/)
  fake.setNow(T.zonedToUtcMs('2026-10-01', '20:00', tz))
  assert.deepStrictEqual(await api('x', 'signup', { gameId, inviter: 'o' }), { status: 'registered' })

  // 复制上一场：日期顺延一周，开放时间也顺延
  const { form } = await api('o', 'gameForm', { clubId, copyLast: true })
  assert.strictEqual(form.date, '2026-10-11')
  assert.deepStrictEqual(form.signupOpens, { date: '2026-10-08', time: '20:00' })

  // 标题留空 → 自动生成；复制时仍然留空（换场地后跟着变）
  assert.strictEqual(g.game.title, '周日 · V')
  assert.strictEqual(form.title, '')

  // 开赛时间在过去：新建报错；已有比赛改到过去报错；不改时间照常保存
  assert.match(
    await apiErr('o', 'saveGame', { clubId, form: { date: '2026-09-28', time: '10:00', timezone: tz, venueId } }),
    /已经过了/,
  )
  assert.match(
    await apiErr('o', 'saveGame', { clubId, gameId, form: { date: '2026-09-28', time: '10:00', timezone: tz, venueId } }),
    /已经过了/,
  )
  fake.setNow(startAt + 5 * MIN) // 已开赛、未结算
  await api('o', 'saveGame', { clubId, gameId, form: { date: '2026-10-04', time: '10:00', timezone: tz, venueId, note: '改备注' } })
  fake.setNow(T.zonedToUtcMs('2026-10-01', '20:00', tz))

  // 单场自定义缺席截止；晚于开赛时间会被拒绝
  const { gameId: g2 } = await api('o', 'saveGame', {
    clubId,
    form: { date: '2026-10-11', time: '10:00', timezone: tz, venueId, cancelDeadline: { date: '2026-10-09', time: '20:00' } },
  })
  assert.strictEqual((await api('o', 'getGame', { gameId: g2 })).game.local.cancelDeadline, '10月9日(周五) 20:00')
  assert.deepStrictEqual((await api('o', 'gameForm', { clubId, gameId: g2 })).form.cancelDeadline, { date: '2026-10-09', time: '20:00' })
  assert.match(
    await apiErr('o', 'saveGame', { clubId, form: { date: '2026-10-11', time: '10:00', timezone: tz, venueId, cancelDeadline: { date: '2026-10-12', time: '20:00' } } }),
    /不能晚于开赛时间/,
  )

  // 模板：保存、同名覆盖、删除、非管理员不能存
  const tpl = { name: '周日 MTV', timezone: tz, weekday: 0, time: '10:00', durationMin: 120, venueId,
    capacity: 24, lateGraceMin: 10, fineCents: 500, signupOpens: { daysBefore: 3, time: '20:00' } }
  let { templates } = await api('o', 'saveTemplate', { clubId, template: tpl })
  ;({ templates } = await api('o', 'saveTemplate', { clubId, template: { ...tpl, capacity: 20 } }))
  assert.strictEqual(templates.length, 1)
  assert.strictEqual(templates[0].capacity, 20)
  assert.strictEqual((await api('o', 'gameForm', { clubId })).templates.length, 1)
  assert.match(await apiErr('o', 'saveTemplate', { clubId, template: { ...tpl, name: 'x', venueId: 'nope' } }), /场地/)
  assert.match(await apiErr('x', 'saveTemplate', { clubId, template: tpl }), /管理员/)
  ;({ templates } = await api('o', 'deleteTemplate', { clubId, templateId: templates[0].id }))
  assert.strictEqual(templates.length, 0)
})

test('time change and cancellation notify subscribers', async () => {
  fake.reset()
  config.CHANGED_TEMPLATE_ID = 'changed'
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 3 * 24 * 60 * MIN)
  for (const id of ['o', 'p', 'q']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const form = { date: '2026-10-04', time: '10:00', timezone: tz, venueId }
  const { gameId } = await api('o', 'saveGame', { clubId, form })
  await api('p', 'signup', { gameId, inviter: 'o', subscribedChange: true })
  await api('q', 'signup', { gameId, inviter: 'o' }) // 没订阅

  // 只改人数：不算变更，不通知
  let r = await api('o', 'saveGame', { clubId, gameId, form: { ...form, capacity: 30 } })
  assert.deepStrictEqual([r.changed, r.notified], [false, 0])

  // 改时间：通知 P，页面显示变更
  r = await api('o', 'saveGame', { clubId, gameId, form: { ...form, time: '11:00' } })
  assert.deepStrictEqual([r.changed, r.notified], [true, 1])
  assert.strictEqual(fake.sent[0].touser, 'p')
  assert.deepStrictEqual(fake.sent[0].data, {
    thing2: { value: '周日 · V' },
    date4: { value: '2026年10月4日 11:00' },
    thing5: { value: 'V' },
    thing6: { value: '时间变更' },
    thing10: { value: '请以小程序内最新安排为准' },
  })
  let g = await api('q', 'getGame', { gameId })
  assert.match(g.game.lastChange.text, /11:00–13:00/)

  // P 的订阅已用掉；再次订阅后取消比赛能收到
  assert.strictEqual(g.registered.find((x) => x.name === 'P').subscribedChange, false)
  await api('p', 'subscribeChange', { gameId })
  r = await api('o', 'cancelGame', { gameId, reason: '下雨场地湿滑' })
  assert.strictEqual(r.notified, 1)
  assert.strictEqual(fake.sent[1].data.thing6.value, '已取消：下雨场地湿滑')
  assert.strictEqual(fake.sent[1].data.thing10.value, '比赛已取消，请勿前往')

  // 取消后首页仍显示（带状态），详情有原因，不能再报名
  const { games } = await api('q', 'listGames')
  assert.deepStrictEqual(games.map((x) => [x.status, x.cancelReason]), [['cancelled', '下雨场地湿滑']])
  assert.match(await apiErr('q', 'cancelGame', { gameId }), /管理员/)
  assert.match(await apiErr('o', 'cancelGame', { gameId }), /已经取消/)

  // 结束后进入历史列表
  fake.setNow(startAt + 10 * 60 * MIN) // 比赛 11:00–13:00，结束 6 小时后
  assert.strictEqual((await api('p', 'listGames')).games.length, 0)
  const hist = (await api('p', 'listGames', { history: true })).games
  assert.deepStrictEqual(hist.map((x) => [x._id, x.myStatus]), [[gameId, 'registered']])
  config.CHANGED_TEMPLATE_ID = ''
})

test('cancelling or rescheduling a game clears fines that no longer apply', async () => {
  fake.reset()
  const startAt = T.zonedToUtcMs('2026-10-04', '10:00', tz)
  fake.setNow(startAt - 3 * 24 * 60 * MIN)
  for (const id of ['o', 'p', 'q']) {
    await api(id, 'login')
    await api(id, 'updateProfile', { nickname: id.toUpperCase() })
  }
  const { clubId } = await api('o', 'createClub', { name: 'T' })
  const { venueId } = await api('o', 'saveVenue', { clubId, venue: { name: 'V', ...VENUE } })
  const form = { date: '2026-10-04', time: '10:00', timezone: tz, venueId }
  const { gameId } = await api('o', 'saveGame', { clubId, form })
  await api('p', 'signup', { gameId, inviter: 'o' })
  await api('q', 'signup', { gameId, inviter: 'o' })

  // P 开赛前 30 分钟临时取消 → 罚款；Q 截止后取消 → 管理员罚“未转发”
  fake.setNow(T.zonedToUtcMs('2026-10-03', '22:00', tz))
  await api('q', 'cancelSignup', { gameId })
  await api('o', 'fineNoForward', { gameId, target: 'q' })
  fake.setNow(startAt - 30 * MIN)
  assert.strictEqual((await api('p', 'cancelSignup', { gameId })).phase, 'penalty')
  const pending = async () => (await api('o', 'listFines', { clubId, status: 'pending' })).fines.map((f) => f.reasonText).sort()
  assert.deepStrictEqual(await pending(), ['临时取消', '缺席未转发'])

  // 改到 14:00：P 按新时间是提前 4.5 小时取消 → 撤销；Q 仍在截止后 → 保留
  await api('o', 'saveGame', { clubId, gameId, form: { ...form, time: '14:00' } })
  assert.deepStrictEqual(await pending(), ['缺席未转发'])
  const g = await api('o', 'getGame', { gameId })
  assert.strictEqual(g.cancelled.find((r) => r.name === 'P').cancelPhase, 'warn')

  // 改到周五：截止变成周四 21:00，Q 周六 22:00 取消仍在截止后……再改到下周日：Q 变成截止前 → 撤销“未转发”
  await api('o', 'saveGame', { clubId, gameId, form: { ...form, date: '2026-10-11', time: '10:00' } })
  assert.deepStrictEqual(await pending(), [])

  // 取消比赛：本场剩余待付罚款全部豁免
  const { gameId: g2 } = await api('o', 'saveGame', { clubId, form: { ...form, date: '2026-10-18' } })
  await api('p', 'signup', { gameId: g2 })
  await api('o', 'addFine', { clubId, target: 'p', amountCents: 500, note: '与比赛无关' })
  fake.setNow(T.zonedToUtcMs('2026-10-18', '09:30', tz))
  await api('p', 'cancelSignup', { gameId: g2 })
  assert.strictEqual((await api('o', 'cancelGame', { gameId: g2, reason: '下雨' })).waived, 1)
  const left = (await api('o', 'listFines', { clubId, status: 'pending' })).fines
  assert.deepStrictEqual(left.map((f) => f.reasonText), ['与比赛无关']) // 别的罚款不受影响
  const waived = (await api('o', 'listFines', { clubId, status: 'waived' })).fines.find((f) => f.gameId === g2)
  assert.strictEqual(waived.note, '比赛取消：下雨')
})
