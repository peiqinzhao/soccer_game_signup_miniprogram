// 唯一的云函数入口：客户端 wx.cloud.callFunction({ name: 'api', data: { action, ...params } })
// 定时触发器（config.json 里的 settle）也走这里。
const { cloud, UserError } = require('./lib/db')
const user = require('./handlers/user')
const club = require('./handlers/club')
const game = require('./handlers/game')
const fine = require('./handlers/fine')
const ledger = require('./handlers/ledger')
const { settleDue } = require('./handlers/settle')
const teams = require('./handlers/teams')
const remind = require('./handlers/remind')

const ACTIONS = {
  login: user.login,
  updateProfile: user.updateProfile,

  createClub: club.createClub,
  getClub: club.getClub,
  updateClub: club.updateClub,
  setRole: club.setRole,
  renameMember: club.renameMember,
  saveVenue: club.saveVenue,
  deleteVenue: club.deleteVenue,
  saveTemplate: club.saveTemplate,
  deleteTemplate: club.deleteTemplate,

  listGames: game.listGames,
  getGame: game.getGame,
  gameForm: game.gameForm,
  saveGame: game.saveGame,
  cancelGame: game.cancelGame,
  signup: game.signup,
  cancelSignup: game.cancelSignup,
  checkin: game.checkin,
  getCheckinCode: game.getCheckinCode,
  setAttendance: game.setAttendance,
  fineNoForward: game.fineNoForward,
  subscribeChange: game.subscribeChange,
  formTeamsNow: teams.formTeamsNow,
  reshuffleTeams: teams.reshuffleTeams,
  reshuffleGoalkeepers: teams.reshuffleGoalkeepers,
  setOpenReminder: remind.setOpenReminder,

  listFines: fine.listFines,
  myPendingFines: fine.myPendingFines,
  resolveFines: fine.resolveFines,
  addFine: fine.addFine,

  getLedger: ledger.getLedger,
  addLedgerEntry: ledger.addLedgerEntry,
  voidLedgerEntry: ledger.voidLedgerEntry,
}

exports.main = async (event) => {
  // 定时器每 5 分钟一次：结算 + 报名开放提醒
  if (event.Type === 'Timer') return { ...(await settleDue()), ...(await remind.remindDue()) }

  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, error: '未登录' }
  const { action, userInfo, ...params } = event
  const fn = ACTIONS[action]
  if (!fn) return { ok: false, error: `未知操作 ${action}` }
  try {
    // openid 放最后，客户端无法伪造
    return { ok: true, data: await fn({ ...params, openid: OPENID }) }
  } catch (e) {
    if (e instanceof UserError) return { ok: false, error: e.message }
    console.error(action, e)
    return { ok: false, error: '服务器出错了，请稍后再试' }
  }
}
