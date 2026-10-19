// “我的”页统计与数据榜：按球队统计出勤、罚款、总场次、总进球、总助攻
const { db, _, listAll, profilesFor } = require('../lib/db')
const { FINE_REASONS } = require('../lib/rules')

async function myStats({ openid }) {
  const members = await listAll(db.collection('members').where({ openid }))
  if (!members.length) return { clubs: [] }
  const clubs = (await listAll(db.collection('clubs').where({ _id: _.in(members.map((m) => m.clubId)) }))).filter(
    (c) => !c.archived,
  )
  if (!clubs.length) return { clubs: [] }
  const clubIds = clubs.map((c) => c._id)

  const [regs, fines] = await Promise.all([
    listAll(db.collection('registrations').where({ openid, clubId: _.in(clubIds) })),
    listAll(db.collection('fines').where({ openid, clubId: _.in(clubIds) })),
  ])
  const gameIds = [...new Set(regs.map((r) => r.gameId))]
  const games = gameIds.length ? await listAll(db.collection('games').where({ _id: _.in(gameIds) })) : []
  const gameById = Object.fromEntries(games.map((g) => [g._id, g]))
  const now = Date.now()

  return {
    clubs: clubs.map((c) => {
      // 只算正常进行的比赛（取消、删除的比赛不算）
      const mine = regs.filter((r) => {
        const g = gameById[r.gameId]
        return r.clubId === c._id && g && g.status === 'active' && !g.archived
      })
      const played = mine.filter((r) => r.status === 'registered' && gameById[r.gameId].endAt < now)
      const activeRegs = mine.filter((r) => r.status === 'registered')
      const goals = activeRegs.reduce((s, r) => s + (r.goals || 0), 0)
      const assists = activeRegs.reduce((s, r) => s + (r.assists || 0), 0)
      const count = (att) => played.filter((r) => r.attendance === att).length
      const myFines = fines.filter((f) => f.clubId === c._id && f.status !== 'waived')
      const byReason = {}
      for (const f of myFines) {
        const label = f.detail || FINE_REASONS[f.reason] || f.reason
        byReason[label] = (byReason[label] || 0) + 1
      }
      const sum = (list) => list.reduce((s, f) => s + f.amountCents, 0)
      return {
        clubId: c._id,
        clubName: c.name,
        finesEnabled: !c.settings || c.settings.finesEnabled !== false,
        goals,
        assists,
        attendance: {
          played: played.length,
          onTime: count('on_time'),
          late: count('late'),
          noShow: count('no_show'),
          cancelled: mine.filter((r) => r.status === 'cancelled').length,
          upcoming: mine.filter((r) => r.status === 'registered' && gameById[r.gameId].endAt >= now).length,
        },
        fines: {
          byReason: Object.entries(byReason).map(([reason, n]) => ({ reason, n })),
          totalCents: sum(myFines),
          paidCents: sum(myFines.filter((f) => f.status === 'paid')),
          pendingCents: sum(myFines.filter((f) => f.status === 'pending')),
        },
      }
    }),
  }
}

async function leaderboard({ openid, clubId }) {
  const myMembers = await listAll(db.collection('members').where({ openid }))
  if (!myMembers.length) return { clubs: [], clubId: '', clubName: '', rows: [] }
  const clubs = (await listAll(db.collection('clubs').where({ _id: _.in(myMembers.map((m) => m.clubId)) }))).filter(
    (c) => !c.archived,
  )
  if (!clubs.length) return { clubs: [], clubId: '', clubName: '', rows: [] }
  const targetClub = clubs.find((c) => c._id === clubId) || clubs[0]
  const cid = targetClub._id

  const [clubMembers, games, regs] = await Promise.all([
    listAll(db.collection('members').where({ clubId: cid })),
    listAll(db.collection('games').where({ clubId: cid, status: 'active' })),
    listAll(db.collection('registrations').where({ clubId: cid, status: 'registered' })),
  ])
  const activeGames = Object.fromEntries(games.filter((g) => !g.archived).map((g) => [g._id, g]))
  const allOpenids = [...new Set([...clubMembers.map((m) => m.openid), ...regs.map((r) => r.openid)])]
  const profiles = await profilesFor(cid, allOpenids)
  const now = Date.now()

  const byPlayer = {}
  for (const m of clubMembers) {
    const p = profiles[m.openid] || { name: m.name || '未命名', avatar: '' }
    byPlayer[m.openid] = {
      openid: m.openid,
      name: p.name,
      avatar: p.avatar,
      games: 0,
      goals: 0,
      assists: 0,
    }
  }

  for (const r of regs) {
    const g = activeGames[r.gameId]
    if (!g) continue
    if (!byPlayer[r.openid]) {
      const p = profiles[r.openid] || { name: '未命名', avatar: '' }
      byPlayer[r.openid] = {
        openid: r.openid,
        name: p.name,
        avatar: p.avatar,
        games: 0,
        goals: 0,
        assists: 0,
      }
    }
    const attended =
      !!r.checkinAt ||
      r.attendance === 'on_time' ||
      r.attendance === 'late' ||
      (g.checkinEnabled === false && g.endAt <= now) ||
      (r.goals || 0) > 0 ||
      (r.assists || 0) > 0
    if (attended) {
      byPlayer[r.openid].games += 1
    }
    byPlayer[r.openid].goals += r.goals || 0
    byPlayer[r.openid].assists += r.assists || 0
  }

  const rows = Object.values(byPlayer).sort(
    (a, b) => b.goals - a.goals || b.assists - a.assists || b.games - a.games || a.name.localeCompare(b.name),
  )

  return {
    clubs: clubs.map((c) => ({ clubId: c._id, clubName: c.name })),
    clubId: cid,
    clubName: targetClub.name,
    rows,
  }
}

module.exports = { myStats, leaderboard }
