const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 抛给用户看的错误（会原样显示在 toast 里）
class UserError extends Error {}

async function getDoc(collection, id) {
  try {
    const res = await db.collection(collection).doc(id).get()
    return res.data
  } catch (e) {
    return null
  }
}

async function mustGet(collection, id, what) {
  const doc = await getDoc(collection, id)
  if (!doc) throw new UserError(`${what}不存在`)
  return doc
}

async function listAll(query, limit = 1000) {
  const res = await query.limit(limit).get()
  return res.data
}

const memberId = (clubId, openid) => `${clubId}_${openid}`
const regId = (gameId, openid) => `${gameId}_${openid}`

async function getMember(clubId, openid) {
  return getDoc('members', memberId(clubId, openid))
}

async function requireMember(clubId, openid) {
  const m = await getMember(clubId, openid)
  if (!m) throw new UserError('你还不是该球队成员')
  return m
}

const isAdminRole = (role) => role === 'owner' || role === 'admin'

async function requireAdmin(clubId, openid) {
  const m = await requireMember(clubId, openid)
  if (!isAdminRole(m.role)) throw new UserError('需要管理员权限')
  return m
}

// 名字 + 头像，按 openid 映射
async function profilesFor(clubId, openids) {
  const ids = [...new Set(openids.filter(Boolean))]
  if (!ids.length) return {}
  const [members, users] = await Promise.all([
    listAll(db.collection('members').where({ clubId, openid: _.in(ids) })),
    listAll(db.collection('users').where({ _id: _.in(ids) })),
  ])
  const map = {}
  for (const u of users) map[u._id] = { name: u.nickname || '未命名', avatar: u.avatar || '', joinedAt: 0 }
  for (const m of members) {
    map[m.openid] = { ...(map[m.openid] || { avatar: '' }), name: m.name, joinedAt: m.joinedAt }
  }
  return map
}

module.exports = {
  cloud,
  db,
  _,
  UserError,
  getDoc,
  mustGet,
  listAll,
  memberId,
  regId,
  getMember,
  requireMember,
  requireAdmin,
  isAdminRole,
  profilesFor,
}
