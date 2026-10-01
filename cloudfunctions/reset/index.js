// 一次性清理测试数据：清空比赛、报名、罚款、基金流水、开放提醒。账号、球队、成员、场地、模板都保留。
// 只能在开发者工具里「云端测试」运行，小程序客户端调用会被拒绝。
// 测试参数：{ "confirm": "DELETE" }
// 用完请在云开发控制台删除云端的 reset 函数；本地代码可以留着，不部署就不会生效。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COLLECTIONS = ['games', 'registrations', 'fines', 'ledger', 'reminders']

async function removeAll(name) {
  let removed = 0
  for (;;) {
    const res = await db.collection(name).where({ _id: _.exists(true) }).remove()
    removed += res.stats.removed
    if (!res.stats.removed) return removed
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID) return { ok: false, error: '只能在开发者工具的云端测试里运行' }
  if (event.confirm !== 'DELETE') return { ok: false, error: '请传入 { "confirm": "DELETE" }' }
  const removed = {}
  for (const name of COLLECTIONS) removed[name] = await removeAll(name)
  return { ok: true, removed }
}
