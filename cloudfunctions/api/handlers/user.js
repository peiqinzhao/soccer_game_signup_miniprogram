const { db, _, UserError, getDoc, listAll } = require('../lib/db')

async function myClubs(openid) {
  const members = await listAll(db.collection('members').where({ openid }))
  if (!members.length) return []
  const clubs = await listAll(db.collection('clubs').where({ _id: _.in(members.map((m) => m.clubId)) }))
  const byId = Object.fromEntries(clubs.map((c) => [c._id, c]))
  return members
    .filter((m) => byId[m.clubId])
    .map((m) => ({ clubId: m.clubId, clubName: byId[m.clubId].name, role: m.role, name: m.name }))
}

async function login({ openid }) {
  let user = await getDoc('users', openid)
  if (!user) {
    user = { nickname: '', avatar: '', createdAt: Date.now() }
    await db.collection('users').doc(openid).set({ data: user })
  }
  return { openid, nickname: user.nickname, avatar: user.avatar, clubs: await myClubs(openid) }
}

// 自己改名会同步到自己所在的所有球队
async function updateProfile({ openid, nickname, avatar }) {
  const data = {}
  if (nickname !== undefined) {
    nickname = String(nickname).trim()
    if (!nickname || nickname.length > 20) throw new UserError('昵称需为 1–20 个字')
    data.nickname = nickname
  }
  if (avatar !== undefined) data.avatar = String(avatar)
  await db.collection('users').doc(openid).update({ data })
  if (data.nickname) {
    await db.collection('members').where({ openid }).update({ data: { name: data.nickname } })
  }
  return login({ openid })
}

module.exports = { login, updateProfile, myClubs }
