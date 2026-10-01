// 截止时间后自动判定出勤并生成罚款。由定时触发器每 5 分钟调用，
// 打开比赛详情时也会顺手触发一次（不必等定时器）。
const { db, _, getDoc, listAll } = require('../lib/db')
const rules = require('../lib/rules')

// kind: 'attendance'（迟到/未到）| 'cancel'（临时取消）| 'manual_xxx'
// 同一场同一人同一类只会有一条罚款
async function createFine({ clubId, gameId, openid, kind, reason, amountCents, detail = '', createdBy = 'system' }) {
  const id = `${gameId || 'none'}_${openid}_${kind}`
  const existing = await getDoc('fines', id)
  if (existing) return existing
  const fine = {
    clubId,
    gameId: gameId || '',
    openid,
    kind,
    reason,
    amountCents,
    status: 'pending',
    detail, // 手动罚款的原因
    note: '', // 处理备注（豁免原因等）
    createdBy,
    createdAt: Date.now(),
  }
  await db.collection('fines').doc(id).set({ data: fine })
  return { _id: id, ...fine }
}

async function settleGame(game) {
  const now = Date.now()
  // 抢占：只有把 settledAt 从 0 改掉的那次调用负责结算
  const claim = await db
    .collection('games')
    .where({ _id: game._id, status: 'active', settledAt: 0 })
    .update({ data: { settledAt: now } })
  if (claim.stats.updated !== 1) return false

  const regs = await listAll(db.collection('registrations').where({ gameId: game._id, status: 'registered' }))
  for (const reg of regs) {
    const attendance = rules.attendanceFor(reg.checkinAt, game)
    await db.collection('registrations').doc(reg._id).update({ data: { attendance } })
    if (attendance === 'on_time' || game.fineCents <= 0 || rules.isLatePromotion(reg, game)) continue
    await createFine({
      clubId: game.clubId,
      gameId: game._id,
      openid: reg.openid,
      kind: 'attendance',
      reason: attendance,
      amountCents: game.fineCents,
    })
  }
  return true
}

async function maybeSettle(game) {
  if (game.status === 'active' && !game.settledAt && Date.now() >= game.cutoffAt) {
    return settleGame(game)
  }
  return false
}

async function settleDue() {
  const games = await listAll(
    db.collection('games').where({ status: 'active', settledAt: 0, cutoffAt: _.lte(Date.now()) }),
    100,
  )
  for (const g of games) {
    try {
      await settleGame(g)
    } catch (e) {
      console.error('settle failed', g._id, e)
    }
  }
  return { settled: games.length }
}

module.exports = { createFine, settleGame, maybeSettle, settleDue }
