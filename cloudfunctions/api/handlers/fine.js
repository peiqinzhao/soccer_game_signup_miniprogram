const { db, _, UserError, getDoc, listAll, requireMember, requireAdmin, isAdminRole, profilesFor } =
  require('../lib/db')
const { FINE_REASONS } = require('../lib/rules')
const T = require('../lib/time')
const { createFine } = require('./settle')

async function enrich(clubId, fines) {
  const profiles = await profilesFor(clubId, fines.map((f) => f.openid))
  const gameIds = [...new Set(fines.map((f) => f.gameId).filter(Boolean))]
  const games = gameIds.length ? await listAll(db.collection('games').where({ _id: _.in(gameIds) })) : []
  const gameText = Object.fromEntries(games.map((g) => [g._id, `${T.fmtLocal(g.startAt, g.timezone)} ${g.venue.name}`]))
  return fines.map((f) => ({
    ...f,
    name: (profiles[f.openid] || {}).name || '未命名',
    avatar: (profiles[f.openid] || {}).avatar || '',
    reasonText: f.detail || FINE_REASONS[f.reason] || f.reason,
    gameText: gameText[f.gameId] || '',
  }))
}

// 管理员看全队；普通成员只能看自己的
async function listFines({ openid, clubId, status, mine }) {
  const me = await requireMember(clubId, openid)
  const where = { clubId }
  if (mine || !isAdminRole(me.role)) where.openid = openid
  if (status) where.status = status
  const fines = await listAll(db.collection('fines').where(where).orderBy('createdAt', 'desc'), 500)
  const club = await getDoc('clubs', clubId)
  return { fines: await enrich(clubId, fines), isAdmin: isAdminRole(me.role), venmo: (club && club.venmo) || '' }
}

// “我的”页：所有球队里自己的待付罚款
async function myPendingFines({ openid }) {
  const fines = await listAll(db.collection('fines').where({ openid, status: 'pending' }).orderBy('createdAt', 'desc'))
  const clubIds = [...new Set(fines.map((f) => f.clubId))]
  const clubs = clubIds.length ? await listAll(db.collection('clubs').where({ _id: _.in(clubIds) })) : []
  const byId = Object.fromEntries(clubs.map((c) => [c._id, c]))
  return {
    fines: fines.map((f) => ({
      _id: f._id,
      clubId: f.clubId,
      clubName: (byId[f.clubId] || {}).name || '',
      venmo: (byId[f.clubId] || {}).venmo || '',
      amountCents: f.amountCents,
      reasonText: f.detail || FINE_REASONS[f.reason] || f.reason,
      createdAt: f.createdAt,
    })),
  }
}

// op: paid | waived | reopen（不能叫 action，那是路由字段）
async function resolveFines({ openid, clubId, fineIds, op, method, note }) {
  await requireAdmin(clubId, openid)
  if (!Array.isArray(fineIds) || !fineIds.length) throw new UserError('请选择罚款')
  if (!['paid', 'waived', 'reopen'].includes(op)) throw new UserError('操作无效')
  if (op === 'waived' && !String(note || '').trim()) throw new UserError('豁免需要填写原因')
  if (op === 'paid' && !['venmo', 'cash'].includes(method)) throw new UserError('请选择付款方式')

  const fines = await listAll(db.collection('fines').where({ _id: _.in(fineIds), clubId }))
  const profiles = await profilesFor(clubId, fines.map((f) => f.openid))
  const now = Date.now()
  let changed = 0
  for (const f of fines) {
    if (op === 'reopen') {
      if (f.status === 'pending') continue
      await db
        .collection('fines')
        .doc(f._id)
        .update({ data: { status: 'pending', method: '', note: '', resolvedBy: '', resolvedAt: 0 } })
      if (await getDoc('ledger', `fine_${f._id}`)) {
        await db.collection('ledger').doc(`fine_${f._id}`).update({ data: { voided: true } })
      }
    } else {
      if (f.status !== 'pending') continue
      await db
        .collection('fines')
        .doc(f._id)
        .update({
          data: {
            status: op,
            method: op === 'paid' ? method : '',
            note: String(note || '').trim(),
            resolvedBy: openid,
            resolvedAt: now,
          },
        })
      if (op === 'paid') {
        const name = (profiles[f.openid] || {}).name || ''
        await db
          .collection('ledger')
          .doc(`fine_${f._id}`)
          .set({
            data: {
              clubId,
              type: 'income',
              amountCents: f.amountCents,
              note: `罚款 · ${name} · ${FINE_REASONS[f.reason] || f.reason} · ${method === 'venmo' ? 'Venmo' : '现金'}`,
              date: now,
              fineId: f._id,
              payerOpenid: f.openid,
              receipt: '',
              createdBy: openid,
              createdAt: now,
              voided: false,
            },
          })
      }
    }
    changed++
  }
  return { changed }
}

// 手动罚款（例如穿非 turf 鞋伤人）
// gameId 可选：从比赛页添加时关联到那场比赛
async function addFine({ openid, clubId, target, amountCents, note, gameId }) {
  await requireAdmin(clubId, openid)
  await requireMember(clubId, target)
  if (gameId) {
    const game = await getDoc('games', gameId)
    if (!game || game.clubId !== clubId) throw new UserError('比赛不属于该球队')
  }
  const cents = Math.round(Number(amountCents))
  if (!Number.isFinite(cents) || cents <= 0 || cents > 100000) throw new UserError('金额无效')
  if (!String(note || '').trim()) throw new UserError('请填写原因')
  await createFine({
    clubId,
    gameId: gameId || '',
    openid: target,
    kind: `manual_${Date.now()}`,
    reason: 'manual',
    amountCents: cents,
    detail: String(note).trim(),
    createdBy: openid,
  })
  return {}
}

module.exports = { listFines, myPendingFines, resolveFines, addFine }
