// 报名开放提醒：用户点“报名开放时提醒我”后，报名开放时发一条订阅消息。
// 定时器每 5 分钟跑一次，所以会在开放后 0～5 分钟内送达。
// 管理员改开放时间时同步调整；取消定时开放或取消比赛时作废。
const { cloud, db, _, UserError, getDoc, mustGet, listAll, regId } = require('../lib/db')
const T = require('../lib/time')
const config = require('../config')

const LEAD_MS = 0 // 开放时提醒（不提前）
const MP_STATE = { develop: 'developer', trial: 'trial', release: 'formal' }

async function setOpenReminder({ openid, gameId, envVersion }) {
  const game = await mustGet('games', gameId, '比赛')
  if (game.status !== 'active') throw new UserError('比赛已取消')
  if (!game.signupOpensAt || game.signupOpensAt <= Date.now()) throw new UserError('报名已经开放了')
  await db
    .collection('reminders')
    .doc(regId(gameId, openid))
    .set({
      data: {
        gameId,
        openid,
        remindAt: game.signupOpensAt - LEAD_MS,
        sent: false,
        mpState: MP_STATE[envVersion] || 'formal',
        createdAt: Date.now(),
      },
    })
  return {}
}

async function hasOpenReminder(gameId, openid) {
  const r = await getDoc('reminders', regId(gameId, openid))
  return !!r && !r.sent
}

// 比赛开放时间变了 / 取消了：调整或作废未发送的提醒
async function syncReminders(game) {
  const pending = db.collection('reminders').where({ gameId: game._id, sent: false })
  if (game.status !== 'active' || !game.signupOpensAt) {
    await pending.remove()
    return
  }
  await pending.update({ data: { remindAt: game.signupOpensAt - LEAD_MS } })
}

const STALE_MS = 30 * 60 * 1000 // 开放超过 30 分钟还没发出的提醒不再发
const MAX_ATTEMPTS = 3
// 这些错误重试也没用：用户没授权/授权已用完、字段不合法、模板不对、用户拒收
const PERMANENT = new Set([43101, 47003, 40037, 43107])

async function remindDue() {
  const now = Date.now()
  const due = await listAll(db.collection('reminders').where({ sent: false, remindAt: _.lte(now) }), 200)
  let sent = 0
  let failed = 0
  for (const r of due) {
    // 先标记，避免下一次定时器重复处理
    const claim = await db.collection('reminders').where({ _id: r._id, sent: false }).update({ data: { sent: true } })
    if (claim.stats.updated !== 1) continue
    const game = await getDoc('games', r.gameId)
    if (!game || game.status !== 'active' || !game.signupOpensAt) continue
    if (now - r.remindAt > STALE_MS) {
      await db.collection('reminders').doc(r._id).update({ data: { result: 'stale' } })
      continue
    }
    if (!config.OPEN_TEMPLATE_ID) {
      console.warn('OPEN_TEMPLATE_ID 未配置，跳过开放提醒', r._id)
      continue
    }
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: r.openid,
        templateId: config.OPEN_TEMPLATE_ID,
        page: `pages/game/game?id=${game._id}`,
        miniprogramState: r.mpState || 'formal',
        data: config.buildOpenData({
          gameTitle: game.title,
          startText: T.fmtPlain(game.startAt, game.timezone),
          venueName: game.venue.name,
        }),
      })
      await db.collection('reminders').doc(r._id).update({ data: { result: 'delivered', deliveredAt: Date.now() } })
      sent++
    } catch (e) {
      failed++
      const code = e && e.errCode
      const attempts = (r.attempts || 0) + 1
      const retry = !PERMANENT.has(code) && attempts < MAX_ATTEMPTS
      console.error('open reminder failed', r.openid, code, e && (e.errMsg || e.message), retry ? 'will retry' : 'giving up')
      await db
        .collection('reminders')
        .doc(r._id)
        .update({ data: { sent: !retry, attempts, result: `error ${code}` } })
    }
  }
  return { reminded: sent, remindFailed: failed }
}

module.exports = { LEAD_MS, setOpenReminder, hasOpenReminder, syncReminders, remindDue }
