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
} = require('../lib/db')
const rules = require('../lib/rules')
const T = require('../lib/time')
const config = require('../config')
const { ensureMember } = require('./club')
const { createFine, maybeSettle } = require('./settle')
const teams = require('./teams')
const remind = require('./remind')

const { MIN } = rules

// 客户端 envVersion → 订阅消息 miniprogramState（点通知时打开哪个版本）
const MP_STATE = { develop: 'developer', trial: 'trial', release: 'formal' }
const mpState = (env) => MP_STATE[env] || 'formal'
const NEW_MEMBER_MS = 14 * 24 * 60 * MIN

function intIn(v, lo, hi, what) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${what}需在 ${lo}–${hi} 之间`)
  return n
}

// 把表单（比赛时区的日期/时间）换算成要存的字段
function buildGameFields(club, venue, f) {
  const s = club.settings
  const tz = f.timezone || s.timezone
  if (!T.isValidTimeZone(tz)) throw new UserError('时区无效')
  const startAt = T.zonedToUtcMs(f.date, f.time, tz)
  const durationMin = intIn(f.durationMin ?? s.durationMin, 15, 600, '时长')
  const lateGraceMin = intIn(f.lateGraceMin ?? s.lateGraceMin, 0, 120, '迟到宽限')
  const cancelDeadlineAt = f.cancelDeadline
    ? T.zonedToUtcMs(f.cancelDeadline.date, f.cancelDeadline.time, tz)
    : T.deadlineBefore(startAt, tz, s.cancelDeadlineDaysBefore, s.cancelDeadlineTime)
  const signupOpensAt = f.signupOpens ? T.zonedToUtcMs(f.signupOpens.date, f.signupOpens.time, tz) : 0
  if (cancelDeadlineAt > startAt) throw new UserError('缺席不转发罚款截止时间不能晚于开赛时间')
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
    cutoffAt: startAt + lateGraceMin * MIN,
    capacity: intIn(f.capacity ?? s.capacity, 1, 100, '人数上限'),
    // 赛制与分队（默认 8v8v8，分队/守门员默认关闭）
    teamSize: intIn(f.teamSize ?? 8, 2, 20, '每队人数'),
    teamCount: intIn(f.teamCount ?? 3, 2, 6, '队数'),
    autoTeams: !!f.autoTeams,
    goalkeeper: !!f.autoTeams && !!f.goalkeeper,
    fineCents: intIn(f.fineCents ?? s.fineCents, 0, 100000, '罚款金额'),
    cancelDeadlineAt,
    signupOpensAt,
    penaltyWindowMin: s.penaltyWindowMin,
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
  const club = await mustGet('clubs', clubId, '球队')
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
    autoTeams: !!src.autoTeams,
    goalkeeper: !!src.goalkeeper,
    lateGraceMin: src.lateGraceMin,
    fineCents: src.fineCents,
    signupOpens: signup,
    cancelDeadline: gameId ? deadline : null, // 复制时用默认规则重新算
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

function publicGame(game) {
  const { checkinSecret, ...rest } = game
  const tz = game.timezone
  return {
    ...rest,
    tzOffsetMin: T.offsetMin(game.startAt, tz),
    local: {
      start: T.fmtLocal(game.startAt, tz),
      end: T.fmtLocal(game.endAt, tz).slice(-5),
      cutoff: T.fmtLocal(game.cutoffAt, tz),
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
  const clubIds = members.map((m) => m.clubId)
  const clubs = await listAll(db.collection('clubs').where({ _id: _.in(clubIds) }))
  const clubNames = Object.fromEntries(clubs.map((c) => [c._id, c.name]))
  const now = Date.now()
  const query = history
    ? db
        .collection('games')
        .where({ clubId: _.in(clubIds), endAt: _.lt(now) })
        .orderBy('startAt', 'desc')
    : db
        .collection('games')
        .where({ clubId: _.in(clubIds), endAt: _.gte(now - 6 * 60 * MIN) })
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

async function getGame({ openid, gameId }) {
  let game = await mustGet('games', gameId, '比赛')
  if (await maybeSettle(game)) game = await mustGet('games', gameId, '比赛')
  const club = await mustGet('clubs', game.clubId, '球队')
  const member = await getMember(game.clubId, openid)
  const isAdmin = !!member && isAdminRole(member.role)

  const regs = await listAll(db.collection('registrations').where({ gameId }))
  const profiles = await profilesFor(
    game.clubId,
    regs.flatMap((r) => [r.openid, r.inviter]),
  )
  const now = Date.now()
  const view = (r) => {
    const p = profiles[r.openid] || { name: '未命名', avatar: '' }
    return {
      openid: r.openid,
      name: p.name,
      avatar: p.avatar,
      isNew: !!p.joinedAt && now - p.joinedAt < NEW_MEMBER_MS,
      inviterName: r.inviter ? (profiles[r.inviter] || {}).name || '' : '',
      status: r.status,
      signedAt: r.signedAt,
      spotAt: r.spotAt || 0,
      waitlistAt: r.waitlistAt || 0,
      cancelledAt: r.cancelledAt || 0,
      cancelPhase: r.cancelPhase || '',
      checkinAt: r.checkinAt || 0,
      checkinMethod: r.checkinMethod || '',
      attendance: r.attendance || '',
      subscribedChange: !!r.subscribedChange,
    }
  }
  const pick = (status, key) =>
    regs
      .filter((r) => r.status === status)
      .map(view)
      .sort((a, b) => a[key] - b[key])
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

  return {
    fines,
    teams: teams.teamsView(game, regs, profiles, openid),
    serverNow: now,
    game: publicGame(game),
    club: { _id: club._id, name: club.name, venmo: club.venmo },
    registered: pick('registered', 'spotAt'),
    waitlist: pick('waitlist', 'waitlistAt'),
    cancelled: pick('cancelled', 'cancelledAt'),
    me: {
      openid,
      isMember: !!member,
      isAdmin,
      reg: mine ? view(mine) : null,
      unpaidCents: member ? await unpaidCents(game.clubId, openid) : 0,
      checkinOpensAt: rules.checkinOpensAt(game),
      openReminder: game.signupOpensAt > now ? await remind.hasOpenReminder(gameId, openid) : false,
    },
  }
}

async function signup({ openid, gameId, inviter, subscribed, subscribedChange, envVersion }) {
  const game = await mustGet('games', gameId, '比赛')
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

  const owed = await unpaidCents(game.clubId, openid)
  if (owed > 0) {
    const club = await getDoc('clubs', game.clubId)
    const venmo = club && club.venmo ? `Venmo ${club.venmo} 或` : ''
    throw new UserError(`你有未付罚款 $${(owed / 100).toFixed(2)}，请${venmo}现金支付给管理员，确认后即可报名`)
  }

  const existing = await getDoc('registrations', regId(gameId, openid))
  if (existing && (existing.status === 'registered' || existing.status === 'waitlist')) {
    throw new UserError('你已经报名了')
  }
  const validInviter =
    inviter && inviter !== openid && (await getMember(game.clubId, inviter)) ? inviter : ''

  const got = await db
    .collection('games')
    .where({ _id: gameId, registeredCount: _.lt(game.capacity) })
    .update({ data: { registeredCount: _.inc(1) } })
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
        subscribed: status === 'waitlist' && !!subscribed,
        subscribedChange: !!subscribedChange,
        mpState: mpState(envVersion),
      },
    })
  return { status }
}

async function cancelSignup({ openid, gameId }) {
  const game = await mustGet('games', gameId, '比赛')
  const reg = await getDoc('registrations', regId(gameId, openid))
  if (!reg || (reg.status !== 'registered' && reg.status !== 'waitlist')) throw new UserError('你没有报名')
  const now = Date.now()
  if (game.status === 'active' && now >= game.cutoffAt) throw new UserError('已过签到截止时间，不能再取消')
  if (reg.status === 'registered' && reg.checkinAt) throw new UserError('你已经签到了，不能取消报名')

  if (reg.status === 'waitlist') {
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { status: 'cancelled', cancelledAt: now, cancelPhase: 'free' } })
    return { phase: 'free', fined: false }
  }

  const phase = game.status === 'active' ? rules.cancelPhase(game, now) : 'free'
  await db
    .collection('registrations')
    .doc(reg._id)
    .update({ data: { status: 'cancelled', cancelledAt: now, cancelPhase: phase } })
  await db.collection('games').doc(gameId).update({ data: { registeredCount: _.inc(-1) } })

  let fined = false
  if (phase === 'penalty' && game.fineCents > 0 && !rules.isLatePromotion(reg, game)) {
    await createFine({
      clubId: game.clubId,
      gameId,
      openid,
      kind: 'cancel',
      reason: 'late_cancel',
      amountCents: game.fineCents,
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

// 改时间或缺席截止后，重新判断已取消的人：按新时间不该罚的，撤掉罚款（不会新增罚款）
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
      await autoWaive({ _id: `${game._id}_${reg.openid}_cancel` }, '比赛改时间，按新时间不算临时取消')
    }
    if (phase === 'free') {
      await autoWaive({ _id: `${game._id}_${reg.openid}_noforward` }, '比赛改时间，按新时间取消时无需转发')
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
      throw new UserError(`你距离球场约 ${d} 米，需在 ${game.venue.radiusM} 米内才能签到`)
    }
    Object.assign(data, {
      checkinMethod: 'gps',
      checkinDistanceM: d,
      checkinAccuracyM: Math.round(Number(accuracy) || 0),
    })
  }

  const attendance = rules.attendanceFor(now, game)
  if (game.settledAt) {
    // 已经判过“未到”的人后来到了：改成迟到
    data.attendance = attendance
    const fine = await getDoc('fines', `${gameId}_${openid}_attendance`)
    if (fine && fine.status === 'pending' && fine.reason === 'no_show') {
      await db.collection('fines').doc(fine._id).update({ data: { reason: 'late' } })
    }
  }
  await db.collection('registrations').doc(reg._id).update({ data })
  if (!game.settledAt) await teams.afterCheckin(gameId, openid)
  return { attendance, distanceM: data.checkinDistanceM }
}

async function getCheckinCode({ openid, gameId }) {
  const game = await mustGet('games', gameId, '比赛')
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
  await requireAdmin(game.clubId, openid)
  if (!['on_time', 'late', 'no_show'].includes(attendance)) throw new UserError('出勤状态无效')
  const reg = await getDoc('registrations', regId(gameId, target))
  if (!reg || reg.status !== 'registered') throw new UserError('该成员不在报名名单里')

  if (!game.settledAt) {
    if (attendance !== 'on_time') throw new UserError('截止时间前只能代签到')
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { checkinAt: Math.min(Date.now(), game.startAt), checkinMethod: 'admin' } })
    await teams.afterCheckin(gameId, target)
    return {}
  }

  await db.collection('registrations').doc(reg._id).update({ data: { attendance, checkinMethod: 'admin' } })
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
    if (fine.status === 'waived') Object.assign(data, { status: 'pending', note: '', resolvedBy: '', resolvedAt: 0 })
    await db.collection('fines').doc(fineId).update({ data })
  } else if (game.fineCents > 0) {
    await createFine({
      clubId: game.clubId,
      gameId,
      openid: target,
      kind: 'attendance',
      reason: attendance,
      amountCents: game.fineCents,
      createdBy: openid,
    })
  }
  return {}
}

// 缺席截止后取消、但没有转发到群里：管理员手动罚款（系统无法检测是否转发）
async function fineNoForward({ openid, gameId, target }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  const reg = await getDoc('registrations', regId(gameId, target))
  if (!reg || reg.status !== 'cancelled' || reg.cancelPhase !== 'warn') {
    throw new UserError('只能对缺席截止后才取消的人使用')
  }
  if (game.fineCents <= 0) throw new UserError('本场罚款金额为 0')
  const fine = await createFine({
    clubId: game.clubId,
    gameId,
    openid: target,
    kind: 'noforward',
    reason: 'no_forward',
    amountCents: game.fineCents,
    createdBy: openid,
  })
  return { fineId: fine._id }
}

module.exports = {
  buildGameFields,
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
