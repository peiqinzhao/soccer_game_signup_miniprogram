// 自动分队 + 守门员顺序。
// 规则（以 8v8v8 为例）：
//   - 签到满 (队数-1)×每队人数 = 16 人时，把这 16 人随机分成 A、B 两队；之后签到的人进人数最少的队（先填满 C）。
//   - 只有两队时，签满 2×每队人数 才随机分成两队。
//   - 管理员可随时“立即分队”：把已签到的人平均随机分到所有队。
//   - 管理员可“重新随机”：只重抽首批分队的人，后到的人不动。
//   - 守门员顺序：首批随机；后到的人排在本队最后。
const crypto = require('crypto')
const { db, _, UserError, getDoc, mustGet, listAll, regId, requireAdmin } = require('../lib/db')

const TEAM_NAMES = 'ABCDEF'.split('')

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 自动分队需要的签到人数，以及首批分几个队
function autoPlan(game) {
  const k = game.teamCount
  const firstTeams = k >= 3 ? k - 1 : k
  return { threshold: firstTeams * game.teamSize, firstTeams }
}

async function checkedIn(gameId) {
  const regs = await listAll(db.collection('registrations').where({ gameId, status: 'registered' }))
  return regs.filter((r) => r.checkinAt).sort((a, b) => a.checkinAt - b.checkinAt)
}

// 把 regs 依次发到 teamCount 个队（round-robin），返回每人的队和守门员号
function deal(regs, teamCount) {
  const counts = new Array(teamCount).fill(0)
  return regs.map((r, i) => {
    const t = i % teamCount
    counts[t]++
    return { reg: r, team: TEAM_NAMES[t], gk: counts[t] }
  })
}

async function saveAssignments(list, initial) {
  for (const { reg, team, gk } of list) {
    await db
      .collection('registrations')
      .doc(reg._id)
      .update({ data: { team, gk, teamInitial: initial } })
  }
}

// 后到的人：进人数最少的队（同样少时按 A、B、C 顺序），守门员排本队最后
async function assignLate(game, reg) {
  const members = (await checkedIn(game._id)).filter((r) => r.team && r._id !== reg._id)
  const names = TEAM_NAMES.slice(0, game.teamCount)
  const size = (t) => members.filter((r) => r.team === t).length
  // 首批之外的队（如 C）人最少，所以会先被填满
  const team = names.reduce((best, t) => (size(t) < size(best) ? t : best), names[0])
  const gk = Math.max(0, ...members.filter((r) => r.team === team).map((r) => r.gk || 0)) + 1
  await db.collection('registrations').doc(reg._id).update({ data: { team, gk, teamInitial: false } })
  return team
}

// 分队。manual=true 时把所有已签到的人平均分到全部队
async function formTeams(game, manual) {
  const regs = await checkedIn(game._id)
  const plan = autoPlan(game)
  const firstTeams = manual ? game.teamCount : plan.firstTeams
  const firstCount = manual ? regs.length : plan.threshold
  if (!regs.length) throw new UserError('还没有人签到')
  if (regs.length < firstCount) return false

  const claim = await db
    .collection('games')
    .where({ _id: game._id, teamsFormedAt: 0 })
    .update({ data: { teamsFormedAt: Date.now(), teamsFirstCount: firstTeams } })
  if (claim.stats.updated !== 1) return false

  await saveAssignments(deal(shuffle(regs.slice(0, firstCount)), firstTeams), true)
  const formed = { ...game, teamsFormedAt: Date.now(), teamsFirstCount: firstTeams }
  for (const reg of regs.slice(firstCount)) await assignLate(formed, reg)
  return true
}

// 签到（含管理员代签到）之后调用
async function afterCheckin(gameId, openid) {
  const game = await getDoc('games', gameId)
  if (!game || !game.autoTeams || game.status !== 'active') return
  if (!game.teamsFormedAt) {
    await formTeams(game, false)
    return
  }
  const reg = await getDoc('registrations', regId(gameId, openid))
  if (reg && reg.status === 'registered' && reg.checkinAt && !reg.team) await assignLate(game, reg)
}

async function formTeamsNow({ openid, gameId }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  if (!game.autoTeams) throw new UserError('本场没有开启自动分队')
  if (game.teamsFormedAt) throw new UserError('已经分过队了，可以点“重新随机”')
  if (!(await formTeams(game, true))) throw new UserError('分队失败，请刷新后重试')
  return {}
}

async function reshuffleTeams({ openid, gameId }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  if (!game.teamsFormedAt) throw new UserError('还没有分队')
  const regs = (await checkedIn(gameId)).filter((r) => r.team)
  const first = regs.filter((r) => r.teamInitial)
  const late = regs.filter((r) => !r.teamInitial)
  const dealt = deal(shuffle(first), game.teamsFirstCount || game.teamCount)
  // 后到的人留在原队，守门员号接在首批之后
  const firstSize = (t) => dealt.filter((x) => x.team === t).length
  const lateList = late
    .sort((a, b) => a.gk - b.gk)
    .map((r) => ({ reg: r, team: r.team }))
  const seen = {}
  for (const x of lateList) {
    seen[x.team] = (seen[x.team] || 0) + 1
    x.gk = firstSize(x.team) + seen[x.team]
  }
  await saveAssignments(dealt, true)
  await saveAssignments(lateList, false)
  return {}
}

// 只重排某一队（或全部队）的守门员顺序，不改变分队；后到的人也一起参与重排
async function reshuffleGoalkeepers({ openid, gameId, team }) {
  const game = await mustGet('games', gameId, '比赛')
  await requireAdmin(game.clubId, openid)
  if (!game.teamsFormedAt) throw new UserError('还没有分队')
  if (!game.goalkeeper) throw new UserError('本场没有开启守门员轮换')
  const names = TEAM_NAMES.slice(0, game.teamCount)
  if (team && !names.includes(team)) throw new UserError('队伍不存在')
  const regs = (await checkedIn(gameId)).filter((r) => r.team && (!team || r.team === team))
  for (const t of team ? [team] : names) {
    const order = shuffle(regs.filter((r) => r.team === t))
    for (let i = 0; i < order.length; i++) {
      await db.collection('registrations').doc(order[i]._id).update({ data: { gk: i + 1 } })
    }
  }
  return {}
}

// 给 getGame 用的分队视图
function teamsView(game, regs, profiles, openid) {
  if (!game.autoTeams) return null
  const plan = autoPlan(game)
  const checkedCount = regs.filter((r) => r.status === 'registered' && r.checkinAt).length
  const names = TEAM_NAMES.slice(0, game.teamCount)
  const teams = names.map((name) => ({
    name,
    members: regs
      .filter((r) => r.status === 'registered' && r.team === name)
      .sort((a, b) => a.gk - b.gk)
      .map((r) => ({
        openid: r.openid,
        name: (profiles[r.openid] || {}).name || '未命名',
        avatar: (profiles[r.openid] || {}).avatar || '',
        gk: r.gk,
        late: !r.teamInitial,
      })),
  }))
  const mine = regs.find((r) => r.openid === openid && r.status === 'registered' && r.team)
  return {
    formed: !!game.teamsFormedAt,
    threshold: plan.threshold,
    checkedIn: checkedCount,
    goalkeeper: !!game.goalkeeper,
    teams,
    myTeam: mine ? mine.team : '',
    myGk: mine ? mine.gk : 0,
  }
}

module.exports = { TEAM_NAMES, autoPlan, afterCheckin, formTeamsNow, reshuffleTeams, reshuffleGoalkeepers, teamsView }
