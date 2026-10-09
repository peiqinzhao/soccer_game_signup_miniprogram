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

// 结算可以分多次完成：函数可能在中途超时被结束，下次定时器会接着处理还没判定出勤的人。
// 全部处理完才标记 settleDone。出勤只给还没判定的人判，不会覆盖管理员的修正；罚款按 ID 去重，重复执行安全。
async function settleGame(game) {
  const now = Date.now()
  if (!game.settledAt) {
    await db
      .collection('games')
      .where({ _id: game._id, status: 'active', settledAt: 0 })
      .update({ data: { settledAt: now } })
  }

  const regs = await listAll(
    db.collection('registrations').where({ gameId: game._id, status: 'registered', attendance: '' }),
  )
  for (const reg of regs) {
    const attendance = rules.attendanceFor(reg.checkinAt, game)
    // 先生成罚款再记出勤：中途被打断时，这个人下次还会被处理（罚款按 ID 去重）
    if (attendance !== 'on_time' && game.fineCents > 0 && !rules.isLatePromotion(reg, game)) {
      await createFine({
        clubId: game.clubId,
        gameId: game._id,
        openid: reg.openid,
        kind: 'attendance',
        reason: attendance,
        amountCents: game.fineCents,
      })
    }
    await db.collection('registrations').doc(reg._id).update({ data: { attendance } })
  }
  await db.collection('games').doc(game._id).update({ data: { settleDone: true } })
  return true
}

async function maybeSettle(game) {
  if (game.status === 'active' && !game.settleDone && Date.now() >= game.cutoffAt) {
    return settleGame(game)
  }
  return false
}

// 只看最近 7 天截止的比赛（更早的早已处理完）
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

async function settleDue() {
  const now = Date.now()
  const games = await listAll(
    db.collection('games').where({
      status: 'active',
      settleDone: _.neq(true),
      cutoffAt: _.and(_.lte(now), _.gte(now - LOOKBACK_MS)),
    }),
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
