const crypto = require('crypto')
const {
  cloud,
  db,
  _,
  UserError,
  getDoc,
  mustGet,
  listAll,
  regId,
  getMember,
  requireAdmin,
  isAdminRole,
  profilesFor,
  mustGetClub,
} = require('../lib/db')
const rules = require('../lib/rules')
const T = require('../lib/time')
const config = require('../config')
const { ensureMember } = require('./club')
const { createFine, maybeSettle } = require('./settle')
const teams = require('./teams')
const remind = require('./remind')

const { MIN } = rules

// 带朋友报名：每个朋友是一条独立的报名记录，openid 用 “报名人openid#g1” 这样的虚拟 ID，ownerOpenid 指向报名人
const guestOpenid = (owner, i) => `${owner}#g${i}`
const ACTIVE = ['registered', 'waitlist']
async function activeGuests(gameId, owner) {
  return listAll(db.collection('registrations').where({ gameId, ownerOpenid: owner, status: _.in(ACTIVE) }))
}
// 本人、或报名人管理自己带的朋友、或管理员
async function requireSelfOwnerOrAdmin(game, openid, reg) {
  if (reg.openid === openid || reg.ownerOpenid === openid) return
  await requireAdmin(game.clubId, openid)
}

// 客户端 envVersion → 订阅消息 miniprogramState（点通知时打开哪个版本）
const MP_STATE = { develop: 'developer', trial: 'trial', release: 'formal' }
const mpState = (env) => MP_STATE[env] || 'formal'
const NEW_MEMBER_MS = 14 * 24 * 60 * MIN

// 本场价格：球队开启收费时，按球队的档位名称、表单给的金额（没给就用球队默认）
function gameFee(s, feeCents) {
  const fee = s.fee || {}
  if (!fee.enabled) return null
  const tiers = (fee.tiers || []).map((t, i) => {
    const v = Array.isArray(feeCents) && feeCents[i] !== undefined && feeCents[i] !== '' ? Number(feeCents[i]) : t.cents
    if (!(Number.isFinite(v) && v >= 0 && v <= 100000)) throw new UserError('价格需在 $0–$1000 之间')
    return { label: t.label, cents: Math.round(v) }
  })
  return { tiers }
}

function tagsOrThrow(input) {
  try {
    return rules.cleanTags(input)
  } catch (e) {
    throw new UserError(e.message)
  }
}

function intIn(v, lo, hi, what) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${what}需在 ${lo}–${hi} 之间`)
  return n
}

// 把表单（比赛时区的日期/时间）换算成要存的字段
function buildGameFields(club, venue, f) {
  const s = club.settings
  const tz = f.timezone || s.timezone
  const checkinOn = f.checkinEnabled !== undefined ? !!f.checkinEnabled : s.checkinEnabled !== false
  if (!T.isValidTimeZone(tz)) throw new UserError('时区无效')
  const startAt = T.zonedToUtcMs(f.date, f.time, tz)
  const durationMin = intIn(f.durationMin ?? s.durationMin, 15, 600, '时长')
  const lateGraceMin = intIn(f.lateGraceMin ?? s.lateGraceMin, 0, 120, '迟到宽限')
  // 提醒转发：开场前 N 小时内取消要转发（表单给小时数；旧客户端给具体日期时间；都没有用球队默认）
  const forwardHours = f.forwardHours ?? null
  if (forwardHours !== null && !(Number(forwardHours) >= 0 && Number(forwardHours) <= 168)) {
    throw new UserError('提醒转发需在开场前 0–168 小时之间')
  }
  const cancelDeadlineAt =
    forwardHours !== null
      ? startAt - Math.round(Number(forwardHours) * 60) * MIN
      : f.cancelDeadline
        ? T.zonedToUtcMs(f.cancelDeadline.date, f.cancelDeadline.time, tz)
        : s.cancelDeadlineMode === 'hours'
          ? startAt - (s.cancelDeadlineHours ?? 24) * 60 * MIN
          : T.deadlineBefore(startAt, tz, s.cancelDeadlineDaysBefore, s.cancelDeadlineTime)
  const penaltyHours = f.penaltyHours ?? null
  if (penaltyHours !== null && !(Number(penaltyHours) >= 0 && Number(penaltyHours) <= 168)) {
    throw new UserError('临时退出需在开场前 0–168 小时之间')
  }
  const signupOpensAt = f.signupOpens ? T.zonedToUtcMs(f.signupOpens.date, f.signupOpens.time, tz) : 0
  if (cancelDeadlineAt > startAt) throw new UserError('提醒转发的时间不能晚于开赛时间')
  if (signupOpensAt >= startAt) throw new UserError('报名开放时间需早于开赛时间')
  // 标题留空时自动生成，如“周日 · MTV Garfield”
  const customTitle = String(f.title || '').trim().slice(0, 30)
  return {
    title: customTitle || `${T.weekdayText(startAt, tz)} · ${venue.name}`,
    autoTitle: !customTitle,
    note: String(f.note || '').slice(0, 500),
    timezone: tz,
    startAt,
    durationMin,
    endAt: startAt + durationMin * MIN,
    lateGraceMin,
    cutoffAt: startAt + lateGraceMin * MIN, // 迟到开始的时刻，也是结算时刻
    capacity: intIn(f.capacity ?? s.capacity, 1, 100, '人数上限'),
    // 赛制与分队（默认 8v8v8，分队/守门员默认关闭）
    teamSize: intIn(f.teamSize ?? 8, 2, 20, '每队人数'),
    teamCount: intIn(f.teamCount ?? 3, 2, 6, '队数'),
    // 关闭签到：不判定迟到/未到，也不能自动分队（分队按签到的人分）
    checkinEnabled: checkinOn,
    autoTeams: checkinOn && !!f.autoTeams,
    goalkeeper: checkinOn && !!f.autoTeams && !!f.goalkeeper,
    tags: tagsOrThrow(f.tags),
    fee: f.feeEnabled === false ? null : gameFee(s, f.feeCents),
    fineCents: s.finesEnabled === false ? 0 : intIn(f.fineCents ?? s.fineCents, 0, 100000, '迟到罚款'),
    fineNoShowCents:
      s.finesEnabled === false ? 0 : intIn(f.fineNoShowCents ?? s.fineNoShowCents ?? s.fineCents, 0, 100000, '未到罚款'),
    fineLateCancelCents:
      s.finesEnabled === false
        ? 0
        : intIn(f.fineLateCancelCents ?? s.fineLateCancelCents ?? s.fineCents, 0, 100000, '临时退出罚款'),
    cancelDeadlineAt,
    signupOpensAt,
    penaltyWindowMin: penaltyHours !== null ? Math.round(Number(penaltyHours) * 60) : s.penaltyWindowMin,
    checkinOpenBeforeMin: s.checkinOpenBeforeMin,
    venue: {
      id: venue._id,
      name: venue.name,
      address: venue.address,
      lat: venue.lat,
      lng: venue.lng,
      radiusM: venue.radiusM,
    },
  }
}

async function saveGame({ openid, clubId, gameId, form }) {
  await requireAdmin(clubId, openid)
  const club = await mustGetClub(clubId)
  const venue = await mustGet('venues', form.venueId, '场地')
  if (venue.clubId !== clubId) throw new UserError('场地不属于该球队')
  const fields = buildGameFields(club, venue, form)
  const pastError = `开赛时间 ${T.fmtLocal(fields.startAt, fields.timezone)} 已经过了，请检查日期和时间`

  if (!gameId) {
    if (fields.startAt <= Date.now()) throw new UserError(pastError)
    const res = await db.collection('games').add({
      data: {
        ...fields,
        clubId,
        creatorOpenid: openid,
        status: 'active',
        registeredCount: 0,
        settledAt: 0,
        teamsFormedAt: 0,
        checkinSecret: crypto.randomBytes(16).toString('hex'),
        createdAt: Date.now(),
      },
    })
    return { gameId: res._id }
  }

  const game = await mustGet('games', gameId, '比赛')
  if (game.clubId !== clubId) throw new UserError('比赛不属于该球队')
  if (game.status !== 'active') throw new UserError('比赛已取消')
  if (game.settledAt) throw new UserError('比赛已结算，不能再修改')
  if (game.teamsFormedAt && (fields.teamSize !== game.teamSize || fields.teamCount !== game.teamCount || !fields.autoTeams)) {
    throw new UserError('已经分过队，不能再修改赛制或关闭分队')
  }
  if (game.teamsFormedAt === undefined) fields.teamsFormedAt = 0
  // 开赛后仍可改备注等；但不能把时间改到过去
  if (fields.startAt !== game.startAt && fields.startAt <= Date.now()) throw new UserError(pastError)
  const timeChanged = fields.startAt !== game.startAt || fields.endAt !== game.endAt
  const venueChanged = fields.venue.id !== game.venue.id
  const changes = []
  if (timeChanged) {
    changes.push(`时间改为 ${T.fmtLocal(fields.startAt, fields.timezone)}–${T.fmtLocal(fields.endAt, fields.timezone).slice(-5)}`)
  }
  if (venueChanged) changes.push(`场地改为 ${fields.venue.name}`)
  if (changes.length) fields.lastChange = { at: Date.now(), text: changes.join('，') }
  await db.collection('games').doc(gameId).update({ data: fields })
  if (fields.capacity > game.capacity) await promoteWaitlist(gameId)
  if (fields.signupOpensAt !== game.signupOpensAt) await remind.syncReminders({ ...game, ...fields, _id: gameId })
  if (timeChanged || fields.cancelDeadlineAt !== game.cancelDeadlineAt || fields.penaltyWindowMin !== game.penaltyWindowMin) {
    await recheckCancellations({ ...game, ...fields, _id: gameId })
  }
  let notified = 0
  if (changes.length) {
    notified = await notifyChanged({ ...game, ...fields, _id: gameId }, { timeChanged, venueChanged })
  }
  return { gameId, changed: changes.length > 0, notified }
}

// 发起/编辑表单的初始值。copyLast：复制本队最近一场，日期顺延到下一个同星期
async function gameForm({ openid, clubId, gameId, copyLast }) {
  await requireAdmin(clubId, openid)
  const club = await mustGet('clubs', clubId, '球队')
  const venues = await listAll(db.collection('venues').where({ clubId }).orderBy('name', 'asc'))
  let src = null
  if (gameId) {
    src = await mustGet('games', gameId, '比赛')
  } else if (copyLast) {
    const last = await db.collection('games').where({ clubId }).orderBy('startAt', 'desc').limit(1).get()
    src = last.data[0] || null
  }
  const templates = club.templates || []
  if (!src) {
    return { form: null, venues, settings: club.settings, templates }
  }
  const tz = src.timezone
  const start = T.zonedParts(src.startAt, tz)
  const signup = src.signupOpensAt ? T.zonedParts(src.signupOpensAt, tz) : null
  const deadline = T.zonedParts(src.cancelDeadlineAt, tz)
  const form = {
    title: src.autoTitle ? '' : src.title,
    note: src.note,
    timezone: tz,
    date: start.date,
    time: start.time,
    durationMin: src.durationMin,
    venueId: src.venue.id,
    capacity: src.capacity,
    teamSize: src.teamSize || 8,
    teamCount: src.teamCount || 3,
    checkinEnabled: src.checkinEnabled !== false,
    autoTeams: !!src.autoTeams,
    goalkeeper: !!src.goalkeeper,
    tags: src.tags || [],
    feeCents: src.fee ? src.fee.tiers.map((t) => t.cents) : null,
    feeEnabled: gameId ? !!src.fee : undefined, // 编辑时：这场现在有没有收费
    lateGraceMin: src.lateGraceMin,
    fineCents: src.fineCents,
    fineNoShowCents: src.fineNoShowCents ?? src.fineCents,
    fineLateCancelCents: src.fineLateCancelCents ?? src.fineCents,
    signupOpens: signup,
    cancelDeadline: gameId ? deadline : null, // 复制时用默认规则重新算
    forwardHours: gameId ? Math.round(((src.startAt - src.cancelDeadlineAt) / (60 * MIN)) * 10) / 10 : null,
    penaltyHours: gameId ? src.penaltyWindowMin / 60 : null,
  }
  if (!gameId) {
    // 按周顺延，直到开赛时间在未来
    let weeks = 0
    while (T.zonedToUtcMs(T.shiftDate(start.date, 7 * weeks), start.time, tz) <= Date.now()) weeks++
    weeks = Math.max(weeks, 1)
    form.date = T.shiftDate(start.date, 7 * weeks)
    if (signup) form.signupOpens = { date: T.shiftDate(signup.date, 7 * weeks), time: signup.time }
  }
  return { form, venues, settings: club.settings, templates }
}

async function cancelGame({ openid, gameId, reason }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  if (game.status !== 'active') throw new UserError('比赛已经取消了')
  if (game.settledAt) throw new UserError('比赛已结算，不能取消')
  const cancelReason = String(reason || '').trim().slice(0, 50) || '管理员取消'
  await db
    .collection('games')
    .doc(gameId)
    .update({ data: { status: 'cancelled', cancelReason, cancelledAt: Date.now() } })
  await remind.syncReminders({ ...game, status: 'cancelled' })
  const waived = await autoWaive({ gameId }, `比赛取消：${cancelReason}`)
  const notified = await notifyChanged(game, { cancelled: true, reason: cancelReason })
  return { notified, waived }
}

// 删除已取消的比赛：只是从列表里隐藏（archived），数据保留，罚款记录不受影响
async function archiveGame({ openid, gameId }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  if (game.status !== 'cancelled') throw new UserError('只能删除已取消的比赛，请先取消')
  await db.collection('games').doc(gameId).update({ data: { archived: true, archivedBy: openid, archivedAt: Date.now() } })
  return {}
}

function publicGame(game) {
  const { checkinSecret, ...rest } = game
  const tz = game.timezone
  return {
    ...rest,
    tzOffsetMin: T.offsetMin(game.startAt, tz),
    lateAt: rules.lateAt(game),
    local: {
      start: T.fmtLocal(game.startAt, tz),
      end: T.fmtLocal(game.endAt, tz).slice(-5),
      cutoff: T.fmtLocal(rules.lateAt(game), tz), // 从这一分钟起签到算迟到
      cancelDeadline: T.fmtLocal(game.cancelDeadlineAt, tz),
      signupOpens: game.signupOpensAt ? T.fmtLocal(game.signupOpensAt, tz) : '',
    },
  }
}

async function unpaidCents(clubId, openid) {
  const fines = await listAll(db.collection('fines').where({ clubId, openid, status: 'pending' }))
  return fines.reduce((sum, f) => sum + f.amountCents, 0)
}

async function listGames({ openid, history }) {
  const members = await listAll(db.collection('members').where({ openid }))
  if (!members.length) return { games: [] }
  const clubs = (await listAll(db.collection('clubs').where({ _id: _.in(members.map((m) => m.clubId)) }))).filter(
    (c) => !c.archived,
  )
  if (!clubs.length) return { games: [] }
  const clubIds = clubs.map((c) => c._id)
  const clubNames = Object.fromEntries(clubs.map((c) => [c._id, c.name]))
  const now = Date.now()
  const query = history
    ? db
        .collection('games')
        .where({ clubId: _.in(clubIds), endAt: _.lt(now), archived: _.neq(true) })
        .orderBy('startAt', 'desc')
    : db
        .collection('games')
        .where({ clubId: _.in(clubIds), endAt: _.gte(now - 6 * 60 * MIN), archived: _.neq(true) })
        .orderBy('startAt', 'asc')
  const games = await listAll(query, 30)
  const regs = games.length
    ? await listAll(db.collection('registrations').where({ openid, gameId: _.in(games.map((g) => g._id)) }))
    : []
  const myStatus = Object.fromEntries(regs.map((r) => [r.gameId, r.status]))
  const myAttendance = Object.fromEntries(regs.map((r) => [r.gameId, r.status === 'registered' ? r.attendance || '' : '']))
  return {
    games: games.map((g) => ({
      ...publicGame(g),
      clubName: clubNames[g.clubId] || '',
      myStatus: myStatus[g._id] || '',
      myAttendance: myAttendance[g._id] || '',
    })),
  }
}

// 名额计数器和实际报名人数对不上时纠正，并在有空位时递补
async function healRegisteredCount(game) {
  if (game.status !== 'active' || Date.now() >= game.cutoffAt) return false
  const actual = (await db.collection('registrations').where({ gameId: game._id, status: 'registered' }).count()).total
  if (actual === game.registeredCount) return false
  console.warn('registeredCount drift', game._id, game.registeredCount, '->', actual)
  await db.collection('games').doc(game._id).update({ data: { registeredCount: actual } })
  if (actual < game.capacity) await promoteWaitlist(game._id)
  return true
}

async function getGame({ openid, gameId }) {
  let game = await mustGet('games', gameId, '比赛')
  if (await maybeSettle(game)) game = await mustGet('games', gameId, '比赛')
  if (await healRegisteredCount(game)) game = await mustGet('games', gameId, '比赛')
  const club = await mustGetClub(game.clubId)
  const member = await getMember(game.clubId, openid)
  const isAdmin = !!member && isAdminRole(member.role)

  const regs = await listAll(db.collection('registrations').where({ gameId }))
  const profiles = await profilesFor(
    game.clubId,
    regs.flatMap((r) => [r.openid, r.inviter]),
  )
  // 朋友显示为“张三+1”，头像用报名人的
  for (const r of regs) {
    if (!r.ownerOpenid) continue
    const owner = profiles[r.ownerOpenid] || { name: '未命名', avatar: '' }
    profiles[r.openid] = { name: `${owner.name}+${r.guestIndex}`, avatar: owner.avatar, joinedAt: 0, role: '', level: '' }
  }
  const now = Date.now()
  const view = (r) => {
    const p = profiles[r.openid] || { name: '未命名', avatar: '' }
    return {
      openid: r.openid,
      name: p.name,
      avatar: p.avatar,
      isNew: !!p.joinedAt && now - p.joinedAt < NEW_MEMBER_MS,
      isAdmin: isAdminRole(p.role),
      isGuest: !!r.ownerOpenid,
      ownerOpenid: r.ownerOpenid || '',
      guestIndex: r.guestIndex || 0,
      level: rules.validLevel(club.settings.rating, p.level),
      inviterName: r.inviter ? (profiles[r.inviter] || {}).name || '' : '',
      status: r.status,
      signedAt: r.signedAt,
      spotAt: r.spotAt || 0,
      waitlistAt: r.waitlistAt || 0,
      cancelledAt: r.cancelledAt || 0,
      cancelPhase: r.cancelPhase || '',
      cancelledFrom: r.cancelledFrom || '',
      tags: (r.tags || []).filter((t) => (game.tags || []).includes(t)),
      note: r.note || '',
      pay: r.pay && r.pay.status ? r.pay : { status: 'unpaid' },
      checkinAt: r.checkinAt || 0,
      checkinMethod: r.checkinMethod || '',
      attendance: r.attendance || '',
      goals: r.goals || 0,
      assists: r.assists || 0,
      subscribedChange: !!r.subscribedChange,
    }
  }
  const pick = (status, key) =>
    regs
      .filter((r) => r.status === status)
      .map(view)
      .sort((a, b) => a[key] - b[key])
  // 报名后取消的人：之后第一个拿到名额的人（递补或新报名）算补上了他；多人取消按先后依次对应
  const refill = {}
  const events = [
    ...regs.filter((r) => r.spotAt > 0).map((r) => ({ t: r.spotAt, kind: 'gain', r })),
    ...regs.filter((r) => r.status === 'cancelled' && r.spotAt > 0).map((r) => ({ t: r.cancelledAt, kind: 'cancel', r })),
  ].sort((a, b) => a.t - b.t || (a.kind === 'cancel' ? -1 : 1))
  const holes = []
  for (const e of events) {
    if (e.kind === 'cancel') {
      holes.push(e.r)
      refill[e.r.openid] = ''
    } else if (holes.length) {
      const hole = holes.shift()
      refill[hole.openid] = (profiles[e.r.openid] || {}).name || '有人'
    }
  }
  const cancelled = pick('cancelled', 'cancelledAt').map((v) => {
    const r = regs.find((x) => x.openid === v.openid)
    const fromRoster = r.spotAt > 0 && r.cancelledFrom !== 'waitlist'
    return { ...v, cancelledFrom: fromRoster ? 'registered' : 'waitlist', refilledBy: fromRoster ? refill[v.openid] || '' : '' }
  })
  // 缴费统计：已报名的人里谁付了；退出了但付过钱、还没退款的要提醒管理员
  const registeredRows = pick('registered', 'spotAt')
  const cancelledRows = cancelled
  const payOf = (v) => (v.pay && v.pay.status) || 'unpaid'
  const feeStats = game.fee
    ? {
        paid: registeredRows.filter((v) => payOf(v) === 'paid').length,
        total: registeredRows.length,
        collectedCents: registeredRows.filter((v) => payOf(v) === 'paid').reduce((sum, v) => sum + v.pay.cents, 0),
        toRefund: cancelledRows.filter((v) => payOf(v) === 'paid').length,
        toRefundCents: cancelledRows.filter((v) => payOf(v) === 'paid').reduce((sum, v) => sum + v.pay.cents, 0),
      }
    : null
  const cancelStats = {
    fromRoster: cancelled.filter((c) => c.cancelledFrom === 'registered').length,
    refilled: cancelled.filter((c) => c.cancelledFrom === 'registered' && c.refilledBy).length,
    fromWaitlist: cancelled.filter((c) => c.cancelledFrom === 'waitlist').length,
  }

  const mine = regs.find((r) => r.openid === openid)
  // 本场罚款，只给管理员看
  const fines = isAdmin
    ? (await listAll(db.collection('fines').where({ gameId }))).map((f) => ({
        _id: f._id,
        openid: f.openid,
        reasonText: f.detail || rules.FINE_REASONS[f.reason] || f.reason,
        amountCents: f.amountCents,
        status: f.status,
      }))
    : []

  // 通知覆盖情况，只给管理员看
  let notifyStats = null
  if (isAdmin) {
    const active = regs.filter((r) => r.status === 'registered' || r.status === 'waitlist')
    const waiting = regs.filter((r) => r.status === 'waitlist')
    const reminders = game.signupOpensAt ? await listAll(db.collection('reminders').where({ gameId })) : []
    notifyStats = {
      change: active.filter((r) => r.subscribedChange).length,
      active: active.length,
      promoted: waiting.filter((r) => r.subscribed).length,
      waitlist: waiting.length,
      openPending: reminders.filter((r) => !r.sent).length,
      openDelivered: reminders.filter((r) => r.result === 'delivered').length,
    }
  }

  return {
    fines,
    notifyStats,
    teams: teams.teamsView(game, regs, profiles, openid, club.settings.rating),
    serverNow: now,
    game: publicGame(game),
    club: {
      _id: club._id,
      name: club.name,
      venmo: club.venmo,
      finesEnabled: club.settings.finesEnabled !== false,
      levelOptions: rules.levelOptions(club.settings.rating),
      matchStatsEnabled: !!club.settings.matchStatsEnabled,
      guestsMax: club.settings.guestsMax || 0,
    },
    registered: registeredRows,
    waitlist: pick('waitlist', 'waitlistAt'),
    cancelled,
    cancelStats,
    feeStats,
    me: {
      openid,
      isMember: !!member,
      isAdmin,
      reg: mine ? view(mine) : null,
      unpaidCents: member && club.settings.finesEnabled !== false ? await unpaidCents(game.clubId, openid) : 0,
      checkinOpensAt: rules.checkinOpensAt(game),
      openReminder: game.signupOpensAt > now ? await remind.hasOpenReminder(gameId, openid) : false,
      level: member ? rules.validLevel(club.settings.rating, member.level) : '',
      guests: regs.filter((r) => r.ownerOpenid === openid && ACTIVE.includes(r.status)).map(view),
    },
  }
}

async function signup({ openid, gameId, inviter, subscribed, subscribedChange, envVersion, guests }) {
  const game = await mustGet('games', gameId, '比赛')
  const club = await mustGetClub(game.clubId)
  const finesOn = !club.settings || club.settings.finesEnabled !== false
  const now = Date.now()
  if (game.status !== 'active') throw new UserError('比赛已取消')
  if (now >= game.startAt) throw new UserError('比赛已开始，不能报名')
  if (game.signupOpensAt && now < game.signupOpensAt) {
    const m = await getMember(game.clubId, openid)
    if (!m || !isAdminRole(m.role)) {
      throw new UserError(`报名将于 ${T.fmtLocal(game.signupOpensAt, game.timezone)} 开放`)
    }
  }
  await ensureMember(game.clubId, openid, inviter)

  const owed = finesOn ? await unpaidCents(game.clubId, openid) : 0
  if (owed > 0) {
    const venmo = club.venmo ? `Venmo ${club.venmo} 或` : ''
    throw new UserError(`你有未付罚款 $${(owed / 100).toFixed(2)}，请${venmo}现金支付给管理员，确认后即可报名`)
  }

  const existing = await getDoc('registrations', regId(gameId, openid))
  if (existing && (existing.status === 'registered' || existing.status === 'waitlist')) {
    throw new UserError('你已经报名了')
  }
  const validInviter =
    inviter && inviter !== openid && (await getMember(game.clubId, inviter)) ? inviter : ''
  const maxGuests = club.settings.guestsMax || 0
  const nGuests = Math.round(Number(guests) || 0)
  if (nGuests < 0 || nGuests > maxGuests) {
    throw new UserError(maxGuests ? `每人最多带 ${maxGuests} 位朋友` : '本球队不支持带朋友报名')
  }

  // 一起报上或一起进替补：剩余名额够 1+N 才全部报上
  const seats = nGuests + 1
  const got = await db
    .collection('games')
    .where({ _id: gameId, registeredCount: _.lte(game.capacity - seats) })
    .update({ data: { registeredCount: _.inc(seats) } })
  const status = got.stats.updated === 1 ? 'registered' : 'waitlist'

  await db
    .collection('registrations')
    .doc(regId(gameId, openid))
    .set({
      data: {
        gameId,
        clubId: game.clubId,
        openid,
        status,
        inviter: (existing && existing.inviter) || validInviter,
        signedAt: now,
        spotAt: status === 'registered' ? now : 0,
        waitlistAt: status === 'waitlist' ? now : 0,
        promotedAt: 0,
        cancelledAt: 0,
        cancelPhase: '',
        checkinAt: 0,
        attendance: '',
        team: '',
        gk: 0,
        teamInitial: false,
        tags: [],
        note: '',
        goals: 0,
        assists: 0,
        subscribed: status === 'waitlist' && !!subscribed,
        subscribedChange: !!subscribedChange,
        mpState: mpState(envVersion),
        guestCount: nGuests,
      },
    })
  // 朋友：先清掉上次报名留下的，再按顺序建，排在报名人后面
  await db.collection('registrations').where({ gameId, ownerOpenid: openid }).remove()
  for (let i = 1; i <= nGuests; i++) {
    const gid = guestOpenid(openid, i)
    await db
      .collection('registrations')
      .doc(regId(gameId, gid))
      .set({
        data: {
          gameId,
          clubId: game.clubId,
          openid: gid,
          ownerOpenid: openid,
          guestIndex: i,
          status,
          inviter: '',
          signedAt: now,
          spotAt: status === 'registered' ? now : 0,
          waitlistAt: status === 'waitlist' ? now + i : 0,
          promotedAt: 0,
          cancelledAt: 0,
          cancelPhase: '',
          checkinAt: 0,
          attendance: '',
          team: '',
          gk: 0,
          teamInitial: false,
          tags: [],
          note: '',
          goals: 0,
          assists: 0,
          subscribed: false,
          subscribedChange: false,
        },
      })
  }
  return nGuests ? { status, guests: nGuests } : { status }
}

// 退出一条报名记录（不处理罚款和递补）；返回释放的名额数
async function leave(reg, now, phase) {
  const wasRegistered = reg.status === 'registered'
  await db
    .collection('registrations')
    .doc(reg._id)
    .update({
      data: {
        status: 'cancelled',
        cancelledAt: now,
        cancelPhase: wasRegistered ? phase : 'free',
        cancelledFrom: wasRegistered ? 'registered' : 'waitlist',
      },
    })
  return wasRegistered ? 1 : 0
}

// guestIndex：只退出自己带的某位朋友（不自动罚款）；不传：本人退出，带的朋友一起退出
async function cancelSignup({ openid, gameId, guestIndex }) {
  const game = await mustGet('games', gameId, '比赛')
  const now = Date.now()
  if (guestIndex) {
    const g = await getDoc('registrations', regId(gameId, guestOpenid(openid, guestIndex)))
    if (!g || !ACTIVE.includes(g.status)) throw new UserError('这位朋友没有在报名中')
    if (game.status === 'active' && now >= game.cutoffAt) throw new UserError('已过签到截止时间，不能再退出')
    if (g.status === 'registered' && g.checkinAt) throw new UserError('已经签到了，不能退出')
    const phase = game.status === 'active' ? rules.cancelPhase(game, now) : 'free'
    const freed = await leave(g, now, phase)
    if (freed) await db.collection('games').doc(gameId).update({ data: { registeredCount: _.inc(-freed) } })
    if (game.status === 'active') await promoteWaitlist(gameId)
    return { phase: g.status === 'registered' ? phase : 'free', fined: false }
  }
  const reg = await getDoc('registrations', regId(gameId, openid))
  if (!reg || (reg.status !== 'registered' && reg.status !== 'waitlist')) throw new UserError('你没有报名')
  if (game.status === 'active' && now >= game.cutoffAt) throw new UserError('已过签到截止时间，不能再退出')
  if (reg.status === 'registered' && reg.checkinAt) throw new UserError('你已经签到了，不能退出报名')
  // 本人退出：带的朋友一起退出（朋友不罚款）
  const phaseNow = game.status === 'active' ? rules.cancelPhase(game, now) : 'free'
  let freedGuests = 0
  for (const g of await activeGuests(gameId, openid)) freedGuests += await leave(g, now, phaseNow)
  if (freedGuests) await db.collection('games').doc(gameId).update({ data: { registeredCount: _.inc(-freedGuests) } })

  if (reg.status === 'waitlist') {
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { status: 'cancelled', cancelledAt: now, cancelPhase: 'free', cancelledFrom: 'waitlist' } })
    if (freedGuests && game.status === 'active') await promoteWaitlist(gameId)
    return { phase: 'free', fined: false }
  }

  const phase = game.status === 'active' ? rules.cancelPhase(game, now) : 'free'
  await db
    .collection('registrations')
    .doc(reg._id)
    .update({ data: { status: 'cancelled', cancelledAt: now, cancelPhase: phase, cancelledFrom: 'registered' } })
  await db.collection('games').doc(gameId).update({ data: { registeredCount: _.inc(-1) } })

  let fined = false
  if (phase === 'penalty' && rules.fineFor(game, 'late_cancel') > 0 && !rules.isLatePromotion(reg, game)) {
    await createFine({
      clubId: game.clubId,
      gameId,
      openid,
      kind: 'cancel',
      reason: 'late_cancel',
      amountCents: rules.fineFor(game, 'late_cancel'),
    })
    fined = true
  }
  if (game.status === 'active') await promoteWaitlist(gameId)
  return { phase, fined }
}

// 有空位就按排队顺序递补，并发订阅消息
async function promoteWaitlist(gameId) {
  for (let i = 0; i < 100; i++) {
    const game = await getDoc('games', gameId)
    if (!game || game.status !== 'active' || Date.now() >= game.cutoffAt) return
    const next = await db
      .collection('registrations')
      .where({ gameId, status: 'waitlist' })
      .orderBy('waitlistAt', 'asc')
      .limit(1)
      .get()
    const reg = next.data[0]
    if (!reg) return
    const got = await db
      .collection('games')
      .where({ _id: gameId, registeredCount: _.lt(game.capacity) })
      .update({ data: { registeredCount: _.inc(1) } })
    if (got.stats.updated !== 1) return
    const now = Date.now()
    const moved = await db
      .collection('registrations')
      .where({ _id: reg._id, status: 'waitlist' })
      .update({ data: { status: 'registered', promotedAt: now, spotAt: now, subscribed: false } })
    if (moved.stats.updated !== 1) {
      // 被别的请求抢先处理了（比如本人刚好取消），把名额还回去
      await db.collection('games').doc(gameId).update({ data: { registeredCount: _.inc(-1) } })
      continue
    }
    if (reg.subscribed) await notifyPromoted(reg, game)
  }
}

async function notifyPromoted(reg, game) {
  if (!config.PROMOTED_TEMPLATE_ID) return
  const openid = reg.openid
  try {
    const member = await getMember(game.clubId, openid)
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: config.PROMOTED_TEMPLATE_ID,
      page: `pages/game/game?id=${game._id}`,
      miniprogramState: reg.mpState || 'formal',
      data: config.buildPromotedData({
        memberName: member ? member.name : '',
        gameTitle: game.title,
        startText: T.fmtPlain(game.startAt, game.timezone),
        venueName: game.venue.name,
      }),
    })
  } catch (e) {
    console.error('notify promoted failed', openid, e)
  }
}

// 系统自动豁免罚款（比赛取消、改时间后不再符合条件）
async function autoWaive(where, note) {
  const fines = await listAll(db.collection('fines').where({ ...where, status: 'pending' }))
  for (const f of fines) {
    await db
      .collection('fines')
      .doc(f._id)
      .update({ data: { status: 'waived', note, resolvedBy: 'system', resolvedAt: Date.now() } })
  }
  return fines.length
}

// 改时间或取消截止后，重新判断已取消的人：按新时间不该罚的，撤掉罚款（不会新增罚款）
async function recheckCancellations(game) {
  const regs = await listAll(
    db.collection('registrations').where({ gameId: game._id, status: 'cancelled', cancelPhase: _.in(['warn', 'penalty']) }),
  )
  for (const reg of regs) {
    const phase = rules.cancelPhase(game, reg.cancelledAt)
    const rank = { free: 0, warn: 1, penalty: 2 }
    if (rank[phase] >= rank[reg.cancelPhase]) continue
    await db.collection('registrations').doc(reg._id).update({ data: { cancelPhase: phase } })
    if (reg.cancelPhase === 'penalty') {
      await autoWaive({ _id: `${game._id}_${reg.openid}_cancel` }, '比赛改时间，按新时间不算临时退出')
    }
    if (phase === 'free') {
      await autoWaive({ _id: `${game._id}_${reg.openid}_noforward` }, '比赛改时间，按新时间退出时无需转发')
    }
  }
}

// 给订阅了变更通知的报名者（含替补）发消息。一次订阅只能发一条，发完即清除。
// change: { cancelled?, reason?, timeChanged?, venueChanged? }
async function notifyChanged(game, change) {
  if (!config.CHANGED_TEMPLATE_ID) return 0
  const regs = await listAll(
    db.collection('registrations').where({
      gameId: game._id,
      status: _.in(['registered', 'waitlist']),
      subscribedChange: true,
    }),
  )
  let sent = 0
  for (const reg of regs) {
    await db.collection('registrations').doc(reg._id).update({ data: { subscribedChange: false } })
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: reg.openid,
        templateId: config.CHANGED_TEMPLATE_ID,
        page: `pages/game/game?id=${game._id}`,
        miniprogramState: reg.mpState || 'formal',
        data: config.buildChangedData({
          ...change,
          gameTitle: game.title,
          startText: T.fmtPlain(game.startAt, game.timezone),
          venueName: game.venue.name,
        }),
      })
      sent++
    } catch (e) {
      console.error('notify changed failed', reg.openid, e)
    }
  }
  return sent
}

// 已报名的人补开变更通知（上一次通知用掉之后）
async function subscribeChange({ openid, gameId, envVersion }) {
  const reg = await getDoc('registrations', regId(gameId, openid))
  if (!reg || (reg.status !== 'registered' && reg.status !== 'waitlist')) throw new UserError('你没有报名')
  await db
    .collection('registrations')
    .doc(reg._id)
    .update({ data: { subscribedChange: true, mpState: mpState(envVersion) } })
  return {}
}

async function checkin({ openid, gameId, lat, lng, accuracy, code }) {
  const game = await mustGet('games', gameId, '比赛')
  if (game.checkinEnabled === false) throw new UserError('本场比赛没有开启签到')
  if (game.status !== 'active') throw new UserError('比赛已取消')
  const reg = await getDoc('registrations', regId(gameId, openid))
  if (!reg || reg.status !== 'registered') throw new UserError('你不在报名名单里')
  if (reg.checkinAt) return { attendance: rules.attendanceFor(reg.checkinAt, game), already: true }
  const now = Date.now()
  if (!rules.canCheckinAt(game, now)) {
    if (now < rules.checkinOpensAt(game)) {
      throw new UserError(`签到将于开赛前 ${game.checkinOpenBeforeMin} 分钟开放`)
    }
    throw new UserError('比赛已结束，不能签到')
  }

  const data = { checkinAt: now }
  if (code) {
    if (!rules.verifyCheckinCode(game.checkinSecret, gameId, code, now)) throw new UserError('签到码错误或已过期')
    data.checkinMethod = 'code'
  } else {
    const pos = { lat: Number(lat), lng: Number(lng) }
    if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) throw new UserError('定位失败，请重试')
    const d = Math.round(rules.haversineM(pos, game.venue))
    if (d > game.venue.radiusM) {
      const acc = Math.round(Number(accuracy) || 0)
      console.log('checkin too far', JSON.stringify({ gameId, openid, d, acc, radius: game.venue.radiusM }))
      const hint = acc > game.venue.radiusM ? `（当前定位精度约 ${acc} 米，可能没开“精确位置”）` : ''
      throw new UserError(`你距离球场约 ${d} 米，需在 ${game.venue.radiusM} 米内才能签到${hint}。定位有问题可以向管理员要签到码`)
    }
    Object.assign(data, {
      checkinMethod: 'gps',
      checkinDistanceM: d,
      checkinAccuracyM: Math.round(Number(accuracy) || 0),
    })
  }

  const attendance = rules.attendanceFor(now, game)
  if (game.settledAt) {
    // 结算时还没签到（判了“未到”）的人后来到了：改成迟到；早期比赛结算得早，可能其实算准时
    data.attendance = attendance
    const fine = await getDoc('fines', `${gameId}_${openid}_attendance`)
    if (fine && fine.status === 'pending') {
      if (attendance === 'on_time') {
        await db
          .collection('fines')
          .doc(fine._id)
          .update({ data: { status: 'waived', note: '按时签到', resolvedBy: 'system', resolvedAt: now } })
      } else if (fine.reason === 'no_show') {
        await db
          .collection('fines')
          .doc(fine._id)
          .update({ data: { reason: 'late', amountCents: rules.fineFor(game, 'late') } })
      }
    }
  }
  await db.collection('registrations').doc(reg._id).update({ data })
  // 迟到的人也要分队、排守门员
  await teams.afterCheckin(gameId, openid)
  // 带的朋友跟着一起签到（迟到也一起迟到，但不单独罚款）
  for (const g of await activeGuests(gameId, openid)) {
    if (g.status !== 'registered' || g.checkinAt) continue
    await db
      .collection('registrations')
      .doc(g._id)
      .update({ data: { checkinAt: now, checkinMethod: 'owner', ...(game.settledAt ? { attendance } : {}) } })
    await teams.afterCheckin(gameId, g.openid)
  }
  return { attendance, distanceM: data.checkinDistanceM }
}

async function getCheckinCode({ openid, gameId }) {
  const game = await mustGet('games', gameId, '比赛')
  if (game.checkinEnabled === false) throw new UserError('本场比赛没有开启签到')
  await requireAdmin(game.clubId, openid)
  const now = Date.now()
  return {
    code: rules.checkinCode(game.checkinSecret, gameId, now),
    refreshAt: (Math.floor(now / MIN) + 1) * MIN,
  }
}

// 管理员修正出勤。结算前只能“代签到”；结算后可改成准时/迟到/未到，罚款随之调整
async function setAttendance({ openid, gameId, target, attendance }) {
  const game = await mustGet('games', gameId, '比赛')
  if (game.checkinEnabled === false) throw new UserError('本场比赛没有开启签到')
  await requireAdmin(game.clubId, openid)
  if (!['on_time', 'late', 'no_show'].includes(attendance)) throw new UserError('出勤状态无效')
  const reg = await getDoc('registrations', regId(gameId, target))
  if (!reg || reg.status !== 'registered') throw new UserError('该成员不在报名名单里')

  if (!game.settledAt) {
    if (attendance !== 'on_time') throw new UserError('截止时间前只能代签到')
    // 代签到和自己签到一样，只能在签到窗口内（开赛前 N 分钟起）
    if (Date.now() < rules.checkinOpensAt(game)) {
      throw new UserError(`签到将于开赛前 ${game.checkinOpenBeforeMin} 分钟开放，届时才能代签到`)
    }
    if (reg.checkinAt) throw new UserError('该成员已经签到了')
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { checkinAt: Math.min(Date.now(), game.startAt), checkinMethod: 'admin' } })
    await teams.afterCheckin(gameId, target)
    return {}
  }

  if (reg.ownerOpenid) {
    // 朋友：只改出勤和签到时间，不产生罚款
    const presentGuest = attendance !== 'no_show'
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { attendance, checkinMethod: 'admin', ...(presentGuest && !reg.checkinAt ? { checkinAt: Date.now() } : {}) } })
    if (presentGuest && Date.now() <= game.endAt) await teams.afterCheckin(gameId, target)
    return {}
  }
  const present = attendance !== 'no_show'
  await db
    .collection('registrations')
    .doc(reg._id)
    .update({ data: { attendance, checkinMethod: 'admin', ...(present && !reg.checkinAt ? { checkinAt: Date.now() } : {}) } })
  if (present && Date.now() <= game.endAt) await teams.afterCheckin(gameId, target)
  const fineId = `${gameId}_${target}_attendance`
  const fine = await getDoc('fines', fineId)
  if (attendance === 'on_time') {
    if (fine && fine.status === 'pending') {
      await db
        .collection('fines')
        .doc(fineId)
        .update({
          data: { status: 'waived', note: '管理员修正为准时', resolvedBy: openid, resolvedAt: Date.now() },
        })
    }
  } else if (fine) {
    const data = { reason: attendance }
    if (fine.status === 'pending' || fine.status === 'waived') data.amountCents = rules.fineFor(game, attendance)
    if (fine.status === 'waived') Object.assign(data, { status: 'pending', note: '', resolvedBy: '', resolvedAt: 0 })
    await db.collection('fines').doc(fineId).update({ data })
  } else if (rules.fineFor(game, attendance) > 0) {
    await createFine({
      clubId: game.clubId,
      gameId,
      openid: target,
      kind: 'attendance',
      reason: attendance,
      amountCents: rules.fineFor(game, attendance),
      createdBy: openid,
    })
  }
  return {}
}

// 截止后取消、但没有转发到群里：管理员手动罚款（系统无法检测是否转发）
async function fineNoForward({ openid, gameId, target }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  const reg = await getDoc('registrations', regId(gameId, target))
  if (reg && reg.ownerOpenid) throw new UserError('朋友不单独罚款，罚款记在报名人身上')
  if (!reg || reg.status !== 'cancelled' || reg.cancelPhase !== 'warn') {
    throw new UserError('只能对提醒转发时间内退出的人使用')
  }
  if (rules.fineFor(game, 'no_forward') <= 0) throw new UserError('本场临时退出罚款金额为 0')
  const fine = await createFine({
    clubId: game.clubId,
    gameId,
    openid: target,
    kind: 'noforward',
    reason: 'no_forward',
    amountCents: rules.fineFor(game, 'no_forward'),
    createdBy: openid,
  })
  return { fineId: fine._id }
}

// 队员给自己打/取消标签；管理员可以帮别人改。比赛结束后也能改（例如训练完再标“已付款”）
async function toggleTag({ openid, gameId, tag, target, on }) {
  const game = await mustGet('games', gameId, '比赛')
  if (!(game.tags || []).includes(tag)) throw new UserError('本场没有这个标签')
  const who = target || openid
  const reg = await getDoc('registrations', regId(gameId, who))
  if (!reg || reg.status !== 'registered') throw new UserError('只有已报名的人可以打标签')
  await requireSelfOwnerOrAdmin(game, openid, reg)
  const has = (reg.tags || []).includes(tag)
  const want = on === undefined ? !has : !!on
  if (want !== has) {
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { tags: want ? _.push([tag]) : _.pull(tag) } })
  }
  return { on: want }
}

// 管理员随时可改标签定义（含比赛结算后），其他字段仍受编辑限制
async function setGameTags({ openid, gameId, tags }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  if (game.status !== 'active') throw new UserError('比赛已取消')
  const next = tagsOrThrow(tags)
  await db.collection('games').doc(gameId).update({ data: { tags: next } })
  return { tags: next }
}

// 报名备注：队员自己写一句（如“6:20 到”），所有人可见；管理员可以改或清空别人的。
// 用户发布、他人可见的文字，保存前做微信内容安全检测。
const NOTE_MAX = 20

async function checkText(openid, content) {
  try {
    const r = await cloud.openapi.security.msgSecCheck({ openid, scene: 1, version: 2, content })
    const suggest = r && r.result && r.result.suggest
    if (suggest && suggest !== 'pass') throw new UserError('备注包含不合适的内容，请修改')
  } catch (e) {
    if (e instanceof UserError) throw e
    if (e && e.errCode === 87014) throw new UserError('备注包含不合适的内容，请修改')
    // 检测服务本身出错（如权限未配置）：记日志后放行，不影响正常使用
    console.error('msgSecCheck failed', e && (e.errCode || e.errMsg || e.message))
  }
}

async function setRegNote({ openid, gameId, note, target }) {
  const game = await mustGet('games', gameId, '比赛')
  const who = target || openid
  const reg = await getDoc('registrations', regId(gameId, who))
  if (!reg || (reg.status !== 'registered' && reg.status !== 'waitlist')) throw new UserError('只有报名或替补的人可以写备注')
  await requireSelfOwnerOrAdmin(game, openid, reg)
  const text = String(note || '').replace(/\s+/g, ' ').trim()
  if (text.length > NOTE_MAX) throw new UserError(`备注最多 ${NOTE_MAX} 个字`)
  if (text) await checkText(openid, text)
  await db.collection('registrations').doc(reg._id).update({ data: { note: text } })
  return { note: text }
}

// 记录本场进球与助攻：队员签到后可填写自己的数据，管理员可修改任意已报名队员的数据
async function setMatchStats({ openid, gameId, goals, assists, target }) {
  const game = await mustGet('games', gameId, '比赛')
  if (game.status !== 'active') throw new UserError('比赛已取消')
  const club = await mustGetClub(game.clubId)
  if (!club.settings.matchStatsEnabled) throw new UserError('本球队没有开启进球/助攻记录')
  const who = target || openid
  let isAdmin = false
  if (who !== openid) {
    await requireAdmin(game.clubId, openid)
    isAdmin = true
  } else {
    const m = await getMember(game.clubId, openid)
    isAdmin = !!m && isAdminRole(m.role)
  }
  const reg = await getDoc('registrations', regId(gameId, who))
  if (!reg || reg.status !== 'registered') throw new UserError('只有已报名的队员可以记录数据')
  if (Date.now() < game.startAt) throw new UserError('比赛开始后才能记录进球和助攻')
  const checkedIn =
    !!reg.checkinAt || reg.attendance === 'on_time' || reg.attendance === 'late' || game.checkinEnabled === false
  if (!checkedIn && !isAdmin) {
    throw new UserError('签到后才能记录进球和助攻')
  }
  const nextGoals = goals === undefined ? reg.goals || 0 : intIn(goals, 0, 99, '进球数')
  const nextAssists = assists === undefined ? reg.assists || 0 : intIn(assists, 0, 99, '助攻数')
  await db.collection('registrations').doc(reg._id).update({
    data: { goals: nextGoals, assists: nextAssists },
  })
  return { goals: nextGoals, assists: nextAssists }
}

// 标记缴费：tier = 选的价格档；status: paid / unpaid / refunded（已退款仅管理员、仅已退出的人）
// party = true：报名人把自己和带的朋友一起标记
async function setPayment({ openid, gameId, target, status, tier, party }) {
  const game = await mustGet('games', gameId, '比赛')
  if (!game.fee) throw new UserError('本场比赛没有开启收费')
  if (!['paid', 'unpaid', 'refunded'].includes(status)) throw new UserError('缴费状态无效')
  const who = target || openid
  const reg = await getDoc('registrations', regId(gameId, who))
  if (!reg) throw new UserError('没有找到报名记录')
  if (status === 'refunded') {
    await requireAdmin(game.clubId, openid)
    if (reg.status !== 'cancelled') throw new UserError('只有已退出的人可以标记已退款')
  } else {
    await requireSelfOwnerOrAdmin(game, openid, reg)
  }
  let pay = { status: 'unpaid' }
  if (status === 'paid') {
    const t = game.fee.tiers[Number(tier) || 0]
    if (!t) throw new UserError('价格档位无效')
    pay = { status: 'paid', tier: Number(tier) || 0, label: t.label, cents: t.cents, by: openid, at: Date.now() }
  } else if (status === 'refunded') {
    pay = { ...(reg.pay || {}), status: 'refunded', refundedBy: openid, refundedAt: Date.now() }
  }
  const rows = [reg]
  if (party && !reg.ownerOpenid) rows.push(...(await activeGuests(gameId, reg.openid)))
  for (const r of rows) await db.collection('registrations').doc(r._id).update({ data: { pay } })
  return { pay, count: rows.length }
}

module.exports = {
  archiveGame,
  setPayment,
  setRegNote,
  setMatchStats,
  buildGameFields,
  toggleTag,
  setGameTags,
  fineNoForward,
  subscribeChange,
  saveGame,
  gameForm,
  cancelGame,
  listGames,
  getGame,
  signup,
  cancelSignup,
  checkin,
  getCheckinCode,
  setAttendance,
}
