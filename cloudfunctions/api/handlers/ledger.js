// 足球基金账本：所有成员可看，管理员记账。罚款标记已付时自动入账（见 fine.js）。
const { db, UserError, mustGet, listAll, requireMember, requireAdmin, isAdminRole, profilesFor } = require('../lib/db')

const TYPES = ['income', 'expense', 'opening']

function signed(e) {
  return e.type === 'expense' ? -e.amountCents : e.amountCents
}

async function getLedger({ openid, clubId }) {
  const me = await requireMember(clubId, openid)
  const entries = await listAll(db.collection('ledger').where({ clubId }).orderBy('date', 'desc'))
  const live = entries.filter((e) => !e.voided)
  const profiles = await profilesFor(clubId, entries.flatMap((e) => [e.createdBy, e.payerOpenid]))
  const nameOf = (id) => (id && profiles[id] ? profiles[id].name : '')
  return {
    isAdmin: isAdminRole(me.role),
    balanceCents: live.reduce((sum, e) => sum + signed(e), 0),
    incomeCents: live.filter((e) => e.type !== 'expense').reduce((s, e) => s + e.amountCents, 0),
    expenseCents: live.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amountCents, 0),
    entries: entries.map((e) => ({
      _id: e._id,
      type: e.type,
      amountCents: e.amountCents,
      signedCents: signed(e),
      note: e.note,
      date: e.date,
      receipt: e.receipt || '',
      fineId: e.fineId || '',
      payerName: nameOf(e.payerOpenid),
      createdByName: nameOf(e.createdBy),
      voided: !!e.voided,
    })),
  }
}

async function addLedgerEntry({ openid, clubId, type, amountCents, note, date, receipt }) {
  await requireAdmin(clubId, openid)
  if (!TYPES.includes(type)) throw new UserError('类型无效')
  const cents = Math.round(Number(amountCents))
  if (!Number.isFinite(cents) || cents <= 0 || cents > 10000000) throw new UserError('金额无效')
  note = String(note || '').trim()
  if (!note) throw new UserError('请填写说明')
  const now = Date.now()
  await db.collection('ledger').add({
    data: {
      clubId,
      type,
      amountCents: cents,
      note: note.slice(0, 100),
      date: Number(date) || now,
      fineId: '',
      payerOpenid: '',
      receipt: String(receipt || ''),
      createdBy: openid,
      createdAt: now,
      voided: false,
    },
  })
  return {}
}

// 作废而不是删除，保留痕迹
async function voidLedgerEntry({ openid, clubId, entryId }) {
  await requireAdmin(clubId, openid)
  const e = await mustGet('ledger', entryId, '记录')
  if (e.clubId !== clubId) throw new UserError('记录不属于该球队')
  if (e.fineId) throw new UserError('罚款收入请在罚款管理里“撤销”')
  await db.collection('ledger').doc(entryId).update({ data: { voided: true, voidedBy: openid, voidedAt: Date.now() } })
  return {}
}

module.exports = { getLedger, addLedgerEntry, voidLedgerEntry }
