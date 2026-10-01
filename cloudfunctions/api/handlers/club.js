const {
  db,
  _,
  UserError,
  getDoc,
  mustGet,
  listAll,
  memberId,
  getMember,
  requireMember,
  requireAdmin,
  isAdminRole,
} = require('../lib/db')
const { DEFAULT_SETTINGS } = require('../lib/rules')
const { isValidTimeZone } = require('../lib/time')

function cleanSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS }
  const ints = {
    capacity: [1, 100],
    durationMin: [15, 600],
    lateGraceMin: [0, 120],
    fineCents: [0, 100000],
    checkinRadiusM: [30, 2000],
    checkinOpenBeforeMin: [0, 240],
    penaltyWindowMin: [0, 24 * 60],
    cancelDeadlineDaysBefore: [0, 7],
  }
  for (const [k, [lo, hi]] of Object.entries(ints)) {
    if (input[k] === undefined || input[k] === '') continue
    const v = Math.round(Number(input[k]))
    if (!Number.isFinite(v) || v < lo || v > hi) throw new UserError(`设置项 ${k} 需在 ${lo}–${hi} 之间`)
    s[k] = v
  }
  if (input.timezone !== undefined) {
    if (!isValidTimeZone(input.timezone)) throw new UserError('时区无效')
    s.timezone = input.timezone
  }
  if (input.cancelDeadlineTime !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(input.cancelDeadlineTime)) throw new UserError('截止时间格式应为 HH:mm')
    s.cancelDeadlineTime = input.cancelDeadlineTime
  }
  return s
}

async function requireNickname(openid) {
  const user = await getDoc('users', openid)
  if (!user || !user.nickname) throw new UserError('请先设置昵称')
  return user
}

// 通过报名进入球队时自动成为成员，并记下邀请人
async function ensureMember(clubId, openid, inviter) {
  const existing = await getMember(clubId, openid)
  if (existing) return existing
  const user = await requireNickname(openid)
  const validInviter = inviter && inviter !== openid && (await getMember(clubId, inviter)) ? inviter : ''
  const member = {
    clubId,
    openid,
    name: user.nickname,
    role: 'member',
    inviter: validInviter,
    joinedAt: Date.now(),
  }
  await db.collection('members').doc(memberId(clubId, openid)).set({ data: member })
  return { _id: memberId(clubId, openid), ...member }
}

async function createClub({ openid, name, venmo }) {
  const user = await requireNickname(openid)
  name = String(name || '').trim()
  if (!name || name.length > 30) throw new UserError('球队名称需为 1–30 个字')
  const now = Date.now()
  const res = await db.collection('clubs').add({
    data: {
      name,
      venmo: String(venmo || '').trim(),
      ownerOpenid: openid,
      settings: { ...DEFAULT_SETTINGS },
      createdAt: now,
    },
  })
  await db
    .collection('members')
    .doc(memberId(res._id, openid))
    .set({
      data: { clubId: res._id, openid, name: user.nickname, role: 'owner', inviter: '', joinedAt: now },
    })
  return { clubId: res._id }
}

async function getClub({ openid, clubId }) {
  const club = await mustGet('clubs', clubId, '球队')
  const me = await requireMember(clubId, openid)
  const [members, venues] = await Promise.all([
    listAll(db.collection('members').where({ clubId }).orderBy('joinedAt', 'asc')),
    listAll(db.collection('venues').where({ clubId }).orderBy('name', 'asc')),
  ])
  const users = await listAll(db.collection('users').where({ _id: _.in(members.map((m) => m.openid)) }))
  const avatars = Object.fromEntries(users.map((u) => [u._id, u.avatar || '']))
  const names = Object.fromEntries(members.map((m) => [m.openid, m.name]))
  const isAdmin = isAdminRole(me.role)
  let pendingFines = 0
  if (isAdmin) {
    pendingFines = (await db.collection('fines').where({ clubId, status: 'pending' }).count()).total
  }
  return {
    club: { _id: club._id, name: club.name, venmo: club.venmo, settings: club.settings, ownerOpenid: club.ownerOpenid },
    me: { role: me.role, name: me.name, isAdmin, isOwner: me.role === 'owner' },
    members: members.map((m) => ({
      openid: m.openid,
      name: m.name,
      role: m.role,
      avatar: avatars[m.openid] || '',
      inviterName: m.inviter ? names[m.inviter] || '' : '',
      joinedAt: m.joinedAt,
    })),
    venues,
    pendingFines,
  }
}

async function updateClub({ openid, clubId, name, venmo, settings }) {
  await requireAdmin(clubId, openid)
  const club = await mustGet('clubs', clubId, '球队')
  const data = { settings: cleanSettings({ ...club.settings, ...settings }) }
  if (name !== undefined) {
    name = String(name).trim()
    if (!name || name.length > 30) throw new UserError('球队名称需为 1–30 个字')
    data.name = name
  }
  if (venmo !== undefined) data.venmo = String(venmo).trim()
  await db.collection('clubs').doc(clubId).update({ data })
  return {}
}

async function setRole({ openid, clubId, target, role }) {
  const me = await requireMember(clubId, openid)
  if (me.role !== 'owner') throw new UserError('只有创建者可以设置管理员')
  if (!['admin', 'member'].includes(role)) throw new UserError('角色无效')
  const m = await getMember(clubId, target)
  if (!m) throw new UserError('成员不存在')
  if (m.role === 'owner') throw new UserError('不能修改创建者的角色')
  await db.collection('members').doc(memberId(clubId, target)).update({ data: { role } })
  return {}
}

// 管理员改成员在本队的名字（防止有人叫“嗯”）
async function renameMember({ openid, clubId, target, name }) {
  if (target !== openid) await requireAdmin(clubId, openid)
  name = String(name || '').trim()
  if (!name || name.length > 20) throw new UserError('名字需为 1–20 个字')
  if (!(await getMember(clubId, target))) throw new UserError('成员不存在')
  await db.collection('members').doc(memberId(clubId, target)).update({ data: { name } })
  return {}
}

async function saveVenue({ openid, clubId, venue }) {
  await requireAdmin(clubId, openid)
  const lat = Number(venue.lat)
  const lng = Number(venue.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new UserError('坐标无效')
  }
  const name = String(venue.name || '').trim()
  if (!name) throw new UserError('请填写场地名称')
  const data = {
    clubId,
    name,
    address: String(venue.address || '').trim(),
    lat,
    lng,
    radiusM: Math.max(30, Math.min(2000, Math.round(Number(venue.radiusM) || DEFAULT_SETTINGS.checkinRadiusM))),
  }
  if (venue._id) {
    const old = await mustGet('venues', venue._id, '场地')
    if (old.clubId !== clubId) throw new UserError('场地不属于该球队')
    await db.collection('venues').doc(venue._id).update({ data })
    return { venueId: venue._id }
  }
  const res = await db.collection('venues').add({ data })
  return { venueId: res._id }
}

async function deleteVenue({ openid, clubId, venueId }) {
  await requireAdmin(clubId, openid)
  const v = await mustGet('venues', venueId, '场地')
  if (v.clubId !== clubId) throw new UserError('场地不属于该球队')
  await db.collection('venues').doc(venueId).remove()
  return {}
}

// 比赛模板：存在 club.templates 里，最多 5 个。
// 日期不存具体日期，只存星期几；开放报名存“比赛前几天几点”。
const MAX_TEMPLATES = 5

function cleanTemplate(t) {
  const int = (v, lo, hi, what) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${what}无效`)
    return n
  }
  const hhmm = (v, what) => {
    if (!/^\d{2}:\d{2}$/.test(String(v))) throw new UserError(`${what}无效`)
    return String(v)
  }
  const name = String(t.name || '').trim().slice(0, 20)
  if (!name) throw new UserError('请填写模板名称')
  if (!isValidTimeZone(t.timezone)) throw new UserError('时区无效')
  return {
    id: t.id || `t${Date.now()}`,
    name,
    title: String(t.title || '').trim().slice(0, 30),
    note: String(t.note || '').slice(0, 500),
    timezone: t.timezone,
    weekday: int(t.weekday, 0, 6, '星期'),
    time: hhmm(t.time, '开始时间'),
    durationMin: int(t.durationMin, 15, 600, '时长'),
    venueId: String(t.venueId || ''),
    capacity: int(t.capacity, 1, 100, '人数上限'),
    teamSize: int(t.teamSize ?? 8, 2, 20, '每队人数'),
    teamCount: int(t.teamCount ?? 3, 2, 6, '队数'),
    autoTeams: !!t.autoTeams,
    goalkeeper: !!t.autoTeams && !!t.goalkeeper,
    lateGraceMin: int(t.lateGraceMin, 0, 120, '迟到宽限'),
    fineCents: int(t.fineCents, 0, 100000, '罚款金额'),
    signupOpens: t.signupOpens
      ? { daysBefore: int(t.signupOpens.daysBefore, 0, 14, '开放报名天数'), time: hhmm(t.signupOpens.time, '开放时间') }
      : null,
  }
}

async function saveTemplate({ openid, clubId, template }) {
  await requireAdmin(clubId, openid)
  const club = await mustGet('clubs', clubId, '球队')
  const t = cleanTemplate(template || {})
  const venue = await getDoc('venues', t.venueId)
  if (!venue || venue.clubId !== clubId) throw new UserError('请先选择场地')
  const list = (club.templates || []).filter((x) => x.id !== t.id && x.name !== t.name)
  if (list.length >= MAX_TEMPLATES) throw new UserError(`最多保存 ${MAX_TEMPLATES} 个模板，请先删除一个`)
  const templates = [...list, t]
  await db.collection('clubs').doc(clubId).update({ data: { templates } })
  return { templates }
}

async function deleteTemplate({ openid, clubId, templateId }) {
  await requireAdmin(clubId, openid)
  const club = await mustGet('clubs', clubId, '球队')
  const templates = (club.templates || []).filter((x) => x.id !== templateId)
  await db.collection('clubs').doc(clubId).update({ data: { templates } })
  return { templates }
}

module.exports = {
  cleanSettings,
  saveTemplate,
  deleteTemplate,
  requireNickname,
  ensureMember,
  createClub,
  getClub,
  updateClub,
  setRole,
  renameMember,
  saveVenue,
  deleteVenue,
}
