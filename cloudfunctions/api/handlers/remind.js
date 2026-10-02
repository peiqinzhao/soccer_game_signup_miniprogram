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

async function remindDue() {
  const due = await listAll(db.collection('reminders').where({ sent: false, remindAt: _.lte(Date.now()) }), 200)
  let sent = 0
  for (const r of due) {
    // 先标记，避免下一分钟重复发
    const claim = await db.collection('reminders').where({ _id: r._id, sent: false }).update({ data: { sent: true } })
    if (claim.stats.updated !== 1) continue
    const game = await getDoc('games', r.gameId)
    if (!game || game.status !== 'active' || !game.signupOpensAt) continue
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
      sent++
    } catch (e) {
      // 常见错误码：43101 用户未授权/授权已用完；47003 字段内容不合法；40037 模板 ID 不对
      console.error('open reminder failed', r.openid, e && (e.errCode || e.errMsg || e.message))
    }
  }
  return { reminded: sent }
}

module.exports = { LEAD_MS, setOpenReminder, hasOpenReminder, syncReminders, remindDue }
